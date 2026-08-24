/**
 * Liveness from Cursor's OWN record of each conversation.
 *
 * Every other signal the extension has answers "is there any sign of life?",
 * and treats silence as death. They all fail in the same situation — an agent
 * quietly doing real work:
 *
 *   • MCP heartbeat  — only refreshed while parked in check_messages, or after
 *                      send_progress. An agent that takes a message and just
 *                      works refreshes nothing and goes stale in 6s.
 *   • CDP tile DOM   — nothing to read unless the Agents window is rendered.
 *   • .jsonl transcript — not flushed until the turn ENDS, so mid-turn it
 *                      describes the previous turn.
 *
 * Cursor's global `state.vscdb` has none of those problems, because it isn't an
 * inference: Cursor maintains `composerData:<agentId>` for its own purposes,
 * whatever window is open, while the turn is still running.
 *
 * Measured on this machine across 20 agents (2026-07-30):
 *
 *   checkpoint age, ALIVE agents:  29s  33s  45s  55s  60s  120s  131s
 *   checkpoint age, DEAD agents:  4191s … 9529s
 *
 * A ~30x gap with nothing in between. The decisive case was an agent that was
 * demonstrably alive while its MCP heartbeat read 177s stale (i.e. "dropped")
 * and its checkpoint read 60s.
 *
 * Two signals are used:
 *   1. PROGRESS — `fullConversationHeadersOnly` grew since the last look. This
 *      is positive proof of work, which nothing else here provides.
 *   2. FRESHNESS — `conversationCheckpointLastUpdatedAt` is recent.
 *
 * Deliberately NOT used: `status` reads "aborted" for almost every agent
 * including live ones, and `generatingBubbleIds` is only non-empty while text
 * is actively streaming — it misses the whole time spent inside a tool call.
 *
 * This is private Cursor storage, so everything here is best-effort: if the DB,
 * the table, or the fields are missing, every function returns undefined and
 * the caller falls back to the old signals. It must never throw.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/** What we could learn about one agent from Cursor's store. */
export interface ComposerLiveness {
  /** Length of `fullConversationHeadersOnly` — monotonic per conversation. */
  headerCount: number;
  /** Epoch ms of Cursor's last checkpoint for this conversation. */
  checkpointMs: number;
  /** True when headerCount grew since the previous read — proof of work. */
  advanced: boolean;
  /** Epoch ms we last saw it advance (0 if never seen advancing). */
  lastAdvancedAt: number;
  /** Context window usage, handy for the UI. */
  contextTokensUsed?: number;
  contextTokenLimit?: number;
  /** Conversation title Cursor shows in its sidebar. */
  name?: string;
}

/** Re-reading a 12 GB DB on every 500ms poll would be silly; liveness
 *  thresholds are minutes, so a couple of seconds of staleness is free. */
const QUERY_THROTTLE_MS = 2_500;

/**
 * `node:sqlite` is only present from Node 22.5, and Cursor's extension host
 * runs Electron's Node — which version that is depends on the build. Resolve it
 * lazily and remember failure, so an older host silently keeps the old
 * behaviour instead of erroring on every poll.
 */
let sqliteModule: { DatabaseSync: new (p: string, o?: object) => unknown } | undefined;
let sqliteChecked = false;
let sqliteAvailable = false;

function loadSqlite(): boolean {
  if (sqliteChecked) return sqliteAvailable;
  sqliteChecked = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    sqliteModule = require("node:sqlite");
    sqliteAvailable = !!sqliteModule && typeof sqliteModule.DatabaseSync === "function";
  } catch {
    sqliteAvailable = false;
  }
  return sqliteAvailable;
}

/** True when this host can read Cursor's store at all. For the debug log. */
export function isComposerStateAvailable(): boolean {
  return loadSqlite() && !!globalStateDbPath();
}

let cachedDbPath: string | null | undefined;

