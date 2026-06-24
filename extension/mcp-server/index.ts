/**
 * jefr MCP server.
 *
 * A standalone Node.js process that Cursor's AI agent talks to over stdio
 * (JSON-RPC). It exposes three tools — `check_messages`, `send_progress`,
 * and `ask_question` — and bridges them to the VS Code extension through a
 * shared directory of small JSON files (file-system IPC).
 *
 * Multi-agent: a single MCP server process is shared by every agent tile in a
 * window. To let the panel address a specific agent, each tool accepts an
 * optional `agent_id`. When provided, all of that agent's state lives under
 * `<DATA_DIR>/agents/<agent_id>/…` so per-agent queues/replies/heartbeats never
 * collide. When omitted, the server uses the shared root files exactly as
 * before (fully backward compatible).
 *
 * Reconstructed (readable) source for the jefr-specific slice of the bundled
 * `dist/mcp-server.mjs`. The rest of that bundle is the vendored
 * `@modelcontextprotocol/sdk` + `zod`, which are public libraries.
 * See `README.md` in this folder for a plain-English walkthrough.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/* ------------------------------------------------------------------ */
/* Configuration + shared file paths                                   */
/* ------------------------------------------------------------------ */

/** Directory shared with the extension (override via env var). */
const DATA_DIR =
  process.env.MESSENGER_DATA_DIR || path.join(os.homedir(), ".moyu-message");

/** Per-agent state lives under DATA_DIR/agents/<agent_id>/. */
const AGENTS_ROOT = path.join(DATA_DIR, "agents");

const LOG_FILE = path.join(DATA_DIR, "server.log"); // always at the shared root

/** Resolve the data directory for a given agent (or the shared root). A blank
 *  / missing id keeps the legacy single-listener behavior. The id is sanitized
 *  to a safe path segment so it can never escape AGENTS_ROOT. */
function dirFor(agentId?: string): string {
  const id = sanitizeAgentId(agentId);
  return id ? path.join(AGENTS_ROOT, id) : DATA_DIR;
}
function sanitizeAgentId(agentId?: string): string {
  if (!agentId || typeof agentId !== "string") return "";
  // UUID-ish ids only; strip anything that isn't safe for a folder name.
  const clean = agentId.trim().replace(/[^A-Za-z0-9._-]/g, "");
  return clean.slice(0, 64);
}

const queueFile = (dir: string) => path.join(dir, "queue.json");
const questionFile = (dir: string) => path.join(dir, "question.json");
const answerFile = (dir: string) => path.join(dir, "answer.json");
const replyFile = (dir: string) => path.join(dir, "reply.json");
const heartbeatFile = (dir: string) => path.join(dir, "agent-alive.json");
const queueLockDir = (dir: string) => path.join(dir, "queue.lock");

/** How often the blocking tools re-check the disk, in ms. */
const POLL_INTERVAL = 100;
/** How often a blocked call refreshes ITS OWN agent heartbeat. Must be well
 *  under the extension's stale window (6s) so drop detection stays accurate. */
const AGENT_BEAT_INTERVAL = 2500;
/** How often to emit a keep-alive heartbeat while blocked, in ms. */
const HEARTBEAT_INTERVAL =
  Number(process.env.MESSENGER_HEARTBEAT_INTERVAL_MS) || 8_000;
/** Give up waiting after this long and ask the agent to re-call, in ms. */
const MAX_WAIT_MS = Number(process.env.MESSENGER_MAX_WAIT_MS) || 120_000;

/**
 * Appended to every delivered user message so the agent is reminded to keep
 * the perpetual loop going by calling `check_messages` again. When the agent
 * is addressable (has an agent_id), the reminder spells out that the id must
 * be passed back on every call so routing stays stable.
 */
function systemSuffix(agentId?: string): string {
  const id = sanitizeAgentId(agentId);
  const idNote = id
    ? ` You are jefr agent ${id}; pass agent_id:'${id}' to every jefr tool call (check_messages / send_progress / ask_question).`
    : "";
  return (
    "\n\n---\n[system] The message above was sent by the user via the plugin. " +
    "After replying, call the jefr MCP check_messages tool to keep listening for new messages." +
    idNote
  );
}

/* ------------------------------------------------------------------ */
/* Data-shape types (mirrors of the JSON written by the extension)     */
/* ------------------------------------------------------------------ */

