/**
 * Cursor agent transcript reader — ground truth for "is this agent turn dead?"
 *
 * Compared across live vs dead tiles:
 *   • Live agents (fresh MCP heartbeat): the jsonl's *last* record is never
 *     `turn_ended` (or the file has no turn_ended yet).
 *   • Dead agents: the last record IS `{"type":"turn_ended","status":...}` —
 *     whether `error` (policy block, auth, abort) or `success` (clean finish).
 *
 * Heartbeat alone can lie for minutes (`working` inertia after send_progress).
 * The transcript freeze is the reliable verdict: once `turn_ended` is the final
 * line, the turn is over until a newer user/assistant record is appended.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type TranscriptEndStatus = "success" | "error" | "other";

export interface TranscriptTurnEnd {
  /** True when the last jsonl record is `type: turn_ended`. */
  ended: boolean;
  /** Only set when ended. */
  status?: TranscriptEndStatus;
  /** Raw status string from the record (e.g. "error", "success"). */
  rawStatus?: string;
  /** Error message when status is error. */
  error?: string;
  /** Absolute path of the transcript file, if found. */
  path?: string;
  /** File mtime (ms) when we read it. */
  mtimeMs?: number;
}

/** Optional workspace roots — set by the extension host so we prefer the
 *  current project's transcript folder over scanning every Cursor project. */
let preferredRoots: string[] = [];

export function setTranscriptWorkspaceRoots(roots: string[]): void {
  preferredRoots = roots.filter(Boolean);
}

/** Cursor project-slug from a workspace filesystem path.
 *  `C:\Users\jar71\bin\apps\jefr-cursor` → `c-Users-jar71-bin-apps-jefr-cursor` */
export function workspacePathToProjectSlug(fsPath: string): string {
  let s = fsPath.replace(/\\/g, "/").replace(/\/+$/, "");
  s = s.replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase());
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function cursorProjectsRoot(): string {
  return path.join(os.homedir(), ".cursor", "projects");
}

function transcriptFileFor(projectDir: string, agentId: string): string {
  return path.join(projectDir, "agent-transcripts", agentId, `${agentId}.jsonl`);
}

/** Resolve the on-disk transcript for a Cursor chat / agent id. */
export function findTranscriptPath(agentId: string): string | undefined {
  if (!agentId || agentId.startsWith("tile:")) return undefined;
  const projects = cursorProjectsRoot();

  // 1) Prefer workspace-derived project slugs.
  for (const root of preferredRoots) {
    const slug = workspacePathToProjectSlug(root);
    const candidate = transcriptFileFor(path.join(projects, slug), agentId);
    if (fs.existsSync(candidate)) return candidate;
  }

  // 2) Direct scan: projects/*/agent-transcripts/<id>/<id>.jsonl
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return undefined;
  }
  for (const slug of dirs) {
    const candidate = transcriptFileFor(path.join(projects, slug), agentId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  result: TranscriptTurnEnd;
}

const cache = new Map<string, CacheEntry>();

/** Read the last complete JSONL object from a file (tail-only, cheap). */
export function readLastJsonlRecord(file: string): unknown | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (st.size === 0) return null;

  const fd = fs.openSync(file, "r");
  try {
    const start = Math.max(0, st.size - 16_384);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    // If we started mid-file, the first line may be a partial record — skip it.
    const candidates = start > 0 ? lines.slice(1) : lines;
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(candidates[i]);
      } catch {
        // keep walking backward past a corrupted trailing line
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function classifyStatus(raw: unknown): TranscriptEndStatus {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "success" || s === "ok" || s === "completed") return "success";
  if (s === "error" || s === "failed" || s === "aborted" || s === "cancelled") {
    return "error";
  }
  return "other";
}

/**
 * Verdict for one agent: has its *current* turn ended?
 * Returns `{ ended: false }` when the transcript is missing, unreadable, or the
 * last record is still an in-progress user/assistant/tool line.
 */
export function getTranscriptTurnEnd(agentId: string): TranscriptTurnEnd {
  const file = findTranscriptPath(agentId);
  if (!file) return { ended: false };

  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { ended: false };
  }

  const prev = cache.get(agentId);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
    return prev.result;
  }

  const last = readLastJsonlRecord(file);
  let result: TranscriptTurnEnd = {
    ended: false,
    path: file,
    mtimeMs: st.mtimeMs,
  };

  if (last && typeof last === "object" && (last as { type?: string }).type === "turn_ended") {
    const rec = last as { status?: string; error?: string };
    const status = classifyStatus(rec.status);
    result = {
      ended: true,
      status,
      rawStatus: typeof rec.status === "string" ? rec.status : undefined,
      error: typeof rec.error === "string" ? rec.error : undefined,
      path: file,
      mtimeMs: st.mtimeMs,
    };
  }

  cache.set(agentId, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}