function globalStateDbPath(): string | null {
  if (cachedDbPath !== undefined) return cachedDbPath;
  // Windows: %APPDATA%/Cursor. macOS: ~/Library/Application Support/Cursor.
  // Linux: ~/.config/Cursor.
  const home = os.homedir();
  const candidates = [
    path.join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
    path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    path.join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
  cachedDbPath = candidates.find((p) => fs.existsSync(p)) ?? null;
  return cachedDbPath;
}

interface StmtLike {
  get(key: string): { value?: unknown } | undefined;
}
interface DbLike {
  prepare(sql: string): StmtLike;
  close(): void;
}

let db: DbLike | undefined;
let dbFailed = false;

function openDb(): DbLike | undefined {
  if (db) return db;
  if (dbFailed || !loadSqlite()) return undefined;
  const p = globalStateDbPath();
  if (!p) {
    dbFailed = true;
    return undefined;
  }
  try {
    const Ctor = sqliteModule!.DatabaseSync;
    // Read-only, and never scanned — every lookup is a keyed index hit.
    db = new Ctor(p, { readOnly: true }) as unknown as DbLike;
    return db;
  } catch {
    dbFailed = true;
    return undefined;
  }
}

/** Drop the handle so the next call reopens (Cursor may have rotated the file). */
function resetDb(): void {
  try {
    db?.close();
  } catch {
    /* already gone */
  }
  db = undefined;
}

interface CacheEntry {
  readAt: number;
  live: ComposerLiveness;
}

const cache = new Map<string, CacheEntry>();

/**
 * Read Cursor's own record for one agent. Returns undefined when the store
 * isn't readable or has no entry — callers must treat that as "no information",
 * NOT as evidence the agent is dead.
 */
export function getComposerLiveness(agentId: string): ComposerLiveness | undefined {
  if (!agentId || agentId.startsWith("tile:")) return undefined;

  const now = Date.now();
  const prev = cache.get(agentId);
  if (prev && now - prev.readAt < QUERY_THROTTLE_MS) return prev.live;

  const handle = openDb();
  if (!handle) return prev?.live;

  let row: { value?: unknown } | undefined;
  try {
    row = handle
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`composerData:${agentId}`);
  } catch {
    // Schema drift, a locked/rotated file, or an I/O error. Reopen next time
    // rather than poisoning the feature permanently.
    resetDb();
    return prev?.live;
  }
  if (!row || row.value == null) return prev?.live;

  let parsed: Record<string, unknown>;
  try {
    const text =
      typeof row.value === "string"
        ? row.value
        : Buffer.from(row.value as Uint8Array).toString("utf8");
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return prev?.live;
  }

  const headers = parsed.fullConversationHeadersOnly;
  const headerCount = Array.isArray(headers) ? headers.length : 0;
  const checkpointMs =
    numberOf(parsed.conversationCheckpointLastUpdatedAt) ||
    numberOf(parsed.lastUpdatedAt) ||
    0;

  const grew = !!prev && headerCount > prev.live.headerCount;
  const live: ComposerLiveness = {
    headerCount,
    checkpointMs,
    advanced: grew,
    lastAdvancedAt: grew ? now : prev?.live.lastAdvancedAt ?? 0,
    contextTokensUsed: numberOf(parsed.contextTokensUsed) || undefined,
    contextTokenLimit: numberOf(parsed.contextTokenLimit) || undefined,
    name: typeof parsed.name === "string" ? parsed.name : undefined,
  };
  cache.set(agentId, { readAt: now, live });
  return live;
}

