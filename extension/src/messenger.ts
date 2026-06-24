import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Shared types ────────────────────────────────────────────────────────────

export type QueueItemType = "text" | "image" | "file";

export interface QueueItem {
  id: string;
  type: QueueItemType;
  content?: string;
  path?: string;
  caption?: string;
  timestamp: string;
}

export interface QuestionOption {
  id: string;
  label: string;
}

export interface QuestionItem {
  id: string;
  question: string;
  options: QuestionOption[];
  allow_multiple?: boolean;
}

export interface QuestionPayload {
  id: string;
  questions: QuestionItem[];
}

export interface AnswerItem {
  questionId: string;
  selected: string[];
  other: string;
}

export interface AnswerPayload {
  id: string;
  answers: AnswerItem[];
}

export interface ReplyPayload {
  content: string;
  timestamp?: string;
  /** Optional 0–100 progress percent (set by send_progress) for a progress bar. */
  percent?: number;
}

export interface CardState {
  code: string;
  expires_at?: string;
  activated_at?: string;
  duration_hours?: number;
}

export interface HistoryItem {
  id: string;
  type: QueueItemType;
  content?: string;
  path?: string;
  caption?: string;
  name?: string;
  timestamp: string;
  /** Optional inline image data (data: URL) so the panel can show a thumbnail
   *  for externally-originated image sends (e.g. pasted in the Obsidian plugin). */
  dataUrl?: string;
}

/** One entry in the shared chat history (sends from any front-end + AI replies). */
export interface SharedHistoryItem {
  id: string;
  kind: "text" | "image" | "file" | "reply";
  text?: string;
  caption?: string;
  name?: string;
  dataUrl?: string;
  path?: string;
  timestamp: string;
}

export interface CursorAuth {
  token: string;
  email: string;
}

export interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

// ── Data directory + file locations ─────────────────────────────────────────

const ROOT_DATA_DIR = path.join(os.homedir(), ".moyu-message");
let dataDir = process.env.MESSENGER_DATA_DIR || ROOT_DATA_DIR;
let QUEUE_FILE = path.join(dataDir, "queue.json");
let QUESTION_FILE = path.join(dataDir, "question.json");
let ANSWER_FILE = path.join(dataDir, "answer.json");
let REPLY_FILE = path.join(dataDir, "reply.json");
let CARD_FILE = path.join(dataDir, "card.json");
let INJECTED_TOKEN_FILE = path.join(dataDir, "injected-token.json");
let HISTORY_FILE = path.join(dataDir, "history.json");
let HEARTBEAT_FILE = path.join(dataDir, "agent-alive.json");
let QUEUE_LOCK_DIR = path.join(dataDir, "queue.lock");

const RULES_FILE_NAME = "mcp-messenger.mdc";
const LEGACY_RULES_FILE_NAME = "system.mdc";

function selectedAgentFile(): string {
  return path.join(dataDir, "selected-agent.json");
}

/** Read the agent id last chosen in the jefr panel Agent Picker. */
export function readSelectedAgentId(): string | undefined {
  const file = selectedAgentFile();
  if (!fs.existsSync(file)) {
    return undefined;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const id = typeof data.agentId === "string" ? sanitizeAgentId(data.agentId) : "";
    return id || undefined;
  } catch {
    return undefined;
  }
}

/** Persist the panel's Agent Picker choice so Obsidian/local-server stay in sync. */
export function writeSelectedAgentId(agentId?: string): void {
  ensureDir();
  const file = selectedAgentFile();
  if (!agentId) {
    try {
      fs.unlinkSync(file);
    } catch {
      // ignore
    }
    return;
  }
  fs.writeFileSync(
    file,
    JSON.stringify({ agentId: sanitizeAgentId(agentId), timestamp: new Date().toISOString() }),
    "utf-8"
  );
}

export function setDataDir(dir: string): void {
  dataDir = dir;
  QUEUE_FILE = path.join(dir, "queue.json");
  QUESTION_FILE = path.join(dir, "question.json");
  ANSWER_FILE = path.join(dir, "answer.json");
  REPLY_FILE = path.join(dir, "reply.json");
  CARD_FILE = path.join(dir, "card.json");
  INJECTED_TOKEN_FILE = path.join(dir, "injected-token.json");
  HISTORY_FILE = path.join(dir, "history.json");
  HEARTBEAT_FILE = path.join(dir, "agent-alive.json");
  QUEUE_LOCK_DIR = path.join(dir, "queue.lock");
}