/** True when the transcript proves the agent's turn is over (final turn_ended). */
export function isTranscriptTurnDead(agentId: string): boolean {
  return getTranscriptTurnEnd(agentId).ended;
}

/**
 * Confirmed dead: transcript ended AND the MCP loop is no longer heartbeating.
 * Transcript alone is not enough — Cursor can leave a prior `turn_ended` as the
 * last flushed line briefly while a new turn is already generating, and a live
 * agent mid-task may not append new jsonl lines for a while. Fresh heartbeat
 * always wins.
 */
export function isTranscriptDeadConfirmed(
  agentId: string,
  heartbeatAlive: boolean,
): boolean {
  return !heartbeatAlive && isTranscriptTurnDead(agentId);
}

/** One action the agent took, as recovered from the transcript tail. */
export interface ActivityStep {
  /** Stable-ish signature used to align successive reads (not for display). */
  sig: string;
  /** Human label, e.g. "Reading Cursor Hub.md". */
  label: string;
  /** Tool name when this step was a tool_use. */
  tool?: string;
  /**
   * Epoch ms when the extension FIRST saw this step.
   *
   * Cursor's transcript records carry no timestamps, so this is an observation
   * time, not the moment the agent actually acted. For a live agent the two are
   * within a poll/flush of each other, which is what "how long has it been on
   * this?" needs. For steps already on disk when we started watching, every
   * timestamp collapses to that first read — so the UI must not present these
   * as authoritative history.
   */
  firstSeen: number;
}

/** Live "what is this agent doing?" snapshot from the transcript tail. */
export interface TranscriptActivity {
  /** One-line human summary for the Agents list / detail header. */
  summary: string;
  /** Recent tool names (newest last), capped. */
  tools: string[];
  /** Rolling feed of recent actions, oldest → newest. */
  steps: ActivityStep[];
  /** Tool calls seen in the current turn (within the tail window). */
  stepCount: number;
  /** True when `stepCount` was clipped by the tail window (so it's a floor). */
  stepCountPartial: boolean;
  /** Epoch ms the current (newest) action was first observed. */
  since?: number;
  /**
   * Where this snapshot came from, so the UI can be honest about latency:
   *   dom        — live tile cards, instant, needs the Agents window open
   *   db         — Cursor's bubble rows, always available, ~30s behind
   *   transcript — the .jsonl, only describes finished turns
   */
  source?: "dom" | "db" | "transcript";
  /** True when the last jsonl record is turn_ended. */
  ended: boolean;
  endStatus?: TranscriptEndStatus;
  error?: string;
  /** Transcript file mtime (ms). */
  mtimeMs?: number;
}

interface ActivityCacheEntry {
  mtimeMs: number;
  size: number;
  activity: TranscriptActivity;
}

const activityCache = new Map<string, ActivityCacheEntry>();

/** Per-agent ledger of steps we've already observed, so first-seen times survive
 *  across reads even as the tail window slides. */
const stepLedger = new Map<string, ActivityStep[]>();

/** Longest overlap where the tail of `prev` equals the head of `next`. Steps are
 *  append-only, so this recovers which entries are genuinely new after the tail
 *  window has slid forward. */
