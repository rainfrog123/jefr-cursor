/**
 * jefr MCP server.
 *
 * A standalone Node.js process that Cursor's AI agent talks to over stdio
 * (JSON-RPC). It exposes three tools — `check_messages`, `send_progress`,
 * and `ask_question` — and bridges them to the VS Code extension through a
 * shared directory of small JSON files (file-system IPC).
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

const QUEUE_FILE = path.join(DATA_DIR, "queue.json"); // extension -> server: pending sends
const QUESTION_FILE = path.join(DATA_DIR, "question.json"); // server -> extension: open question
const ANSWER_FILE = path.join(DATA_DIR, "answer.json"); // extension -> server: the user's answer
const REPLY_FILE = path.join(DATA_DIR, "reply.json"); // server -> extension: reply/progress summary
const LOG_FILE = path.join(DATA_DIR, "server.log");

/** How often the blocking tools re-check the disk, in ms. */
const POLL_INTERVAL = 100;
/** How often to emit a keep-alive heartbeat while blocked, in ms. */
const HEARTBEAT_INTERVAL =
  Number(process.env.MESSENGER_HEARTBEAT_INTERVAL_MS) || 8_000;
/** Give up waiting after this long and ask the agent to re-call, in ms. */
const MAX_WAIT_MS = Number(process.env.MESSENGER_MAX_WAIT_MS) || 120_000;

/**
 * Appended to every delivered user message so the agent is reminded to keep
 * the perpetual loop going by calling `check_messages` again.
 */
const SYSTEM_SUFFIX =
  "\n\n---\n[system] The message above was sent by the user via the plugin. " +
  "After replying, call the jefr MCP check_messages tool to keep listening for new messages.";

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

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readQueue(): Promise<QueueMessage[]> {
  try {
    const raw = await fs.readFile(QUEUE_FILE, "utf-8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function clearQueue(): Promise<void> {
  await fs.writeFile(QUEUE_FILE, "[]", "utf-8");
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
  { name: "jefr", version: "1.0.0" },
  { capabilities: { logging: {} } },
);

async function appendServerLog(level: string, message: string): Promise<void> {
  try {
    await ensureDataDir();
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
/* Tool: check_messages                                                */
/* ------------------------------------------------------------------ */

server.tool(
  "check_messages",
  "Check and return pending user messages. You must call this tool after every reply. Optionally pass reply to push a summary to the plugin panel.",
  {
    reply: z
      .string()
      .optional()
      .describe(
        "Summary of this reply (Markdown supported), pushed to the plugin panel for the user",
      ),
  },
  async ({ reply }, extra) => {
    await ensureDataDir();
    await appendServerLog("info", "check_messages started");

    // 1) If the agent included a reply, surface it in the panel immediately.
    //    (The extension is the single writer of history.json — it mirrors this
    //    reply into the shared conversation history to avoid cross-process races.)
    if (reply) {
      await fs.writeFile(
        REPLY_FILE,
        JSON.stringify({ content: reply, timestamp: new Date().toISOString() }, null, 2),
        "utf-8",
      );
    }

    // 2) Block, polling the queue, until a message arrives (or we time out).
    const waitStart = Date.now();
    let nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL;

    while (!extra.signal.aborted) {
      const queue = await readQueue();
      if (queue.length > 0) {
        const results: ContentPart[] = [];
        for (const msg of queue) {
          const processed = await processMessage(msg);
          if (Array.isArray(processed)) results.push(...processed);
          else results.push(processed);
        }
        await clearQueue();

        // Append the loop-reminder suffix to the last text part.
        const last = results[results.length - 1];
        if (results.length > 0 && last.type === "text") {
          last.text += SYSTEM_SUFFIX;
        } else {
          results.push({ type: "text", text: SYSTEM_SUFFIX });
        }

        await appendServerLog("info", `check_messages delivered ${queue.length} queued item(s)`);
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
  },
);

/* ------------------------------------------------------------------ */
/* Tool: send_progress                                                 */
/* ------------------------------------------------------------------ */

server.tool(
  "send_progress",
  "Push current work progress to the remote console. During multi-step tasks, call this tool after each step. Optionally pass percent (0-100) to drive a progress bar in the panel. Returns immediately without waiting for messages.",
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
  },
  async ({ progress, percent }) => {
    await ensureDataDir();
    const payload: Record<string, unknown> = {
      content: progress,
      timestamp: new Date().toISOString(),
    };
    if (typeof percent === "number") payload.percent = Math.max(0, Math.min(100, Math.round(percent)));
    await fs.writeFile(REPLY_FILE, JSON.stringify(payload, null, 2), "utf-8");
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
  "Ask the user one or more questions and wait for answers. Supports single/multi-select and custom input. Blocks until the user responds.",
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
  },
  async ({ questions }, extra) => {
    await ensureDataDir();
    await appendServerLog("info", "ask_question started");

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
    await fs.writeFile(QUESTION_FILE, JSON.stringify(questionData, null, 2), "utf-8");
    try {
      await fs.unlink(ANSWER_FILE); // clear any stale answer
    } catch {
      // none present
    }

    // 2) Block, polling for the answer file (or time out).
    const waitStart = Date.now();
    let nextHeartbeatAt = Date.now() + HEARTBEAT_INTERVAL;

    while (!extra.signal.aborted) {
      try {
        const raw = await fs.readFile(ANSWER_FILE, "utf-8");
        const answerData = JSON.parse(raw);
        try { await fs.unlink(QUESTION_FILE); } catch {}
        try { await fs.unlink(ANSWER_FILE); } catch {}

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
  },
);

/* ------------------------------------------------------------------ */
/* Start: speak MCP over stdin/stdout                                  */
/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