// ── Cross-process queue lock + atomic writes ────────────────────────────────
// queue.json is read-modify-written by BOTH this extension (on send) and the
// separate MCP server process (on drain). Without coordination, a send landing
// between the MCP's read and its clear is silently lost. We guard every
// queue mutation with a directory-based lock (mkdir is atomic across processes).
// Writes are direct (not temp+rename): on Windows rename-over-existing throws
// EPERM when a reader has the file open, and since the lock already serializes
// writers and readers tolerate a transient partial (they fall back to []), a
// direct write with a short retry is the robust choice.

/** Synchronous sleep (no busy-spin) used while waiting for the queue lock. */
function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* fallback busy-wait */
    }
  }
}

/** Acquire the queue lock, returning false if it could not be taken in time.
 *  A lock older than 5s is treated as stale (crashed holder) and reclaimed. */
function acquireQueueLock(timeoutMs = 2000): boolean {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(QUEUE_LOCK_DIR);
      return true;
    } catch {
      try {
        const st = fs.statSync(QUEUE_LOCK_DIR);
        if (Date.now() - st.mtimeMs > 5000) {
          try {
            fs.rmdirSync(QUEUE_LOCK_DIR);
          } catch {
            // someone else reclaimed it; retry
          }
          continue;
        }
      } catch {
        // lock vanished between mkdir and stat; retry immediately
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        return false; // give up but let the caller proceed (best-effort)
      }
      sleepSync(8);
    }
  }
}

function releaseQueueLock(): void {
  try {
    fs.rmdirSync(QUEUE_LOCK_DIR);
  } catch {
    // already released
  }
}

/** Run `fn` while holding the queue lock (best-effort). */
function withQueueLock<T>(fn: () => T): T {
  ensureDir();
  const locked = acquireQueueLock();
  try {
    return fn();
  } finally {
    if (locked) {
      releaseQueueLock();
    }
  }
}

/** Write `data` directly, retrying briefly on transient Windows file locks
 *  (EPERM/EBUSY/EACCES from antivirus, indexers, or concurrent readers). */
function robustWriteFile(file: string, data: string): void {
  let lastErr: unknown;
  for (let i = 0; i < 10; i++) {
    try {
      fs.writeFileSync(file, data, "utf-8");
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") {
        throw e;
      }
      sleepSync(15);
    }
  }
  if (lastErr) {
    throw lastErr;
  }
}

// ── Agent liveness ──────────────────────────────────────────────────────────

export type AgentLivenessState = "waiting" | "working" | "idle";

export interface AgentStatus {
  /** True when a Cursor agent refreshed the heartbeat within the stale window. */
  alive: boolean;
  /** "waiting" = blocked in check_messages/ask_question listening for input;
   *  "working" = mid-task (send_progress); "idle" = no fresh heartbeat. */
  state: AgentLivenessState;
}

/** How long after the last agent heartbeat we still consider it alive. The MCP
 *  server refreshes the file roughly every 100ms while blocked, so a few
 *  seconds of grace comfortably survives brief stalls without lying for long. */
const AGENT_STALE_MS = 6000;

/** Read the agent heartbeat written by the MCP server and decide whether a
 *  real agent is currently running the perpetual loop. This is the signal the
 *  WebSocket connection state cannot provide. */
export function getAgentStatus(): AgentStatus {
  return getAgentStatusFor(undefined);
}

/** Read heartbeat for a specific agent (or the shared root when blank). */
export function getAgentStatusFor(agentId?: string): AgentStatus {
  const file = path.join(agentDirFor(agentId), "agent-alive.json");
  try {
    if (!fs.existsSync(file)) {
      return { alive: false, state: "idle" };
    }
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    const ts = typeof data.ts === "number" ? data.ts : 0;
    if (Date.now() - ts >= AGENT_STALE_MS) {
      return { alive: false, state: "idle" };
    }
    const state: AgentLivenessState = data.state === "working" ? "working" : "waiting";
    return { alive: true, state };
  } catch {
    return { alive: false, state: "idle" };
  }
}

// ── Shared chat history (sends from any front-end; rendered by all) ──────────

const HISTORY_CAP = 150;

export function readSharedHistory(): SharedHistoryItem[] {
  ensureDir();
  if (!fs.existsSync(HISTORY_FILE)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function appendSharedHistory(item: SharedHistoryItem): void {
  try {
    const hist = readSharedHistory();
    if (hist.some((existing) => existing.id === item.id)) {
      return;
    }
    hist.push(item);
    if (hist.length > HISTORY_CAP) {
      hist.splice(0, hist.length - HISTORY_CAP);
    }
    ensureDir();
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2), "utf-8");
  } catch {
    // history is best-effort
  }
}

export function appendReplyToSharedHistory(reply: ReplyPayload): void {
  if (!reply.content || typeof reply.percent === "number") {
    return;
  }
  const timestamp = reply.timestamp || new Date().toISOString();
  appendSharedHistory({
    id: "reply-" + timestamp,
    kind: "reply",
    text: reply.content,
    timestamp,
  });
}