function alignOverlap(prev: ActivityStep[], next: string[]): number {
  const max = Math.min(prev.length, next.length);
  for (let o = max; o > 0; o--) {
    let ok = true;
    for (let i = 0; i < o; i++) {
      if (prev[prev.length - o + i].sig !== next[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return o;
  }
  return 0;
}

const MAX_FEED_STEPS = 24;

function basenamePath(p: string): string {
  const s = p.replace(/\\/g, "/");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function summarizeTool(name: string, input: Record<string, unknown> | undefined): string {
  const inp = input || {};
  switch (name) {
    case "Read":
      return typeof inp.path === "string" ? `Reading ${basenamePath(inp.path)}` : "Reading a file";
    case "Write":
      return typeof inp.path === "string" ? `Writing ${basenamePath(inp.path)}` : "Writing a file";
    case "StrReplace":
      return typeof inp.path === "string" ? `Editing ${basenamePath(inp.path)}` : "Editing a file";
    case "Shell": {
      const cmd = typeof inp.command === "string" ? inp.command.replace(/\s+/g, " ").trim() : "";
      return cmd ? `Shell: ${cmd.slice(0, 80)}` : "Running a shell command";
    }
    case "Grep":
      return typeof inp.pattern === "string" ? `Searching: ${inp.pattern.slice(0, 60)}` : "Searching code";
    case "Glob":
      return typeof inp.glob_pattern === "string"
        ? `Glob: ${String(inp.glob_pattern).slice(0, 60)}`
        : "Finding files";
    case "CallMcpTool": {
      const tool = typeof inp.toolName === "string" ? inp.toolName : "";
      if (/check_messages/i.test(tool)) return "Listening (MCP)";
      if (/send_progress/i.test(tool)) return "Sending progress";
      if (/ask_question/i.test(tool)) return "Asking a question";
      return tool ? `MCP: ${tool}` : "Calling MCP";
    }
    case "GetMcpTools":
      return "Checking MCP tools";
    case "WebSearch":
      return typeof inp.search_term === "string"
        ? `Web search: ${String(inp.search_term).slice(0, 60)}`
        : "Web search";
    default:
      return name || "Working";
  }
}

function cleanAssistantText(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read the last ~N complete JSONL records (tail-only).
 *
 * The byte window has to be generous: a single `Write` tool_use embeds the
 * whole file body, so a few hundred KB of transcript can be only two or three
 * records. Too small a window silently collapses the activity feed to one line
 * for exactly the agents doing the most work. Re-reads only happen when the
 * file's mtime/size changes, so this stays cheap.
 */
function readRecentJsonlRecords(file: string, maxRecords = 30): unknown[] {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  if (st.size === 0) return [];
  const fd = fs.openSync(file, "r");
  try {
    const start = Math.max(0, st.size - 512_000);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const candidates = start > 0 ? lines.slice(1) : lines;
    const out: unknown[] = [];
    for (let i = Math.max(0, candidates.length - maxRecords); i < candidates.length; i++) {
      try {
        out.push(JSON.parse(candidates[i]));
      } catch {
        // skip partial/corrupt
      }
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Snapshot of what an agent is doing, from its Cursor transcript tail.
 * Safe to call on every roster poll — cached by file mtime/size.
 */
export function getTranscriptActivity(agentId: string): TranscriptActivity | undefined {
  if (!agentId || agentId.startsWith("tile:")) return undefined;
  const file = findTranscriptPath(agentId);
  if (!file) return undefined;

  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return undefined;
  }

  const prev = activityCache.get(agentId);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
    return prev.activity;
  }

  const records = readRecentJsonlRecords(file, 400);

  // Forward scan (oldest → newest) so the feed reads in the order things
  // happened, and so `stepCount` can reset at each turn boundary.
  const sigs: string[] = [];
  const labels: string[] = [];
  const toolNames: (string | undefined)[] = [];
  let ended = false;
  let endStatus: TranscriptEndStatus | undefined;
  let error: string | undefined;
  let stepsThisTurn = 0;
  let sawTurnBoundary = false;
  let occurrence = 0;

  const push = (label: string, tool: string | undefined): void => {
    // Identical consecutive actions collapse — an agent re-reading the same
    // file twice in a row is noise, not progress.
    if (labels.length > 0 && labels[labels.length - 1] === label) return;
    sigs.push(`${occurrence++}|${tool ?? "text"}|${label}`);
    labels.push(label);
    toolNames.push(tool);
  };

  for (const raw of records) {
    const rec = raw as {
      type?: string;
      status?: string;
      error?: string;
      role?: string;
      message?: { content?: unknown };
    };

    if (rec?.type === "turn_ended") {
      ended = true;
      endStatus = classifyStatus(rec.status);
      error = typeof rec.error === "string" ? rec.error : undefined;
      stepsThisTurn = 0;
      sawTurnBoundary = true;
      push(
        endStatus === "error"
          ? `Turn ended: ${(error || "error").slice(0, 100)}`
          : "Turn ended",
        undefined,
      );
      continue;
    }

    if (rec?.role === "user") {
      // A new user record means a fresh turn started after any prior end.
      ended = false;
      endStatus = undefined;
      error = undefined;
      stepsThisTurn = 0;
      sawTurnBoundary = true;
      continue;
    }

    if (rec?.role !== "assistant") continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;

    ended = false;
    for (const part of content as Array<{
      type?: string;
      name?: string;
      input?: Record<string, unknown>;
      text?: string;
    }>) {
      if (part?.type === "tool_use" && part.name) {
        stepsThisTurn++;
        push(summarizeTool(part.name, part.input), part.name);
      } else if (part?.type === "text" && part.text) {
        const t = cleanAssistantText(part.text);
        if (t) push(t.slice(0, 140), undefined);
      }
    }
  }

  // Stamp first-seen times, reusing what we already observed for this agent.
  const ledger = stepLedger.get(agentId) ?? [];
  const overlap = alignOverlap(ledger, sigs);
  const now = Date.now();
  const steps: ActivityStep[] = sigs.map((sig, i) => {
    if (i < overlap) {
      return { ...ledger[ledger.length - overlap + i], sig };
    }
    return { sig, label: labels[i], tool: toolNames[i], firstSeen: now };
  });
  stepLedger.set(agentId, steps.slice(-MAX_FEED_STEPS * 2));

  const feed = steps.slice(-MAX_FEED_STEPS);
  const newest = steps[steps.length - 1];
  const summary =
    newest?.label || (ended ? "Turn ended" : "No transcript activity yet");

  const activity: TranscriptActivity = {
    summary,
    tools: toolNames.filter((t): t is string => !!t).slice(-6),
    steps: feed,
    stepCount: stepsThisTurn,
    stepCountPartial: !sawTurnBoundary,
    since: newest?.firstSeen,
    source: "transcript",
    ended,
    endStatus,
    error,
    mtimeMs: st.mtimeMs,
  };
  activityCache.set(agentId, { mtimeMs: st.mtimeMs, size: st.size, activity });
  return activity;
}

// ── Live (mid-turn) activity from the tile DOM ──────────────────────────────

/**
 * Cursor does not flush the `.jsonl` transcript until a turn ENDS. Measured on
 * this machine: an agent parked in the jefr MCP loop ran for 80 minutes and
 * dozens of tool calls while its transcript stayed frozen at 818 bytes.
 *
 * So the transcript can only ever describe *finished* turns. For "what is this
 * agent doing right now" the live source is the tile DOM, which renders a tool
 * card per action as it happens (see `TileInfo.liveTools`).
 *
 * This merges the two: live cards win for the current turn, and the transcript
 * supplies the end-of-turn verdict plus history when no cards are visible.
 */
const liveLedger = new Map<string, ActivityStep[]>();

/** Map a raw tool-card label onto the same phrasing the transcript path uses. */
function normalizeCardLabel(raw: string): string {
  const s = raw.replace(/\s+/g, " ").trim();
  const m = /^([A-Za-z ]{2,24}?)\s+(?:in\s+\w+\s*)?(.*)$/.exec(s);
  if (m) {
    const verb = m[1].toLowerCase().replace(/\s+/g, "");
    const rest = m[2].trim();
    if (verb === "readfile" || verb === "read") return rest ? `Reading ${rest}` : "Reading a file";
    if (verb === "writefile" || verb === "write") return rest ? `Writing ${rest}` : "Writing a file";
    if (verb === "edited" || verb === "edit") return rest ? `Editing ${rest}` : "Editing a file";
    if (verb === "checkmessages") return "Listening (MCP)";
    if (verb === "sendprogress") return "Sending progress";
    if (verb === "askquestion") return "Asking a question";
  }
  return s;
}

/** Steps recovered from Cursor's own bubble rows — the middle tier between the
 *  instant-but-conditional DOM and the turn-granular transcript. */
export interface DbActivityInput {
  steps: Array<{ bubbleId: string; label: string; tool: string; status: string; firstSeen: number }>;
  running: boolean;
}

/** Build an activity snapshot from Cursor's bubble rows. Used when the tile DOM
 *  has nothing to offer (Agents window closed, or selectors drifted). */
export function activityFromDb(
  db: DbActivityInput | undefined,
  base: TranscriptActivity | undefined,
): TranscriptActivity | undefined {
  if (!db || db.steps.length === 0) return base;
  const steps: ActivityStep[] = db.steps.map((s) => ({
    sig: s.bubbleId,
    label: s.label,
    tool: s.tool || undefined,
    firstSeen: s.firstSeen,
  }));
  const newest = steps[steps.length - 1];
  return {
    summary: newest?.label || base?.summary || "Working",
    tools: db.steps.map((s) => s.tool).filter(Boolean).slice(-6),
    steps: steps.slice(-MAX_FEED_STEPS),
    stepCount: steps.length,
    stepCountPartial: true,
    since: newest?.firstSeen,
    source: "db",
    // A bubble Cursor still marks as running proves the turn is live.
    ended: db.running ? false : base?.ended ?? false,
    endStatus: db.running ? undefined : base?.endStatus,
    error: db.running ? undefined : base?.error,
    mtimeMs: base?.mtimeMs,
  };
}

export function mergeLiveActivity(
  agentId: string,
  liveTools: string[] | undefined,
  liveToolRunning: boolean,
  base: TranscriptActivity | undefined,
): TranscriptActivity | undefined {
  if (!liveTools || liveTools.length === 0) {
    // No cards visible (selectors drifted, tile unmounted, or nothing running).
    // Caller falls back to the DB tier, then the transcript.
    liveLedger.delete(agentId);
    return base;
  }

  const labels = liveTools.map(normalizeCardLabel).filter(Boolean);
  const sigs = labels.map((l, i) => `${i}|card|${l}`);
  const ledger = liveLedger.get(agentId) ?? [];
  const overlap = alignOverlap(ledger, sigs);
  const now = Date.now();
  const steps: ActivityStep[] = sigs.map((sig, i) =>
    i < overlap
      ? { ...ledger[ledger.length - overlap + i], sig }
      : { sig, label: labels[i], tool: undefined, firstSeen: now },
  );
  liveLedger.set(agentId, steps.slice(-MAX_FEED_STEPS * 2));

  const newest = steps[steps.length - 1];
  return {
    summary: newest?.label || base?.summary || "Working",
    tools: base?.tools ?? [],
    steps: steps.slice(-MAX_FEED_STEPS),
    stepCount: steps.length,
    // The tile only keeps the recent cards mounted, so this is a floor.
    stepCountPartial: true,
    since: newest?.firstSeen,
    source: "dom",
    // A visible running card means the turn is live, whatever the transcript says.
    ended: liveToolRunning ? false : base?.ended ?? false,
    endStatus: liveToolRunning ? undefined : base?.endStatus,
    error: liveToolRunning ? undefined : base?.error,
    mtimeMs: base?.mtimeMs,
  };
}

// ── Change watching ─────────────────────────────────────────────────────────

/**
 * Watch each live agent's transcript and fire `onChange` shortly after Cursor
 * appends to one. This is a latency optimisation on top of the existing roster
 * poll, not a replacement: `fs.watch` is unreliable on some Windows/network
 * paths, so the caller must keep polling as a floor.
 */
const watchers = new Map<string, fs.FSWatcher>();
let watchDebounce: ReturnType<typeof setTimeout> | undefined;
let watchCallback: (() => void) | undefined;

function fireWatch(): void {
  if (watchDebounce) clearTimeout(watchDebounce);
  // Coalesce the burst of events Cursor emits while flushing one checkpoint.
  watchDebounce = setTimeout(() => {
    watchDebounce = undefined;
    try {
      watchCallback?.();
    } catch {
      // never let a UI push error kill the watcher
    }
  }, 120);
}

/** Start/stop watchers so exactly `agentIds` are covered. Cheap to call often. */
export function syncTranscriptWatchers(
  agentIds: string[],
  onChange: () => void,
): void {
  watchCallback = onChange;
  const wanted = new Set(agentIds.filter((id) => id && !id.startsWith("tile:")));

  for (const [id, w] of watchers) {
    if (!wanted.has(id)) {
      try {
        w.close();
      } catch {
        /* already gone */
      }
      watchers.delete(id);
    }
  }

  for (const id of wanted) {
    if (watchers.has(id)) continue;
    const file = findTranscriptPath(id);
    if (!file) continue; // transcript not created yet — the poll will catch it
    try {
      const w = fs.watch(file, { persistent: false }, () => fireWatch());
      w.on("error", () => {
        try {
          w.close();
        } catch {
          /* noop */
        }
        watchers.delete(id);
      });
      watchers.set(id, w);
    } catch {
      // Watching failed (permissions, network path). Polling still covers us.
    }
  }
}

/** Tear down every transcript watcher (deactivate). */
export function stopTranscriptWatchers(): void {
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = undefined;
  }
  for (const w of watchers.values()) {
    try {
      w.close();
    } catch {
      /* noop */
    }
  }
  watchers.clear();
  watchCallback = undefined;
}

/** Drop cached verdicts (tests / workspace folder changes). */
export function clearTranscriptCache(): void {
  cache.clear();
  activityCache.clear();
  stepLedger.clear();
}
