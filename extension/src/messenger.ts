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

const RULES_FILE_NAME = "mcp-messenger.mdc";
const LEGACY_RULES_FILE_NAME = "system.mdc";

export function setDataDir(dir: string): void {
  dataDir = dir;
  QUEUE_FILE = path.join(dir, "queue.json");
  QUESTION_FILE = path.join(dir, "question.json");
  ANSWER_FILE = path.join(dir, "answer.json");
  REPLY_FILE = path.join(dir, "reply.json");
  CARD_FILE = path.join(dir, "card.json");
  INJECTED_TOKEN_FILE = path.join(dir, "injected-token.json");
  HISTORY_FILE = path.join(dir, "history.json");
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
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2), "utf-8");
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
  const queue = readQueue();
  queue.push(item);
  writeQueue(queue);
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
  const queue = readQueue();
  queue.push(item);
  writeQueue(queue);
  return item;
}

export function sendFile(filePath: string): void {
  const queue = readQueue();
  queue.push({
    id: makeId(),
    type: "file",
    path: filePath,
    timestamp: new Date().toISOString(),
  });
  writeQueue(queue);
}

export function getQueueCount(): number {
  return readQueue().length;
}

export function deleteQueueItem(id: string): void {
  const queue = readQueue();
  writeQueue(queue.filter((item) => item.id !== id));
}

export function clearQueue(): void {
  writeQueue([]);
}

export function updateQueueItem(id: string, updates: { content?: string }): void {
  const queue = readQueue();
  const idx = queue.findIndex((item) => item.id === id);
  if (idx === -1) {
    return;
  }
  if (updates.content !== undefined && queue[idx].type === "text") {
    queue[idx].content = updates.content;
  }
  writeQueue(queue);
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