export function clearSharedHistory(): void {
  try {
    fs.writeFileSync(HISTORY_FILE, "[]", "utf-8");
  } catch {
    // ignore
  }
}

export function migrateFromRootDir(): void {
  if (dataDir === ROOT_DATA_DIR) {
    return;
  }
  const rootCardFile = path.join(ROOT_DATA_DIR, "card.json");
  if (fs.existsSync(rootCardFile) && !fs.existsSync(CARD_FILE)) {
    ensureDir();
    fs.copyFileSync(rootCardFile, CARD_FILE);
  }
}

// Remote API is intentionally disabled in this build.
const API_BASE = "";
export const REMOTE_API_ENABLED = false;

function ensureDir(): void {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

export function makeId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ── Outgoing message queue ──────────────────────────────────────────────────

export function readQueue(): QueueItem[] {
  ensureDir();
  if (!fs.existsSync(QUEUE_FILE)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function writeQueue(items: QueueItem[]): void {
  ensureDir();
  robustWriteFile(QUEUE_FILE, JSON.stringify(items, null, 2));
}

export function formatHistoryTime(date: Date = new Date()): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}

// Optional sink used to mirror queued items into the webview history list.
// extension.ts registers this so messenger.ts stays free of any vscode imports.
let historySink: ((item: HistoryItem) => void) | null = null;

export function setHistorySink(fn: ((item: HistoryItem) => void) | null): void {
  historySink = fn;
}

export function pushHistoryItem(item: HistoryItem): void {
  historySink?.(item);
}

export function sendText(text: string): QueueItem {
  const item: QueueItem = {
    id: makeId(),
    type: "text",
    content: text,
    timestamp: new Date().toISOString(),
  };
  withQueueLock(() => {
    const queue = readQueue();
    queue.push(item);
    writeQueue(queue);
  });
  appendSharedHistory({ id: item.id, kind: "text", text, timestamp: item.timestamp });
  return item;
}

export function sendImage(filePath: string, caption?: string): QueueItem {
  const item: QueueItem = {
    id: makeId(),
    type: "image",
    path: filePath,
    caption,
    timestamp: new Date().toISOString(),
  };
  withQueueLock(() => {
    const queue = readQueue();
    queue.push(item);
    writeQueue(queue);
  });
  return item;
}

export function sendFile(filePath: string): void {
  withQueueLock(() => {
    const queue = readQueue();
    queue.push({
      id: makeId(),
      type: "file",
      path: filePath,
      timestamp: new Date().toISOString(),
    });
    writeQueue(queue);
  });
}

export function getQueueCount(): number {
  return readQueue().length;
}

export function deleteQueueItem(id: string): void {
  withQueueLock(() => {
    const queue = readQueue();
    writeQueue(queue.filter((item) => item.id !== id));
  });
}

export function clearQueue(): void {
  withQueueLock(() => writeQueue([]));
}

export function updateQueueItem(id: string, updates: { content?: string }): void {
  withQueueLock(() => {
    const queue = readQueue();
    const idx = queue.findIndex((item) => item.id === id);
    if (idx === -1) {
      return;
    }
    if (updates.content !== undefined && queue[idx].type === "text") {
      queue[idx].content = updates.content;
    }
    writeQueue(queue);
  });
}

// ── Questions / answers ─────────────────────────────────────────────────────

export function readQuestion(): QuestionPayload | null {
  if (!fs.existsSync(QUESTION_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(QUESTION_FILE, "utf-8"));
    return data && data.id && data.questions ? data : null;
  } catch {
    return null;
  }
}

export function writeAnswer(answer: AnswerPayload): void {
  ensureDir();
  fs.writeFileSync(ANSWER_FILE, JSON.stringify(answer, null, 2), "utf-8");
}

export function cancelQuestion(): void {
  const q = readQuestion();
  if (!q) {
    return;
  }
  const answers: AnswerItem[] = q.questions.map((qi, i) => ({
    questionId: qi.id,
    selected: [],
    other: i === 0 ? "User cancelled the answer" : "",
  }));
  writeAnswer({ id: q.id, answers });
}

// ── Replies ─────────────────────────────────────────────────────────────────

export function readReply(): ReplyPayload | null {
  if (!fs.existsSync(REPLY_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(REPLY_FILE, "utf-8"));
    return data && data.content ? data : null;
  } catch {
    return null;
  }
}

export function clearReply(): void {
  try {
    fs.unlinkSync(REPLY_FILE);
  } catch {
    // ignore
  }
}

// ── Multi-agent: per-agent partitioned state ────────────────────────────────
// A single MCP server process serves every agent tile in the window, so to
// address one agent we namespace its state under <dataDir>/agents/<agentId>/.
// These helpers mirror the root-scoped functions above but operate on a chosen
// agent's directory (a blank id falls back to the shared root, i.e. legacy).

const AGENTS_SUBDIR = "agents";

function sanitizeAgentId(agentId?: string): string {
  if (!agentId || typeof agentId !== "string") {
    return "";
  }
  return agentId.trim().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
}

/** Directory holding a given agent's files (or the shared root when blank). */
export function agentDirFor(agentId?: string): string {
  const id = sanitizeAgentId(agentId);
  return id ? path.join(dataDir, AGENTS_SUBDIR, id) : dataDir;
}

/** Delete an agent's on-disk dir entirely (queue/reply/question/heartbeat) so a
 *  forgotten tombstone stops being rediscovered. Never touches the shared root.
 *  Best-effort: cleanup must never throw. */
export function forgetAgentDir(agentId: string): void {
  const id = sanitizeAgentId(agentId);
  if (!id) {
    return;
  }
  try {
    fs.rmSync(path.join(dataDir, AGENTS_SUBDIR, id), {
      recursive: true,
      force: true,
    });
  } catch {
    // best-effort
  }
}

function ensureDirAt(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function acquireLockIn(lockDir: string, timeoutMs = 2000): boolean {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return true;
    } catch {
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > 5000) {
          try {
            fs.rmdirSync(lockDir);
          } catch {
            // reclaimed elsewhere
          }
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        return false;
      }
      sleepSync(8);
    }
  }
}