function numberOf(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ── What the agent is doing, from Cursor's bubble rows ──────────────────────

/**
 * Each message / tool call is a row `bubbleId:<agentId>:<bubbleId>`, indexed in
 * order by `composerData.fullConversationHeadersOnly`. A tool bubble carries
 * `toolFormerData` = { name, status, rawArgs, result }, and Cursor writes it
 * with `status: "loading"` **while the tool is still running** — so this is a
 * genuine in-turn view of what an agent is doing.
 *
 * Caveat, measured: the row appears roughly **30 seconds** after the tool
 * actually starts. That's fine as a fallback, but the tile DOM is instant, so
 * callers should prefer the DOM whenever the Agents window is rendered.
 */
export interface ComposerStep {
  bubbleId: string;
  label: string;
  tool: string;
  /** Cursor's own status: "loading" while running, then "completed" / "error". */
  status: string;
  /** Epoch ms we first saw this bubble. */
  firstSeen: number;
}

export interface ComposerActivity {
  steps: ComposerStep[];
  /** True when the newest tool bubble is still running. */
  running: boolean;
}

/** How many trailing bubbles to surface. */
const FEED_BUBBLES = 12;

function baseName(p: string): string {
  const s = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function firstString(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/** Turn a Cursor tool name + its raw args into the phrasing the panel shows.
 *  Names and arg keys were taken from real bubbles rather than guessed. */
function labelForTool(name: string, args: Record<string, unknown>): string {
  const path = firstString(args, ["path", "relativeWorkspacePath", "targetFile"]);
  switch (name) {
    case "read_file_v2":
      return path ? `Reading ${baseName(path)}` : "Reading a file";
    case "edit_file_v2":
      return path ? `Editing ${baseName(path)}` : "Editing a file";
    case "delete_file":
      return path ? `Deleting ${baseName(path)}` : "Deleting a file";
    case "run_terminal_command_v2": {
      const cmd = firstString(args, ["command"]).replace(/\s+/g, " ");
      return cmd ? `Shell: ${cmd.slice(0, 90)}` : "Running a command";
    }
    case "ripgrep_raw_search": {
      const pat = firstString(args, ["pattern"]);
      return pat ? `Searching: ${pat.slice(0, 60)}` : "Searching code";
    }
    case "glob_file_search": {
      const g = firstString(args, ["globPattern"]);
      return g ? `Finding: ${g.slice(0, 60)}` : "Finding files";
    }
    case "web_search": {
      const q = firstString(args, ["searchTerm"]);
      return q ? `Web search: ${q.slice(0, 60)}` : "Web search";
    }
    case "web_fetch": {
      const u = firstString(args, ["url"]);
      try {
        return u ? `Fetching ${new URL(u).hostname}` : "Fetching a page";
      } catch {
        return "Fetching a page";
      }
    }
    case "get_mcp_tools":
      return "Checking MCP tools";
    case "todo_write":
      return "Updating todos";
    case "await":
      return "Waiting on a task";
    case "mcp-jefr-check_messages":
      return "Listening (MCP)";
    case "mcp-jefr-send_progress":
      return "Sending progress";
    case "mcp-jefr-ask_question":
      return "Asking a question";
    default: {
      const mcp = /^mcp-([^-]+)-(.+)$/.exec(name);
      if (mcp) return `MCP: ${mcp[2]}`;
      return name.replace(/_v\d+$/, "").replace(/_/g, " ") || "Working";
    }
  }
}

interface BubbleCacheEntry {
  label: string;
  tool: string;
  status: string;
  firstSeen: number;
}

/** bubbleId → parsed step. Completed bubbles never change, so once a bubble is
 *  terminal we stop re-querying it; only new and still-`loading` rows are read.
 *  That keeps a poll to one or two indexed lookups per agent. */
const bubbleCache = new Map<string, Map<string, BubbleCacheEntry>>();

function bubblesFor(agentId: string): Map<string, BubbleCacheEntry> {
  let m = bubbleCache.get(agentId);
  if (!m) {
    m = new Map();
    bubbleCache.set(agentId, m);
  }
  return m;
}

const TERMINAL = /^(completed|error|cancelled|canceled|aborted|rejected)$/i;

interface ActivityCacheEntry {
  readAt: number;
  activity: ComposerActivity;
}
const activityCache = new Map<string, ActivityCacheEntry>();

/**
 * Recent actions for one agent, newest last. Returns undefined when Cursor's
 * store isn't readable — which means "no information", never "idle".
 */
export function getComposerActivity(agentId: string): ComposerActivity | undefined {
  if (!agentId || agentId.startsWith("tile:")) return undefined;

  const now = Date.now();
  const cached = activityCache.get(agentId);
  if (cached && now - cached.readAt < QUERY_THROTTLE_MS) return cached.activity;

  const handle = openDb();
  if (!handle) return cached?.activity;

  let headers: Array<{ bubbleId?: string }> = [];
  try {
    const row = handle
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`composerData:${agentId}`);
    if (!row || row.value == null) return cached?.activity;
    const text =
      typeof row.value === "string"
        ? row.value
        : Buffer.from(row.value as Uint8Array).toString("utf8");
    const parsed = JSON.parse(text) as { fullConversationHeadersOnly?: unknown };
    if (!Array.isArray(parsed.fullConversationHeadersOnly)) return cached?.activity;
    headers = parsed.fullConversationHeadersOnly as Array<{ bubbleId?: string }>;
  } catch {
    resetDb();
    return cached?.activity;
  }

  const known = bubblesFor(agentId);
  const recent = headers.slice(-FEED_BUBBLES);
  const steps: ComposerStep[] = [];

  for (const h of recent) {
    const bid = h?.bubbleId;
    if (!bid) continue;
    let entry = known.get(bid);
    // Re-read only what can still change: unseen bubbles, and ones we last saw
    // mid-flight.
    if (!entry || !TERMINAL.test(entry.status)) {
      const parsedBubble = readBubble(handle, agentId, bid);
      if (parsedBubble) {
        entry = {
          ...parsedBubble,
          firstSeen: entry?.firstSeen ?? now,
        };
        known.set(bid, entry);
      }
    }
    if (entry && entry.label) steps.push({ bubbleId: bid, ...entry });
  }

  // Keep the cache from growing without bound on a long conversation.
  if (known.size > FEED_BUBBLES * 8) {
    const keep = new Set(recent.map((h) => h?.bubbleId));
    for (const k of known.keys()) if (!keep.has(k)) known.delete(k);
  }

  const newest = steps[steps.length - 1];
  const activity: ComposerActivity = {
    steps,
    running: !!newest && !TERMINAL.test(newest.status),
  };
  activityCache.set(agentId, { readAt: now, activity });
  return activity;
}

function readBubble(
  handle: DbLike,
  agentId: string,
  bubbleId: string,
): { label: string; tool: string; status: string } | undefined {
  let raw: unknown;
  try {
    const row = handle
      .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
      .get(`bubbleId:${agentId}:${bubbleId}`);
    if (!row || row.value == null) return undefined;
    raw = row.value;
  } catch {
    resetDb();
    return undefined;
  }
  try {
    const text =
      typeof raw === "string" ? raw : Buffer.from(raw as Uint8Array).toString("utf8");
    const b = JSON.parse(text) as {
      toolFormerData?: { name?: string; status?: string; rawArgs?: unknown; params?: unknown };
      text?: string;
    };
    const tf = b.toolFormerData;
    if (!tf || typeof tf.name !== "string") {
      // A plain assistant/user message. Keep short text as context; skip noise.
      const t = typeof b.text === "string" ? b.text.replace(/\s+/g, " ").trim() : "";
      return t ? { label: t.slice(0, 140), tool: "", status: "completed" } : undefined;
    }
    let args: Record<string, unknown> = {};
    const rawArgs = tf.rawArgs ?? tf.params;
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        /* leave empty — the label falls back to the tool name */
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      args = rawArgs as Record<string, unknown>;
    }
    return {
      label: labelForTool(tf.name, args),
      tool: tf.name,
      status: typeof tf.status === "string" ? tf.status : "completed",
    };
  } catch {
    return undefined;
  }
}

/**
 * Epoch ms of the most recent proof this agent was doing something, or 0 when
 * the store told us nothing.
 *
 * Prefers an observed *advance* (we watched the conversation grow) over the
 * checkpoint timestamp, because an advance is something we witnessed while
 * running, whereas a checkpoint could have been written before we started.
 */
export function composerAliveAt(agentId: string): number {
  const live = getComposerLiveness(agentId);
  if (!live) return 0;
  return Math.max(live.lastAdvancedAt, live.checkpointMs);
}

/** Forget cached state (tests, or when the workspace changes). */
export function clearComposerCache(): void {
  cache.clear();
  bubbleCache.clear();
  activityCache.clear();
  resetDb();
  dbFailed = false;
}