interface QueueMessage {
  id?: string;
  type: "text" | "image" | "file";
  content?: string;
  path?: string;
  caption?: string;
  suffix?: string;
  timestamp?: string;
}

/** A single piece of MCP tool result content. */
type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/* ------------------------------------------------------------------ */
/* Small filesystem helpers                                            */
/* ------------------------------------------------------------------ */

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Touch the agent-liveness file so the extension (and front-ends like the
 * Obsidian plugin) can tell that a Cursor agent is *actually* running the
 * perpetual loop. With multi-agent, the heartbeat is written into the agent's
 * own directory and stamped with its id, so the panel can list each live agent
 * independently. Best-effort: liveness must never throw.
 */
async function touchAgentAlive(
  dir: string,
  state: "waiting" | "working",
  agentId?: string,
): Promise<void> {
  try {
    await ensureDir(dir);
    await fs.writeFile(
      heartbeatFile(dir),
      JSON.stringify({
        ts: Date.now(),
        pid: process.pid,
        state,
        agentId: sanitizeAgentId(agentId) || undefined,
      }),
      "utf-8",
    );
  } catch {
    // ignore — liveness is advisory only
  }
}

// ── Background liveness ticker ──────────────────────────────────────────────
// One shared process serves every agent tile. The legacy globals below drive the
// *root* heartbeat (single-listener case). For multi-agent, each agent gets its
// own liveness record so the ticker can keep that agent's heartbeat warm as
// "working" *during a task* — the stretch between finishing check_messages and
// the next tool call, when nothing else refreshes it. Without this the per-agent
// heartbeat goes stale after the 6s window, the panel flips the agent to "down"
// mid-task, and its uptime counter restarts on the next call.
let activeWaits = 0;
let lastInteractionTs = Date.now();
const BUSY_WINDOW_MS = Number(process.env.MESSENGER_BUSY_WINDOW_MS) || 180_000;

/** Per-agent liveness, keyed by sanitized agent id ("" = root single-listener). */
interface AgentLiveness {
  dir: string;
  lastInteractionTs: number;
  /** >0 while this agent is blocked in check_messages/ask_question. */
  activeWaits: number;
}
const agentLiveness = new Map<string, AgentLiveness>();

function livenessKey(agentId?: string): string {
  return sanitizeAgentId(agentId);
}

/** Record that this agent just interacted, so the ticker keeps it warm as
 *  "working" through the next BUSY_WINDOW_MS of tool-call-free task time. */
function noteAgentInteraction(dir: string, agentId?: string): AgentLiveness {
  const key = livenessKey(agentId);
  let rec = agentLiveness.get(key);
  if (!rec) {
    rec = { dir, lastInteractionTs: 0, activeWaits: 0 };
    agentLiveness.set(key, rec);
  }
  rec.dir = dir;
  rec.lastInteractionTs = Date.now();
  return rec;
}

const livenessTicker = setInterval(() => {
  const now = Date.now();
  // Legacy root heartbeat (single-listener case).
  if (activeWaits > 0) {
    void touchAgentAlive(DATA_DIR, "waiting");
  } else if (now - lastInteractionTs < BUSY_WINDOW_MS) {
    void touchAgentAlive(DATA_DIR, "working");
  }
  // Per-agent: keep each recently-active agent warm as "working" while it's
  // mid-task. Agents currently blocked-waiting refresh their own "waiting"
  // heartbeat, so skip them here to avoid clobbering that state.
  for (const [key, rec] of agentLiveness) {
    if (!key) continue; // root is handled by the legacy globals above
    if (rec.activeWaits > 0) continue; // blocked call keeps it warm as "waiting"
    if (now - rec.lastInteractionTs < BUSY_WINDOW_MS) {
      void touchAgentAlive(rec.dir, "working", key);
    }
  }
}, 2500);
// Don't let the ticker alone keep the process alive.
livenessTicker.unref?.();