function withLockIn<T>(dir: string, fn: () => T): T {
  ensureDirAt(dir);
  const lockDir = path.join(dir, "queue.lock");
  const locked = acquireLockIn(lockDir);
  try {
    return fn();
  } finally {
    if (locked) {
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // already released
      }
    }
  }
}

function readJsonArrayAt(file: string): QueueItem[] {
  if (!fs.existsSync(file)) {
    return [];
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

export function readQueueFor(agentId?: string): QueueItem[] {
  const dir = agentDirFor(agentId);
  ensureDirAt(dir);
  return readJsonArrayAt(path.join(dir, "queue.json"));
}

function writeQueueFor(items: QueueItem[], agentId?: string): void {
  const dir = agentDirFor(agentId);
  ensureDirAt(dir);
  robustWriteFile(path.join(dir, "queue.json"), JSON.stringify(items, null, 2));
}

export function getQueueCountFor(agentId?: string): number {
  return readQueueFor(agentId).length;
}

/** Queue a text send to a specific agent (or the shared root). Mirrored into
 *  the shared history so the panel still renders the bubble. */
export function sendTextTo(agentId: string | undefined, text: string): QueueItem {
  const item: QueueItem = {
    id: makeId(),
    type: "text",
    content: text,
    timestamp: new Date().toISOString(),
  };
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path.join(dir, "queue.json"));
    queue.push(item);
    robustWriteFile(path.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
  appendSharedHistory({ id: item.id, kind: "text", text, timestamp: item.timestamp });
  return item;
}

export function sendImageTo(
  agentId: string | undefined,
  filePath: string,
  caption?: string
): QueueItem {
  const item: QueueItem = {
    id: makeId(),
    type: "image",
    path: filePath,
    caption,
    timestamp: new Date().toISOString(),
  };
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path.join(dir, "queue.json"));
    queue.push(item);
    robustWriteFile(path.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
  return item;
}

export function sendFileTo(agentId: string | undefined, filePath: string): void {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path.join(dir, "queue.json"));
    queue.push({
      id: makeId(),
      type: "file",
      path: filePath,
      timestamp: new Date().toISOString(),
    });
    robustWriteFile(path.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
}

export function deleteQueueItemFor(id: string, agentId?: string): void {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path.join(dir, "queue.json"));
    robustWriteFile(
      path.join(dir, "queue.json"),
      JSON.stringify(queue.filter((it) => it.id !== id), null, 2)
    );
  });
}

export function clearQueueFor(agentId?: string): void {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => writeQueueFor([], agentId));
}

export function updateQueueItemFor(
  id: string,
  updates: { content?: string },
  agentId?: string
): void {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path.join(dir, "queue.json"));
    const idx = queue.findIndex((it) => it.id === id);
    if (idx === -1) {
      return;
    }
    if (updates.content !== undefined && queue[idx].type === "text") {
      queue[idx].content = updates.content;
    }
    robustWriteFile(path.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
}

export function readReplyFor(agentId?: string): ReplyPayload | null {
  const file = path.join(agentDirFor(agentId), "reply.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data && data.content ? data : null;
  } catch {
    return null;
  }
}

export function clearReplyFor(agentId?: string): void {
  try {
    fs.unlinkSync(path.join(agentDirFor(agentId), "reply.json"));
  } catch {
    // ignore
  }
}

export function readQuestionFor(agentId?: string): QuestionPayload | null {
  const file = path.join(agentDirFor(agentId), "question.json");
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return data && data.id && data.questions ? data : null;
  } catch {
    return null;
  }
}

export function writeAnswerFor(answer: AnswerPayload, agentId?: string): void {
  const dir = agentDirFor(agentId);
  ensureDirAt(dir);
  fs.writeFileSync(path.join(dir, "answer.json"), JSON.stringify(answer, null, 2), "utf-8");
}

export function cancelQuestionFor(agentId?: string): void {
  const q = readQuestionFor(agentId);
  if (!q) {
    return;
  }
  const answers: AnswerItem[] = q.questions.map((qi, i) => ({
    questionId: qi.id,
    selected: [],
    other: i === 0 ? "User cancelled the answer" : "",
  }));
  writeAnswerFor({ id: q.id, answers }, agentId);
}

export interface LiveAgent {
  id: string;
  state: AgentLivenessState;
  ts: number;
  queueCount: number;
}

/** Scan <dataDir>/agents/* for agents whose heartbeat is fresh. This is how the
 *  panel discovers which agents are currently looping and addressable. */