async function readQueue(dir: string): Promise<QueueMessage[]> {
  try {
    const raw = await fs.readFile(queueFile(dir), "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Acquire the cross-process queue lock (mkdir is atomic). Returns false if it
 *  could not be taken in time; a lock older than 5s is reclaimed as stale. */
async function acquireQueueLock(dir: string, timeoutMs = 2000): Promise<boolean> {
  const lock = queueLockDir(dir);
  const start = Date.now();
  await ensureDir(dir);
  for (;;) {
    try {
      await fs.mkdir(lock);
      return true;
    } catch {
      try {
        const st = await fs.stat(lock);
        if (Date.now() - st.mtimeMs > 5000) {
          await fs.rmdir(lock).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished mid-check; retry
      }
      if (Date.now() - start > timeoutMs) {
        return false;
      }
      await delay(8);
    }
  }
}

async function releaseQueueLock(dir: string): Promise<void> {
  await fs.rmdir(queueLockDir(dir)).catch(() => {});
}

/** Write `data` directly, retrying briefly on transient Windows file locks.
 *  (Temp+rename is avoided: on Windows rename-over-existing throws EPERM when a
 *  reader has the file open. The lock serializes writers and readers tolerate a
 *  transient partial, so a direct retrying write is the robust choice.) */
async function robustWriteFile(file: string, data: string): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < 10; i++) {
    try {
      await fs.writeFile(file, data, "utf-8");
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        throw e;
      }
      await delay(15);
    }
  }
  if (lastErr) {
    throw lastErr;
  }
}

/**
 * Atomically take ALL pending messages and clear the queue under the shared
 * lock, so a concurrent send from the extension can't be lost between our read
 * and clear. A lock-free peek avoids lock churn on the common empty case.
 *
 * Multi-agent fix: when reading from an agent-specific directory, also check
 * the shared root queue as a fallback. This allows messages sent to the root
 * queue (e.g., from Obsidian) to reach specific agents.
 */
async function drainQueue(dir: string): Promise<QueueMessage[]> {
  // First check the agent-specific queue
  const peek = await readQueue(dir);
  if (peek.length > 0) {
    const locked = await acquireQueueLock(dir);
    try {
      const queue = await readQueue(dir);
      if (queue.length > 0) {
        await robustWriteFile(queueFile(dir), "[]");
      }
      return queue;
    } finally {
      if (locked) {
        await releaseQueueLock(dir);
      }
    }
  }

  // Fallback: check the shared root queue (for Obsidian plugin, etc.)
  // Only do this if we're reading from an agent-specific directory
  if (dir !== DATA_DIR) {
    const rootPeek = await readQueue(DATA_DIR);
    if (rootPeek.length > 0) {
      const locked = await acquireQueueLock(DATA_DIR);
      try {
        const queue = await readQueue(DATA_DIR);
        if (queue.length > 0) {
          await robustWriteFile(queueFile(DATA_DIR), "[]");
        }
        return queue;
      } finally {
        if (locked) {
          await releaseQueueLock(DATA_DIR);
        }
      }
    }
  }

  return [];
}

/** Resolves true after `ms`, or false immediately if the signal aborts. */
function sleepWithAbort(signal: AbortSignal, ms: number): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, ms, true);
    const onAbort = () => finish(false);
    function finish(result: boolean) {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/* ------------------------------------------------------------------ */
/* Turning queued items into MCP content                               */
/* ------------------------------------------------------------------ */

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

async function processTextMessage(msg: QueueMessage): Promise<ContentPart> {
  return { type: "text", text: msg.content || "" };
}

async function processImageMessage(
  msg: QueueMessage,
): Promise<ContentPart | ContentPart[]> {
  const filePath = msg.path;
  if (!filePath) return { type: "text", text: "[Image message: empty path]" };
  try {
    const buf = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME_MAP[ext] || "application/octet-stream";
    const base64 = buf.toString("base64");
    const result: ContentPart[] = [];
    if (msg.caption) result.push({ type: "text", text: msg.caption });
    result.push({ type: "image", data: base64, mimeType: mime });
    return result.length === 1 ? result[0] : result;
  } catch {
    return { type: "text", text: `[Image read failed: ${filePath}]` };
  }
}

/** Text file extensions that get inlined (under the size cap). */
const TEXT_EXTS = new Set([
  ".txt", ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".py", ".java",
  ".c", ".cpp", ".h", ".css", ".html", ".xml", ".yaml", ".yml", ".toml",
  ".ini", ".cfg", ".sh", ".bat", ".ps1", ".log", ".csv", ".sql", ".rs",
  ".go", ".rb", ".php", ".vue", ".svelte",
]);

async function processFileMessage(msg: QueueMessage): Promise<ContentPart> {
  const filePath = msg.path;
  if (!filePath) return { type: "text", text: "[File message: empty path]" };
  try {
    const stat = await fs.stat(filePath);
    const ext = path.extname(filePath).toLowerCase();
    let text = `[File: ${path.basename(filePath)}] (${formatSize(stat.size)})\nPath: ${filePath}\n`;
    if (TEXT_EXTS.has(ext) && stat.size < 512 * 1024) {
      const content = await fs.readFile(filePath, "utf-8");
      text += "```\n" + content + "\n```";
    } else {
      text += "(Binary file; content skipped)";
    }
    if (msg.suffix) text += "\n" + msg.suffix;
    return { type: "text", text };
  } catch {
    return { type: "text", text: `[File read failed: ${filePath}]` };
  }
}

async function processMessage(
  msg: QueueMessage,
): Promise<ContentPart | ContentPart[]> {
  switch (msg.type) {
    case "text":
      return processTextMessage(msg);
    case "image":
      return processImageMessage(msg);
    case "file":
      return processFileMessage(msg);
    default:
      return { type: "text", text: `[Unknown message type: ${msg.type}]` };
  }
}

/* ------------------------------------------------------------------ */
/* Server + logging                                                    */
/* ------------------------------------------------------------------ */

const server = new McpServer(
  { name: "jefr", version: "1.1.0" },
  { capabilities: { logging: {} } },
);

async function appendServerLog(level: string, message: string): Promise<void> {
  try {
    await ensureDir(DATA_DIR);
    await fs.appendFile(
      LOG_FILE,
      `[${new Date().toISOString()}] [${level}] ${message}\n`,
      "utf-8",
    );
  } catch {
    // logging must never throw
  }
}

/**
 * Emit a heartbeat while a tool is blocked, preferring an MCP progress
 * notification (if the client passed a progressToken) and falling back to a
 * logging message. Keeps the client from treating the call as hung.
 */
async function emitHeartbeat(extra: any, message: string): Promise<void> {
  if (extra.signal.aborted) return;
  const progressToken = extra._meta?.progressToken;
  if (progressToken !== undefined) {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: Date.now(), message },
      });
      return;
    } catch {
      // fall through to logging
    }
  }
  try {
    await server.sendLoggingMessage(
      { level: "info", logger: "jefr", data: message },
      extra.sessionId,
    );
  } catch {
    // ignore
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

process.on("uncaughtException", (error) => {
  void appendServerLog("error", `uncaughtException: ${formatError(error)}`);
});
process.on("unhandledRejection", (reason) => {
  void appendServerLog("error", `unhandledRejection: ${formatError(reason)}`);
});

/* ------------------------------------------------------------------ */
/* Shared optional agent_id argument                                   */
/* ------------------------------------------------------------------ */

const AGENT_ID_ARG = {
  agent_id: z
    .string()
    .optional()
    .describe(
      "This agent's stable id (its Cursor agentId / chat UUID). Pass it on every call so the panel can route messages to THIS agent only. Omit for the shared single-listener queue.",
    ),
};

/* ------------------------------------------------------------------ */
/* Tool: check_messages                                                */
/* ------------------------------------------------------------------ */

server.tool(
  "check_messages",
  "Check and return pending user messages. You must call this tool after every reply. Optionally pass reply to push a summary to the plugin panel, and agent_id to scope to this agent.",
  {
    reply: z
      .string()
      .optional()
      .describe(
        "Summary of this reply (Markdown supported), pushed to the plugin panel for the user",
      ),
    ...AGENT_ID_ARG,
  },
  async ({ reply, agent_id }, extra) => {
    const dir = dirFor(agent_id);
    await ensureDir(dir);
    const live = noteAgentInteraction(dir, agent_id);
    await appendServerLog("info", `check_messages started${agent_id ? ` (agent ${sanitizeAgentId(agent_id)})` : ""}`);

    // 1) If the agent included a reply, surface it in the panel immediately.
    if (reply) {
      await fs.writeFile(
        replyFile(dir),
        JSON.stringify({ content: reply, timestamp: new Date().toISOString() }, null, 2),
        "utf-8",
      );
    }

    // 2) Block, polling the queue, until a message arrives (or we time out).
    activeWaits++;
    live.activeWaits++;
    await touchAgentAlive(dir, "waiting", agent_id);
    try {
      const waitStart = Date.now();
      let nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL;
      let nextAgentBeatAt = Date.now() + AGENT_BEAT_INTERVAL;

      while (!extra.signal.aborted) {
        // Keep this agent's own heartbeat fresh (faster than the stale window).
        if (Date.now() >= nextAgentBeatAt) {
          await touchAgentAlive(dir, "waiting", agent_id);
          nextAgentBeatAt = Date.now() + AGENT_BEAT_INTERVAL;
        }
        const queue = await drainQueue(dir);
        if (queue.length > 0) {
          const results: ContentPart[] = [];
          for (const msg of queue) {
            const processed = await processMessage(msg);
            if (Array.isArray(processed)) results.push(...processed);
            else results.push(processed);
          }

          // Append the loop-reminder suffix to the last text part.
          const suffix = systemSuffix(agent_id);
          const last = results[results.length - 1];
          if (results.length > 0 && last.type === "text") {
            last.text += suffix;
          } else {
            results.push({ type: "text", text: suffix });
          }

          await appendServerLog("info", `check_messages delivered ${queue.length} queued item(s)`);
          lastInteractionTs = Date.now();
          return { content: results };
        }

        if (Date.now() - waitStart >= MAX_WAIT_MS) {
          await appendServerLog("info", `check_messages timed out after ${MAX_WAIT_MS}ms, requesting re-call`);
          return {
            content: [
              {
                type: "text",
                text: "[system] No new messages. Do not show this to the user; call check_messages again immediately to keep listening.",
              },
            ],
          };
        }

        if (Date.now() >= nextHeartbeatAt) {
          await emitHeartbeat(extra, "jefr is still waiting for the next user message.");
          // Keep this agent's own heartbeat warm while blocked.
          await touchAgentAlive(dir, "waiting", agent_id);
          nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL;
        }

        const keepWaiting = await sleepWithAbort(extra.signal, POLL_INTERVAL);
        if (!keepWaiting) break;
      }

      await appendServerLog("warn", "check_messages was cancelled by the client while waiting");
      return {
        content: [
          {
            type: "text",
            text: "[system] check_messages wait was interrupted by the client. If the session should continue, do not show this internal note to the user; call check_messages again.",
          },
        ],
        isError: true,
      };
    } finally {
      activeWaits--;
      live.activeWaits--;
      live.lastInteractionTs = Date.now();
      lastInteractionTs = Date.now();
    }
  },
);

/* ------------------------------------------------------------------ */
/* Tool: send_progress                                                 */
/* ------------------------------------------------------------------ */

server.tool(
  "send_progress",
  "Push current work progress to the remote console. During multi-step tasks, call this tool after each step. Optionally pass percent (0-100) and agent_id. Returns immediately without waiting for messages.",
  {
    progress: z
      .string()
      .describe("Progress summary (Markdown supported), pushed to the plugin panel and remote console"),
    percent: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe("Completion percentage (0-100) for the panel's progress bar, e.g. completed steps / total steps"),
    ...AGENT_ID_ARG,
  },
  async ({ progress, percent, agent_id }) => {
    const dir = dirFor(agent_id);
    await ensureDir(dir);
    noteAgentInteraction(dir, agent_id);
    lastInteractionTs = Date.now();
    await touchAgentAlive(dir, "working", agent_id);
    const payload: Record<string, unknown> = {
      content: progress,
      timestamp: new Date().toISOString(),
    };
    if (typeof percent === "number") payload.percent = Math.max(0, Math.min(100, Math.round(percent)));
    await fs.writeFile(replyFile(dir), JSON.stringify(payload, null, 2), "utf-8");
    await appendServerLog(
      "info",
      `send_progress${typeof percent === "number" ? ` (${payload.percent}%)` : ""}: ${progress.slice(0, 100)}`,
    );
    return {
      content: [
        { type: "text", text: "[system] Progress pushed. Continue the task; no need to wait for a user reply." },
      ],
    };
  },
);

/* ------------------------------------------------------------------ */
/* Tool: ask_question                                                  */
/* ------------------------------------------------------------------ */

server.tool(
  "ask_question",
  "Ask the user one or more questions and wait for answers. Supports single/multi-select and custom input. Optionally pass agent_id to scope to this agent. Blocks until the user responds.",
  {
    questions: z
      .array(
        z.object({
          question: z.string().describe("Question text"),
          options: z
            .array(
              z.object({
                id: z.string().describe("Option ID"),
                label: z.string().describe("Option label"),
              }),
            )
            .describe("Options"),
          allow_multiple: z.boolean().default(false).describe("Allow multiple selections"),
        }),
      )
      .describe("List of questions; multiple questions can be asked at once"),
    ...AGENT_ID_ARG,
  },
  async ({ questions, agent_id }, extra) => {
    const dir = dirFor(agent_id);
    await ensureDir(dir);
    const live = noteAgentInteraction(dir, agent_id);
    await appendServerLog("info", `ask_question started${agent_id ? ` (agent ${sanitizeAgentId(agent_id)})` : ""}`);

    // 1) Write the question for the panel; give each question a stable id.
    const questionItems = questions.map((q, i) => ({
      id: "q" + i,
      question: q.question,
      options: q.options || [],
      allow_multiple: !!q.allow_multiple,
    }));
    const questionData = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      questions: questionItems,
      timestamp: new Date().toISOString(),
    };
    await fs.writeFile(questionFile(dir), JSON.stringify(questionData, null, 2), "utf-8");
    try {
      await fs.unlink(answerFile(dir)); // clear any stale answer
    } catch {
      // none present
    }

    // 2) Block, polling for the answer file (or time out).
    activeWaits++;
    live.activeWaits++;
    await touchAgentAlive(dir, "waiting", agent_id);
    try {
    const waitStart = Date.now();
    let nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL;
    let nextAgentBeatAt = Date.now() + AGENT_BEAT_INTERVAL;

    while (!extra.signal.aborted) {
      if (Date.now() >= nextAgentBeatAt) {
        await touchAgentAlive(dir, "waiting", agent_id);
        nextAgentBeatAt = Date.now() + AGENT_BEAT_INTERVAL;
      }
      try {
        const raw = await fs.readFile(answerFile(dir), "utf-8");
        const answerData = JSON.parse(raw);
        try { await fs.unlink(questionFile(dir)); } catch {}
        try { await fs.unlink(answerFile(dir)); } catch {}

        // Turn selected ids + free text into readable lines for the agent.
        const answers = answerData.answers || [];
        const parts: string[] = [];
        for (const qItem of questionItems) {
          const ans = answers.find((a: any) => a.questionId === qItem.id);
          if (!ans) continue;
          const selected: string[] = ans.selected || [];
          const other: string = ans.other || "";
          let text = "";
          if (selected.length > 0) {
            const labels = selected.map(
              (sid) => qItem.options.find((o) => o.id === sid)?.label || sid,
            );
            text = "Selected: " + labels.join(", ");
          }
          if (other) {
            text += text ? "\nUser note: " + other : "User answer: " + other;
          }
          if (text) {
            parts.push(
              questionItems.length > 1 ? "\u3010" + qItem.question + "\u3011\n" + text : text,
            );
          }
        }
        const finalText = parts.length > 0 ? parts.join("\n\n") : "(No answer)";
        await appendServerLog("info", "ask_question received user answer");
        lastInteractionTs = Date.now();
        return { content: [{ type: "text", text: finalText }] };
      } catch {
        // answer not ready yet
      }

      if (Date.now() - waitStart >= MAX_WAIT_MS) {
        await appendServerLog("info", `ask_question timed out after ${MAX_WAIT_MS}ms, requesting re-call`);
        return {
          content: [
            {
              type: "text",
              text: "[system] User has not answered yet. Do not show this to the user; call ask_question again with the same arguments.",
            },
          ],
        };
      }

      if (Date.now() >= nextHeartbeatAt) {
        await emitHeartbeat(extra, "jefr is still waiting for the user's answer.");
        await touchAgentAlive(dir, "waiting", agent_id);
        nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL;
      }

      const keepWaiting = await sleepWithAbort(extra.signal, POLL_INTERVAL);
      if (!keepWaiting) break;
    }

    await appendServerLog("warn", "ask_question was cancelled by the client while waiting");
    return {
      content: [
        {
          type: "text",
          text: "[system] ask_question wait was interrupted. If you still need an answer, do not show this internal note; call ask_question again.",
        },
      ],
      isError: true,
    };
    } finally {
      activeWaits--;
      live.activeWaits--;
      live.lastInteractionTs = Date.now();
      lastInteractionTs = Date.now();
    }
  },
);

/* ------------------------------------------------------------------ */
/* Start: speak MCP over stdin/stdout                                  */
/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