export function listLiveAgents(maxAgeMs = AGENT_STALE_MS): LiveAgent[] {
  const root = path.join(dataDir, AGENTS_SUBDIR);
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: LiveAgent[] = [];
  for (const id of ids) {
    const beat = path.join(root, id, "agent-alive.json");
    try {
      const data = JSON.parse(fs.readFileSync(beat, "utf-8"));
      const ts = typeof data.ts === "number" ? data.ts : 0;
      if (Date.now() - ts > maxAgeMs) {
        continue;
      }
      const state: AgentLivenessState = data.state === "working" ? "working" : "waiting";
      out.push({ id, state, ts, queueCount: getQueueCountFor(id) });
    } catch {
      // skip unreadable/partial heartbeat
    }
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

export interface AgentRosterEntry {
  id: string;
  /** Fresh heartbeat within the stale window. */
  connected: boolean;
  state: AgentLivenessState;
  ts: number;
  queueCount: number;
}

/** Scan every agents/<id>/ directory — including ones whose heartbeat has gone
 *  stale (dropped) — so the manager can show connected AND disconnected agents
 *  and drive auto-reconnect. */
export function scanAllAgents(maxAgeMs = AGENT_STALE_MS): AgentRosterEntry[] {
  const root = path.join(dataDir, AGENTS_SUBDIR);
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: AgentRosterEntry[] = [];
  for (const id of ids) {
    const dir = path.join(root, id);
    try {
      if (!fs.statSync(dir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    let ts = 0;
    let beatState: AgentLivenessState = "idle";
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, "agent-alive.json"), "utf-8"));
      ts = typeof data.ts === "number" ? data.ts : 0;
      beatState = data.state === "working" ? "working" : "waiting";
    } catch {
      // no/partial heartbeat — treat as disconnected
    }
    const connected = ts > 0 && Date.now() - ts <= maxAgeMs;
    out.push({
      id,
      connected,
      state: connected ? beatState : "idle",
      ts,
      queueCount: getQueueCountFor(id),
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

// ── License card state (local build: always valid) ──────────────────────────

export function readCardState(): CardState | null {
  ensureDir();
  if (!fs.existsSync(CARD_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(CARD_FILE, "utf-8"));
    return data && data.code ? data : null;
  } catch {
    return null;
  }
}

export function writeCardState(state: CardState): void {
  ensureDir();
  fs.writeFileSync(CARD_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function clearCardState(): void {
  try {
    fs.unlinkSync(CARD_FILE);
  } catch {
    // ignore
  }
}

// ── Remote API (disabled stubs) ─────────────────────────────────────────────

function apiRequest<T = unknown>(_endpoint: string, _body: unknown): Promise<ApiResponse<T>> {
  return Promise.resolve({ success: false, error: "remote API disabled" });
}

export async function activateCard(
  _code: string,
  _machineId?: string
): Promise<ApiResponse<CardState>> {
  return {
    success: true,
    data: {
      code: "",
      expires_at: "",
      activated_at: new Date().toISOString(),
      duration_hours: 0,
    },
  };
}

export function isCardValid(): boolean {
  return true;
}

export async function pollRemoteMessages(
  cardCode: string,
  workspace?: string
): Promise<QueueItem[]> {
  try {
    const resp = await apiRequest<QueueItem[]>("/mcp-cards/remote-poll", {
      code: cardCode,
      workspace: workspace || "",
    });
    if (resp.success && Array.isArray(resp.data)) {
      return resp.data;
    }
    return [];
  } catch {
    return [];
  }
}

export async function pushRemoteReply(
  cardCode: string,
  content: string,
  workspace?: string
): Promise<boolean> {
  try {
    const resp = await apiRequest("/mcp-cards/remote-reply", {
      code: cardCode,
      content,
      workspace: workspace || null,
    });
    return !!resp.success;
  } catch {
    return false;
  }
}

export async function sendWorkspaceHeartbeat(
  cardCode: string,
  workspaceName: string,
  workspacePath?: string
): Promise<void> {
  try {
    await apiRequest("/mcp-cards/workspace-heartbeat", {
      code: cardCode,
      workspace_name: workspaceName,
      workspace_path: workspacePath || null,
    });
  } catch {
    // ignore
  }
}

export async function pushRemoteQuestion(
  cardCode: string,
  questionId: string,
  questions: QuestionItem[],
  workspace?: string
): Promise<boolean> {
  try {
    const resp = await apiRequest("/mcp-cards/remote-question", {
      code: cardCode,
      question_id: questionId,
      questions,
      workspace: workspace || null,
    });
    return !!resp.success;
  } catch {
    return false;
  }
}

export async function cancelRemoteQuestion(
  cardCode: string,
  questionId?: string
): Promise<boolean> {
  try {
    const resp = await apiRequest("/mcp-cards/remote-cancel-question", {
      code: cardCode,
      question_id: questionId || null,
    });
    return !!resp.success;
  } catch {
    return false;
  }
}

export async function pollRemoteAnswer(
  cardCode: string,
  questionId: string
): Promise<{ answered?: boolean; answer?: AnswerPayload } | null> {
  try {
    const resp = await apiRequest<{ answered?: boolean; answer?: AnswerPayload }>(
      "/mcp-cards/remote-poll-answer",
      { code: cardCode, question_id: questionId }
    );
    if (resp.success && resp.data) {
      return resp.data;
    }
    return null;
  } catch {
    return null;
  }
}

// ── Cursor auth / usage ─────────────────────────────────────────────────────

function getCursorConfigDir(): string {
  switch (process.platform) {
    case "win32":
      return path.join(
        process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
        "Cursor"
      );
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Cursor");
    default:
      return path.join(os.homedir(), ".config", "Cursor");
  }
}

function readVscdbViaSqlite(dbPath: string): CursorAuth | null {
  try {
    // node:sqlite is experimental and may be unavailable; fall back below.
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tokenRow = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("cursorAuth/accessToken");
    const emailRow = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get("cursorAuth/cachedEmail");
    db.close();
    if (tokenRow?.value) {
      return { token: tokenRow.value, email: emailRow?.value || "" };
    }
  } catch {
    // ignore, try subprocess fallback
  }
  try {
    const { execSync } = require("child_process");
    const escaped = dbPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const script = `const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync('${escaped}',{readOnly:true});const t=db.prepare("SELECT value FROM ItemTable WHERE key=?").get("cursorAuth/accessToken");const e=db.prepare("SELECT value FROM ItemTable WHERE key=?").get("cursorAuth/cachedEmail");db.close();console.log(JSON.stringify({t:t?.value||"",e:e?.value||""}))`;
    const out = execSync(`node --disable-warning=ExperimentalWarning -e "${script}"`, {
      encoding: "utf-8",
      timeout: 10000,
      windowsHide: true,
    }).trim();
    const parsed = JSON.parse(out);
    if (parsed.t) {
      return { token: parsed.t, email: parsed.e || "" };
    }
  } catch {
    // ignore
  }
  return null;
}

function readCursorAuth(): CursorAuth | null {
  const gsDir = path.join(getCursorConfigDir(), "User", "globalStorage");
  const dbPath = path.join(gsDir, "state.vscdb");
  if (fs.existsSync(dbPath)) {
    const result = readVscdbViaSqlite(dbPath);
    if (result) {
      return result;
    }
  }
  const jsonPath = path.join(gsDir, "storage.json");
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const token = data["cursorAuth/accessToken"];
      if (token) {
        return { token, email: data["cursorAuth/cachedEmail"] || "" };
      }
    } catch {
      // ignore
    }
  }
  const authPath = path.join(gsDir, "cursor.auth.json");
  if (fs.existsSync(authPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      if (data.token) {
        return { token: data.token, email: data.email || "" };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export function readInjectedToken(): { token: string } | null {
  ensureDir();
  if (!fs.existsSync(INJECTED_TOKEN_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs.readFileSync(INJECTED_TOKEN_FILE, "utf-8"));
    return data && data.token ? data : null;
  } catch {
    return null;
  }
}

export function writeInjectedToken(token: string): void {
  ensureDir();
  fs.writeFileSync(INJECTED_TOKEN_FILE, JSON.stringify({ token }, null, 2), "utf-8");
}

export function clearInjectedToken(): void {
  try {
    fs.unlinkSync(INJECTED_TOKEN_FILE);
  } catch {
    // ignore
  }
}

function getEffectiveAuth(): CursorAuth | null {
  const injected = readInjectedToken();
  if (injected) {
    return { token: injected.token, email: "" };
  }
  return readCursorAuth();
}

export interface UsageResult {
  success: boolean;
  error?: string;
  email?: string;
  membershipType?: string;
  isUnlimited?: boolean;
  usagePct?: number | null;
  planUsed?: number;
  planLimit?: number;
  onDemandUsed?: number;
  billingCycleStart?: string;
  billingCycleEnd?: string;
  displayMessage?: string;
  totalCost?: number;
  eventsCount?: number;
  models?: unknown[];
}

export async function fetchCursorUsage(): Promise<UsageResult> {
  const auth = getEffectiveAuth();
  if (!auth) {
    return { success: false, error: "Cursor login not detected" };
  }
  return {
    success: true,
    email: auth.email || "",
    membershipType: "local",
    isUnlimited: true,
    usagePct: null,
    planUsed: 0,
    planLimit: undefined,
    onDemandUsed: 0,
    billingCycleStart: "",
    billingCycleEnd: "",
    displayMessage: "",
    totalCost: 0,
    eventsCount: 0,
    models: [],
  };
}

// ── MCP config installation ─────────────────────────────────────────────────

function getMcpServerPath(): string {
  const extDir = path.dirname(path.dirname(__filename));
  return path.join(extDir, "dist", "mcp-server.mjs");
}

function getGlobalMcpJsonPath(): string {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

function applyMcpServerEntry(config: McpConfig, messengerDataDir?: string): McpConfig {
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  // Remove any previously named entries before reinstalling.
  delete config.mcpServers["moyu-message"];
  delete config.mcpServers["jefr cursor"];
  delete config.mcpServers["jefr"];

  const mcpServerConfig: McpServerEntry = {
    command: "node",
    args: [getMcpServerPath()],
  };
  if (messengerDataDir) {
    mcpServerConfig.env = { MESSENGER_DATA_DIR: messengerDataDir };
  }
  config.mcpServers["jefr"] = mcpServerConfig;
  return config;
}

export function setupGlobalMcpConfig(messengerDataDir?: string): boolean {
  const mcpJsonPath = getGlobalMcpJsonPath();
  const cursorDir = path.dirname(mcpJsonPath);
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }
  const previousContent = fs.existsSync(mcpJsonPath)
    ? fs.readFileSync(mcpJsonPath, "utf-8")
    : "";
  let config: McpConfig = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(previousContent);
    } catch {
      // ignore malformed config, overwrite
    }
  }
  applyMcpServerEntry(config, messengerDataDir);
  const nextContent = JSON.stringify(config, null, 2);
  if (nextContent !== previousContent) {
    fs.writeFileSync(mcpJsonPath, nextContent, "utf-8");
    return true;
  }
  return false;
}

export function setupMcpConfig(workspaceFolder: string, messengerDataDir?: string): boolean {
  const cursorDir = path.join(workspaceFolder, ".cursor");
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }
  const mcpJsonPath = path.join(cursorDir, "mcp.json");
  const previousContent = fs.existsSync(mcpJsonPath)
    ? fs.readFileSync(mcpJsonPath, "utf-8")
    : "";
  let config: McpConfig = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(previousContent);
    } catch {
      // ignore malformed config, overwrite
    }
  }
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  applyMcpServerEntry(config, messengerDataDir);
  const nextContent = JSON.stringify(config, null, 2);
  let changed = false;
  if (nextContent !== previousContent) {
    fs.writeFileSync(mcpJsonPath, nextContent, "utf-8");
    changed = true;
  }
  if (setupCursorRules(workspaceFolder)) {
    changed = true;
  }
  return changed;
}

export function removeMcpConfig(workspaceFolder: string): boolean {
  const mcpJsonPath = path.join(workspaceFolder, ".cursor", "mcp.json");
  let removed = false;
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const config: McpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (!config.mcpServers) {
        config.mcpServers = {};
      }
      const keys = ["jefr", "jefr cursor", "moyu-message"];
      for (const key of keys) {
        if (config.mcpServers[key]) {
          delete config.mcpServers[key];
          removed = true;
        }
      }
      if (removed) {
        fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), "utf-8");
      }
    } catch {
      // ignore
    }
  }
  if (removeCursorRules(workspaceFolder)) {
    removed = true;
  }
  return removed;
}

// ── Cursor rules (.cursor/rules/mcp-messenger.mdc) ──────────────────────────

const RULES_CONTENT = `---
description: Automatically call Messenger MCP to check for pending messages
globs: "**/*"
alwaysApply: true
---

# MCP tool usage rules

1. After each conversation turn is **fully output**, the last step must call \`check_messages\`. Applies to Agent/Plan/Debug/Ask modes with no exceptions.
2. \`check_messages\` blocks until the user sends a new message; process it, reply, then call \`check_messages\` again — perpetual loop: reply → check_messages → receive message → reply → check_messages.
3. Never call \`check_messages\` at the start of a turn or before the reply is complete. Only exception: the user explicitly asks to end the conversation.
4. After writing a plan (Plan), finishing analysis (Debug), or answering a question (Ask), do not end the turn — call \`check_messages\` and wait for user feedback.
5. When the user must choose or confirm (pick a plan, framework, approve an action, etc.), call \`ask_question\`. Do not use Cursor's built-in ask_user_question.
6. \`ask_question\` format: \`{ "questions": [{ "question": "Question text", "options": [{ "id": "a", "label": "Option A" }, { "id": "b", "label": "Option B" }], "allow_multiple": false }] }\`
7. Single-select: \`allow_multiple: false\`; multi-select: \`allow_multiple: true\`; one \`questions\` array may mix both.
8. Users may add custom text (Other field) on each question; no extra option needed for that.
9. After \`ask_question\` returns an answer, still call \`check_messages\` to keep listening.
10. Do not use \`ask_question\` at the end of every turn to ask "anything else?"; end turns with \`check_messages\` only. Use \`ask_question\` only when a real decision is needed.
11. \`check_messages\` accepts optional \`reply\` (string, Markdown): summary shown in the plugin modal. Example: \`{ "reply": "## Summary\nChanges complete..." }\`
12. Before ending a session, prefer passing \`reply\` with key conclusions; omit \`reply\` if no summary is needed.
13. Do not spawn subagents for parallel tasks.
14. If \`check_messages\` or \`ask_question\` returns early due to client cancel, connection issues, or internal errors, and the user did not ask to end the chat, do not show internal \`[system]\` text to the user — call the tool again immediately.
15. During multi-step work, after each key step call \`send_progress\` with a summary. Example: \`{ "progress": "## Step 1 complete\nUpdated xxx file..." }\`. \`send_progress\` returns immediately; continue to the next step.
16. \`progress\` should include: what was done, current approach, next step. Use concise Markdown.

---
**End of turn (mandatory)**: Only after the reply is **fully complete**, the last step must call the jefr MCP \`check_messages\` tool (CallMcpTool, server identifier for jefr, toolName \`check_messages\`, arguments \`{}\`). Never call it at the start of a turn or before the reply is done. Use \`ask_question\` only when the user must make a choice during the task (e.g. pick a framework or plan).`;

function setupCursorRules(workspaceFolder: string): boolean {
  const rulesDir = path.join(workspaceFolder, ".cursor", "rules");
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
  const currentRulesPath = path.join(rulesDir, RULES_FILE_NAME);
  let changed = false;
  const previousRulesContent = fs.existsSync(currentRulesPath)
    ? fs.readFileSync(currentRulesPath, "utf-8")
    : "";
  if (previousRulesContent !== RULES_CONTENT) {
    fs.writeFileSync(currentRulesPath, RULES_CONTENT, "utf-8");
    changed = true;
  }
  const legacyRulesPath = path.join(rulesDir, LEGACY_RULES_FILE_NAME);
  if (removeLegacyRulesIfManaged(legacyRulesPath)) {
    changed = true;
  }
  return changed;
}

function removeCursorRules(workspaceFolder: string): boolean {
  const rulesDir = path.join(workspaceFolder, ".cursor", "rules");
  let removed = false;
  const currentRulesPath = path.join(rulesDir, RULES_FILE_NAME);
  if (fs.existsSync(currentRulesPath)) {
    fs.unlinkSync(currentRulesPath);
    removed = true;
  }
  const legacyRulesPath = path.join(rulesDir, LEGACY_RULES_FILE_NAME);
  if (removeLegacyRulesIfManaged(legacyRulesPath)) {
    removed = true;
  }
  return removed;
}

function removeLegacyRulesIfManaged(filePath: string): boolean {
  if (!fs.existsSync(filePath)) {
    return false;
  }
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    if (content === RULES_CONTENT) {
      fs.unlinkSync(filePath);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
