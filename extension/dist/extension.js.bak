"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"));
var path2 = __toESM(require("path"));
var fs2 = __toESM(require("fs"));
var os2 = __toESM(require("os"));
var crypto2 = __toESM(require("crypto"));

// src/messenger.ts
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var os = __toESM(require("os"));
var https = __toESM(require("https"));
var http = __toESM(require("http"));
var ROOT_DATA_DIR = path.join(os.homedir(), ".moyu-message");
var dataDir = process.env.MESSENGER_DATA_DIR || ROOT_DATA_DIR;
var QUEUE_FILE = path.join(dataDir, "queue.json");
var QUESTION_FILE = path.join(dataDir, "question.json");
var ANSWER_FILE = path.join(dataDir, "answer.json");
var REPLY_FILE = path.join(dataDir, "reply.json");
var CARD_FILE = path.join(dataDir, "card.json");
var INJECTED_TOKEN_FILE = path.join(dataDir, "injected-token.json");
var RULES_FILE_NAME = "mcp-messenger.mdc";
var LEGACY_RULES_FILE_NAME = "system.mdc";
function setDataDir(dir) {
  dataDir = dir;
  QUEUE_FILE = path.join(dir, "queue.json");
  QUESTION_FILE = path.join(dir, "question.json");
  ANSWER_FILE = path.join(dir, "answer.json");
  REPLY_FILE = path.join(dir, "reply.json");
  CARD_FILE = path.join(dir, "card.json");
  INJECTED_TOKEN_FILE = path.join(dir, "injected-token.json");
}
function migrateFromRootDir() {
  if (dataDir === ROOT_DATA_DIR)
    return;
  const rootCardFile = path.join(ROOT_DATA_DIR, "card.json");
  if (fs.existsSync(rootCardFile) && !fs.existsSync(CARD_FILE)) {
    ensureDir();
    fs.copyFileSync(rootCardFile, CARD_FILE);
  }
}
var API_BASE = "";
var REMOTE_API_ENABLED = false;
function ensureDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function readQueue() {
  ensureDir();
  if (!fs.existsSync(QUEUE_FILE))
    return [];
  try {
    const data = JSON.parse(fs.readFileSync(QUEUE_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function writeQueue(items) {
  ensureDir();
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(items, null, 2), "utf-8");
}
function formatHistoryTime(date = new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}
function pushHistoryItem(item) {
  mainPanel?.webview.postMessage({ type: "historyAppend", item });
}
function sendText(text) {
  const queue = readQueue();
  queue.push({
    id: makeId(),
    type: "text",
    content: text,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
  writeQueue(queue);
}
function sendImage(filePath, caption) {
  const queue = readQueue();
  queue.push({
    id: makeId(),
    type: "image",
    path: filePath,
    caption,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
  writeQueue(queue);
}
function sendFile(filePath) {
  const queue = readQueue();
  queue.push({
    id: makeId(),
    type: "file",
    path: filePath,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
  writeQueue(queue);
}
function getQueueCount() {
  return readQueue().length;
}
function deleteQueueItem(id) {
  const queue = readQueue();
  writeQueue(queue.filter((item) => item.id !== id));
}
function clearQueue() {
  writeQueue([]);
}
function updateQueueItem(id, updates) {
  const queue = readQueue();
  const idx = queue.findIndex((item) => item.id === id);
  if (idx === -1)
    return;
  if (updates.content !== void 0 && queue[idx].type === "text") {
    queue[idx].content = updates.content;
  }
  writeQueue(queue);
}
function readQuestion() {
  if (!fs.existsSync(QUESTION_FILE))
    return null;
  try {
    const data = JSON.parse(fs.readFileSync(QUESTION_FILE, "utf-8"));
    return data && data.id && data.questions ? data : null;
  } catch {
    return null;
  }
}
function writeAnswer(answer) {
  ensureDir();
  fs.writeFileSync(ANSWER_FILE, JSON.stringify(answer, null, 2), "utf-8");
}
function cancelQuestion() {
  const q = readQuestion();
  if (!q)
    return;
  const answers = q.questions.map((qi, i) => ({
    questionId: qi.id,
    selected: [],
    other: i === 0 ? "User cancelled the answer" : ""
  }));
  writeAnswer({ id: q.id, answers });
}
function readReply() {
  if (!fs.existsSync(REPLY_FILE))
    return null;
  try {
    const data = JSON.parse(fs.readFileSync(REPLY_FILE, "utf-8"));
    return data && data.content ? data : null;
  } catch {
    return null;
  }
}
function clearReply() {
  try {
    fs.unlinkSync(REPLY_FILE);
  } catch {
  }
}
function readCardState() {
  ensureDir();
  if (!fs.existsSync(CARD_FILE))
    return null;
  try {
    const data = JSON.parse(fs.readFileSync(CARD_FILE, "utf-8"));
    return data && data.code ? data : null;
  } catch {
    return null;
  }
}
function writeCardState(state) {
  ensureDir();
  fs.writeFileSync(CARD_FILE, JSON.stringify(state, null, 2), "utf-8");
}
function clearCardState() {
  try {
    fs.unlinkSync(CARD_FILE);
  } catch {
  }
}
function apiRequest(endpoint, body) {
  return Promise.resolve({ success: false, error: "remote API disabled" });
}
async function activateCard(code, machineId) {
  return { success: true, data: { code: "", expires_at: "", activated_at: (/* @__PURE__ */ new Date()).toISOString(), duration_hours: 0 } };
}
function isCardValid() {
  return true;
}
async function pollRemoteMessages(cardCode, workspace2) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-poll", { code: cardCode, workspace: workspace2 || "" });
    if (resp.success && Array.isArray(resp.data))
      return resp.data;
    return [];
  } catch {
    return [];
  }
}
async function pushRemoteReply(cardCode, content, workspace2) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-reply", { code: cardCode, content, workspace: workspace2 || null });
    return !!resp.success;
  } catch {
    return false;
  }
}
async function sendWorkspaceHeartbeat(cardCode, workspaceName, workspacePath) {
  try {
    await apiRequest("/mcp-cards/workspace-heartbeat", {
      code: cardCode,
      workspace_name: workspaceName,
      workspace_path: workspacePath || null
    });
  } catch {
  }
}
async function pushRemoteQuestion(cardCode, questionId, questions, workspace2) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-question", {
      code: cardCode,
      question_id: questionId,
      questions,
      workspace: workspace2 || null
    });
    return !!resp.success;
  } catch {
    return false;
  }
}
async function cancelRemoteQuestion(cardCode, questionId) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-cancel-question", {
      code: cardCode,
      question_id: questionId || null
    });
    return !!resp.success;
  } catch {
    return false;
  }
}
async function pollRemoteAnswer(cardCode, questionId) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-poll-answer", {
      code: cardCode,
      question_id: questionId
    });
    if (resp.success && resp.data)
      return resp.data;
    return null;
  } catch {
    return null;
  }
}
function getCursorConfigDir() {
  switch (process.platform) {
    case "win32":
      return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Cursor");
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support", "Cursor");
    default:
      return path.join(os.homedir(), ".config", "Cursor");
  }
}
function readVscdbViaSqlite(dbPath) {
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tokenRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
    const emailRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/cachedEmail");
    db.close();
    if (tokenRow?.value)
      return { token: tokenRow.value, email: emailRow?.value || "" };
  } catch {
  }
  try {
    const { execSync } = require("child_process");
    const escaped = dbPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const script = `const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync('${escaped}',{readOnly:true});const t=db.prepare("SELECT value FROM ItemTable WHERE key=?").get("cursorAuth/accessToken");const e=db.prepare("SELECT value FROM ItemTable WHERE key=?").get("cursorAuth/cachedEmail");db.close();console.log(JSON.stringify({t:t?.value||"",e:e?.value||""}))`;
    const out = execSync(`node --disable-warning=ExperimentalWarning -e "${script}"`, {
      encoding: "utf-8",
      timeout: 1e4,
      windowsHide: true
    }).trim();
    const parsed = JSON.parse(out);
    if (parsed.t)
      return { token: parsed.t, email: parsed.e || "" };
  } catch {
  }
  return null;
}
function readCursorAuth() {
  const gsDir = path.join(getCursorConfigDir(), "User", "globalStorage");
  const dbPath = path.join(gsDir, "state.vscdb");
  if (fs.existsSync(dbPath)) {
    const result = readVscdbViaSqlite(dbPath);
    if (result)
      return result;
  }
  const jsonPath = path.join(gsDir, "storage.json");
  if (fs.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const token = data["cursorAuth/accessToken"];
      if (token)
        return { token, email: data["cursorAuth/cachedEmail"] || "" };
    } catch {
    }
  }
  const authPath = path.join(gsDir, "cursor.auth.json");
  if (fs.existsSync(authPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(authPath, "utf-8"));
      if (data.token)
        return { token: data.token, email: data.email || "" };
    } catch {
    }
  }
  return null;
}
function readInjectedToken() {
  ensureDir();
  if (!fs.existsSync(INJECTED_TOKEN_FILE))
    return null;
  try {
    const data = JSON.parse(fs.readFileSync(INJECTED_TOKEN_FILE, "utf-8"));
    return data && data.token ? data : null;
  } catch {
    return null;
  }
}
function writeInjectedToken(token) {
  ensureDir();
  fs.writeFileSync(INJECTED_TOKEN_FILE, JSON.stringify({ token }, null, 2), "utf-8");
}
function clearInjectedToken() {
  try {
    fs.unlinkSync(INJECTED_TOKEN_FILE);
  } catch {
  }
}
function getEffectiveAuth() {
  const injected = readInjectedToken();
  if (injected)
    return { token: injected.token, email: "" };
  return readCursorAuth();
}
async function fetchCursorUsage() {
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
      planLimit: void 0,
      onDemandUsed: 0,
      billingCycleStart: "",
      billingCycleEnd: "",
      displayMessage: "",
      totalCost: 0,
      eventsCount: 0,
      models: []
    };
}
function getMcpServerPath() {
  const extDir = path.dirname(path.dirname(__filename));
  return path.join(extDir, "dist", "mcp-server.mjs");
}
function getGlobalMcpJsonPath() {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}
function applyMcpServerEntry(config, messengerDataDir) {
  if (!config.mcpServers)
    config.mcpServers = {};
  if (config.mcpServers["moyu-message"]) {
    delete config.mcpServers["moyu-message"];
  }
  if (config.mcpServers["jefr cursor"]) {
    delete config.mcpServers["jefr cursor"];
  }
  if (config.mcpServers["jefr"]) {
    delete config.mcpServers["jefr"];
  }
  const mcpServerConfig = {
    command: "node",
    args: [getMcpServerPath()]
  };
  if (messengerDataDir) {
    mcpServerConfig.env = { MESSENGER_DATA_DIR: messengerDataDir };
  }
  config.mcpServers["jefr"] = mcpServerConfig;
  return config;
}
function setupGlobalMcpConfig(messengerDataDir) {
  const mcpJsonPath = getGlobalMcpJsonPath();
  const cursorDir = path.dirname(mcpJsonPath);
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }
  const previousContent = fs.existsSync(mcpJsonPath) ? fs.readFileSync(mcpJsonPath, "utf-8") : "";
  let config = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(previousContent);
    } catch {
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
function setupMcpConfig(workspaceFolder, messengerDataDir) {
  const cursorDir = path.join(workspaceFolder, ".cursor");
  if (!fs.existsSync(cursorDir)) {
    fs.mkdirSync(cursorDir, { recursive: true });
  }
  const mcpJsonPath = path.join(cursorDir, "mcp.json");
  const previousContent = fs.existsSync(mcpJsonPath) ? fs.readFileSync(mcpJsonPath, "utf-8") : "";
  let config = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(previousContent);
    } catch {
    }
  }
  if (!config.mcpServers)
    config.mcpServers = {};
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
function removeMcpConfig(workspaceFolder) {
  const mcpJsonPath = path.join(workspaceFolder, ".cursor", "mcp.json");
  let removed = false;
  if (fs.existsSync(mcpJsonPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(mcpJsonPath, "utf-8"));
      if (!config.mcpServers)
        config.mcpServers = {};
      const keys = ["jefr", "jefr cursor", "moyu-message"];
      for (const key of keys) {
        if (config.mcpServers[key]) {
          delete config.mcpServers[key];
          removed = true;
        }
      }
      if (removed) {
        fs.writeFileSync(
          mcpJsonPath,
          JSON.stringify(config, null, 2),
          "utf-8"
        );
      }
    } catch {
    }
  }
  if (removeCursorRules(workspaceFolder)) {
    removed = true;
  }
  return removed;
}
var RULES_CONTENT = `---
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
function setupCursorRules(workspaceFolder) {
  const rulesDir = path.join(workspaceFolder, ".cursor", "rules");
  if (!fs.existsSync(rulesDir)) {
    fs.mkdirSync(rulesDir, { recursive: true });
  }
  const currentRulesPath = path.join(rulesDir, RULES_FILE_NAME);
  let changed = false;
  const previousRulesContent = fs.existsSync(currentRulesPath) ? fs.readFileSync(currentRulesPath, "utf-8") : "";
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
function removeCursorRules(workspaceFolder) {
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
function removeLegacyRulesIfManaged(filePath) {
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

// src/local-server.ts
var http2 = __toESM(require("http"));
var crypto = __toESM(require("crypto"));
var WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
var PREFERRED_PORT = 39517;
var server = null;
var wsClients = [];
var serverPort = 0;
var pollTimer = null;
var lastPushState = "";
var _workspaceInfo = { name: "", path: "" };
function setWorkspaceInfo(name, wsPath) {
  _workspaceInfo = { name, path: wsPath };
}
function getServerPort() {
  return serverPort;
}
function getConnectedClients() {
  return wsClients.length;
}
function startLocalServer(port = PREFERRED_PORT) {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(serverPort);
      return;
    }
    let settled = false;
    const srv = http2.createServer(handleHttp);
    srv.on("upgrade", handleUpgrade);
    srv.on("error", (err) => {
      if (settled)
        return;
      settled = true;
      try {
        srv.close();
      } catch {
      }
      if (err && err.code === "EADDRINUSE" && port !== 0) {
        startLocalServer(0).then(resolve, reject);
      } else {
        reject(err);
      }
    });
    srv.listen(port, "127.0.0.1", () => {
      if (settled)
        return;
      settled = true;
      server = srv;
      serverPort = srv.address().port;
      startPushPolling();
      resolve(serverPort);
    });
  });
}
function stopLocalServer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const c of wsClients) {
    try {
      c.socket.destroy();
    } catch {
    }
  }
  wsClients = [];
  if (server) {
    server.close();
    server = null;
    serverPort = 0;
  }
}
function handleHttp(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(getControlPanelHtml());
    return;
  }
  if (req.url === "/api/status" && req.method === "GET") {
    const q = readQuestion();
    const reply = readReply();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      cardActive: true,
      cardCode: null,
      cardExpiresAt: null,
      queueCount: getQueueCount(),
      queue: readQueue(),
      hasQuestion: !!q,
      hasReply: !!reply,
      workspace: _workspaceInfo,
      wsClients: wsClients.length,
      port: serverPort
    }));
    return;
  }
  if (req.url === "/api/send" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        if (data.text) {
          sendText(data.text);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
          broadcastWs({ type: "queueUpdate", count: getQueueCount() });
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: "Missing text field" }));
        }
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Invalid JSON" }));
      }
    });
    return;
  }
  res.writeHead(404);
  res.end("Not Found");
}
function handleUpgrade(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto.createHash("sha1").update(key + WS_MAGIC).digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r
Upgrade: websocket\r
Connection: Upgrade\r
Sec-WebSocket-Accept: ${accept}\r
\r
`
  );
  const client = { socket, alive: true };
  wsClients.push(client);
  const pushState = buildPushState();
  wsSend(socket, JSON.stringify({ type: "init", ...pushState }));
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const parsed = parseFrame(buffer);
      if (!parsed)
        break;
      buffer = buffer.subarray(parsed.totalLength);
      if (parsed.opcode === 8) {
        removeClient(client);
        socket.end();
        return;
      }
      if (parsed.opcode === 9) {
        wsSendRaw(socket, buildFrame(parsed.payload, 10));
        continue;
      }
      if (parsed.opcode === 10) {
        client.alive = true;
        continue;
      }
      if (parsed.opcode === 1) {
        handleWsMessage(client, parsed.payload.toString("utf-8"));
      }
    }
  });
  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));
}
function handleWsMessage(client, raw) {
  try {
    const msg = JSON.parse(raw);
    switch (msg.type) {
      case "sendText":
        if (msg.text) {
          sendText(msg.text);
          broadcastWs({ type: "queueUpdate", count: getQueueCount() });
        }
        break;
      case "submitAnswer":
        if (msg.data) {
          writeAnswer(msg.data);
        }
        break;
      case "cancelQuestion":
        cancelQuestion();
        break;
      case "ackReply":
        clearReply();
        break;
      case "ping":
        wsSend(client.socket, JSON.stringify({ type: "pong" }));
        break;
    }
  } catch {
  }
}
function removeClient(client) {
  const idx = wsClients.indexOf(client);
  if (idx !== -1)
    wsClients.splice(idx, 1);
  try {
    client.socket.destroy();
  } catch {
  }
}
function broadcastWs(data) {
  const msg = JSON.stringify(data);
  for (const c of wsClients) {
    wsSend(c.socket, msg);
  }
}
function parseFrame(buf) {
  if (buf.length < 2)
    return null;
  const opcode = buf[0] & 15;
  const masked = (buf[1] & 128) !== 0;
  let payloadLen = buf[1] & 127;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4)
      return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10)
      return null;
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  const totalLength = offset + maskLen + payloadLen;
  if (buf.length < totalLength)
    return null;
  let payload = buf.subarray(offset + maskLen, offset + maskLen + payloadLen);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }
  return { opcode, payload, totalLength };
}
function buildFrame(payload, opcode = 1) {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 128 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 128 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 128 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, data]);
}
function wsSend(socket, msg) {
  try {
    wsSendRaw(socket, buildFrame(msg));
  } catch {
  }
}
function wsSendRaw(socket, buf) {
  try {
    socket.write(buf);
  } catch {
  }
}
function buildPushState() {
  return {
    cardActive: true,
    cardCode: null,
    cardExpiresAt: null,
    queueCount: getQueueCount(),
    queue: readQueue(),
    question: readQuestion(),
    reply: readReply(),
    workspace: _workspaceInfo,
    wsClients: wsClients.length,
    port: serverPort
  };
}
function startPushPolling() {
  if (pollTimer)
    return;
  pollTimer = setInterval(() => {
    if (wsClients.length === 0)
      return;
    const state = JSON.stringify(buildPushState());
    if (state !== lastPushState) {
      lastPushState = state;
      broadcastWs({ type: "stateUpdate", ...JSON.parse(state) });
    }
  }, 500);
}
function getControlPanelHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>jefr - Remote Console</title>
<style>
:root{--bg1:#eef1f7;--bg2:#e6eaf3;--surface:#ffffff;--surface-2:#f5f7fb;--fg:#1e2330;--fg2:#5b6473;--fg3:#9aa2b1;--border:#e6e9f1;--border-strong:#d6dbe7;--accent:#6d5cf0;--accent2:#3b82f6;--accent-soft:rgba(109,92,240,0.10);--success:#16a34a;--success-soft:rgba(22,163,74,0.10);--danger:#dc2626;--danger-soft:rgba(220,38,38,0.10);--warn:#d97706;--warn-soft:rgba(217,119,6,0.12);--radius:14px;--radius-sm:10px;--shadow-sm:0 1px 2px rgba(16,24,40,0.06),0 1px 3px rgba(16,24,40,0.04);--shadow-accent:0 8px 24px rgba(109,92,240,0.16);--mono:'JetBrains Mono','SFMono-Regular',Consolas,monospace}
*{margin:0;padding:0;box-sizing:border-box}
html{color-scheme:light}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Inter',sans-serif;background:linear-gradient(180deg,var(--bg1),var(--bg2));background-attachment:fixed;color:var(--fg);min-height:100vh;-webkit-tap-highlight-color:transparent;-webkit-font-smoothing:antialiased}
.wrap{max-width:600px;margin:0 auto;padding:24px 16px 48px}
.hdr{text-align:center;padding:8px 0 22px}
.hdr h1{font-size:26px;font-weight:800;background:linear-gradient(135deg,#6d5cf0,#3b82f6);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;margin-bottom:4px;letter-spacing:-0.6px}
.hdr p{font-size:12px;color:var(--fg2);font-weight:500;letter-spacing:0.3px}
.stat-row{display:flex;gap:10px;margin-bottom:18px}
.stat-card{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 10px;text-align:center;box-shadow:var(--shadow-sm)}
.stat-val{font-size:19px;font-weight:800;font-family:var(--mono);margin-bottom:3px;color:var(--fg)}
.stat-val.on{color:var(--success)}.stat-val.off{color:var(--danger)}.stat-val.num{color:var(--accent)}
.stat-label{font-size:10px;color:var(--fg2);font-weight:600;text-transform:uppercase;letter-spacing:0.5px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);margin-bottom:14px;overflow:hidden;box-shadow:var(--shadow-sm)}
.card.highlight{border-color:rgba(109,92,240,0.40);box-shadow:var(--shadow-accent)}
.card.warn-hl{border-color:rgba(217,119,6,0.40);box-shadow:0 8px 24px rgba(217,119,6,0.14)}
.card-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border)}
.card-title{font-size:13px;font-weight:700;color:var(--fg);letter-spacing:-0.1px}
.card-badge{font-size:10px;padding:3px 11px;border-radius:20px;font-weight:700;letter-spacing:0.2px}
.card-badge.on{background:var(--success-soft);color:var(--success)}
.card-badge.off{background:var(--surface-2);color:var(--fg3)}
.card-badge.accent{background:var(--accent-soft);color:var(--accent)}
.card-body{padding:16px}
.compose-area{display:flex;flex-direction:column;gap:12px}
.compose-input{width:100%;min-height:84px;max-height:200px;padding:12px 14px;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:var(--radius-sm);color:var(--fg);font-size:14px;font-family:inherit;resize:vertical;outline:none;transition:border-color .2s,box-shadow .2s;line-height:1.55}
.compose-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.compose-input::placeholder{color:var(--fg3)}
.compose-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.compose-hint{font-size:11px;color:var(--fg3)}
.btn{padding:10px 24px;border:none;border-radius:var(--radius-sm);font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .15s;white-space:nowrap;-webkit-appearance:none}
.btn-send{background:linear-gradient(135deg,#6d5cf0,#4f46e5);color:#fff;box-shadow:var(--shadow-accent);min-width:84px}
.btn-send:hover{filter:brightness(1.06)}
.btn-send:active{transform:scale(0.97)}
.btn-send:disabled{opacity:1;cursor:not-allowed;transform:none;box-shadow:none;background:var(--border-strong);color:var(--fg3)}
.btn-outline{background:var(--surface);border:1px solid var(--border-strong);color:var(--fg2);padding:8px 16px;font-size:12px}
.btn-outline:hover{background:var(--surface-2);color:var(--fg)}
.btn-warn{background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;box-shadow:0 2px 10px rgba(217,119,6,0.25)}
.btn-danger{background:var(--danger-soft);color:var(--danger);border:1px solid rgba(220,38,38,0.25)}
.btn-danger:hover{background:rgba(220,38,38,0.16)}
.btn-sm{padding:7px 14px;font-size:11px;border-radius:8px}
.sent-ok{color:var(--success);font-size:12px;font-weight:700;animation:fadeIn .3s}
@keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.q-block{margin-bottom:16px}
.q-text{font-size:14px;font-weight:600;margin-bottom:10px;line-height:1.5;color:var(--fg)}
.q-options{display:flex;flex-direction:column;gap:8px;margin-bottom:10px}
.q-opt{display:flex;align-items:center;gap:10px;padding:11px 14px;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:var(--radius-sm);cursor:pointer;transition:all .15s;font-size:13px;color:var(--fg);-webkit-tap-highlight-color:transparent}
.q-opt:hover{background:var(--accent-soft);border-color:rgba(109,92,240,0.35)}
.q-opt.selected{border-color:var(--accent);background:var(--accent-soft)}
.q-opt .check{width:18px;height:18px;border:2px solid var(--border-strong);border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;transition:all .15s}
.q-opt.multi .check{border-radius:5px}
.q-opt.selected .check{border-color:var(--accent);background:var(--accent)}
.q-opt.selected .check::after{content:'';display:block;width:8px;height:8px;background:#fff;border-radius:50%}
.q-opt.selected.multi .check::after{border-radius:1px;width:10px;height:6px;background:transparent;border-bottom:2px solid #fff;border-left:2px solid #fff;transform:rotate(-45deg);margin-top:-2px}
.q-other{width:100%;padding:10px 12px;background:var(--surface-2);border:1px solid var(--border-strong);border-radius:8px;color:var(--fg);font-size:13px;outline:none;font-family:inherit}
.q-other:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.q-other::placeholder{color:var(--fg3)}
.q-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.reply-content{font-size:13px;line-height:1.7;color:var(--fg);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow-y:auto;padding:4px 0}
.reply-actions{display:flex;justify-content:flex-end;margin-top:12px}
.info-row{display:flex;align-items:center;justify-content:space-between;padding:9px 0;font-size:12px;border-bottom:1px solid var(--border)}
.info-row:last-child{border-bottom:none}
.info-k{color:var(--fg2);font-size:11px;font-weight:500}
.info-v{color:var(--fg);font-weight:600;font-family:var(--mono);font-size:11px;text-align:right;max-width:65%;word-break:break-all}
.info-v.accent{color:var(--accent)}
.queue-item{padding:10px 14px;font-size:11px;color:var(--fg2);border-bottom:1px solid var(--border);white-space:pre-wrap;word-break:break-all;line-height:1.45;display:flex;align-items:flex-start;gap:8px}
.queue-item:last-child{border-bottom:none}
.qi-type{font-size:9px;font-weight:800;padding:3px 8px;border-radius:8px;flex-shrink:0;text-transform:uppercase;letter-spacing:0.3px}
.qi-type.text{background:rgba(59,130,246,0.12);color:#2563eb}
.qi-type.image{background:rgba(16,185,129,0.12);color:#059669}
.qi-type.file{background:rgba(217,119,6,0.14);color:#b45309}
.qi-content{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--fg)}
.qi-time{font-size:9px;color:var(--fg3);flex-shrink:0;font-family:var(--mono)}
.empty{text-align:center;padding:24px;color:var(--fg3);font-size:12px}
.log-list{max-height:150px;overflow-y:auto;padding:12px 14px;background:var(--surface-2)}
.log-item{font-size:10px;color:var(--fg2);font-family:var(--mono);padding:2px 0;display:flex;gap:8px}
.log-time{color:var(--fg3);flex-shrink:0}
.hidden{display:none!important}
.section-toggle{cursor:pointer;user-select:none;-webkit-user-select:none}
.section-toggle .chevron{transition:transform .2s;display:inline-block;font-size:16px;color:var(--fg3)}
.section-toggle .chevron.open{transform:rotate(90deg)}
::-webkit-scrollbar{width:6px;height:6px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:var(--border-strong);border-radius:6px}::-webkit-scrollbar-thumb:hover{background:var(--fg3)}
</style>
</head>
<body>
<div class="wrap">
	<div class="hdr"><h1>jefr</h1><p>Remote Console</p></div>

	<div class="stat-row">
		<div class="stat-card"><div id="statConn" class="stat-val off">-</div><div class="stat-label">Connection</div></div>
		<div class="stat-card"><div id="statQueue" class="stat-val num">0</div><div class="stat-label">Queue</div></div>
		<div class="stat-card"><div id="statWs" class="stat-val num">0</div><div class="stat-label">Clients</div></div>
	</div>

	<!-- Send message -->
	<div class="card highlight">
		<div class="card-head"><span class="card-title">Send message</span><span id="sendStatus"></span></div>
		<div class="card-body">
			<div class="compose-area">
				<textarea id="msgInput" class="compose-input" placeholder="Type a message to send to Cursor..." rows="3"></textarea>
				<div class="compose-row">
					<span class="compose-hint">Ctrl+Enter to send</span>
					<button id="sendBtn" class="btn btn-send" disabled>Send</button>
				</div>
			</div>
		</div>
	</div>

	<!-- AI question (dynamic) -->
	<div id="questionCard" class="card warn-hl hidden">
		<div class="card-head"><span class="card-title">AI question</span><span class="card-badge accent">Awaiting answer</span></div>
		<div id="questionBody" class="card-body"></div>
	</div>

	<!-- AI reply (dynamic) -->
	<div id="replyCard" class="card hidden">
		<div class="card-head"><span class="card-title">AI reply summary</span></div>
		<div class="card-body">
			<div id="replyContent" class="reply-content"></div>
			<div class="reply-actions"><button id="replyAck" class="btn btn-outline btn-sm">Dismiss</button></div>
		</div>
	</div>

	<!-- Workspace -->
	<div class="card">
		<div class="card-head section-toggle" onclick="toggleSection('wsBody',this)">
			<span class="card-title">Workspace</span>
			<span class="chevron open">\u203A</span>
		</div>
		<div id="wsBody" class="card-body">
			<div class="info-row"><span class="info-k">Project</span><span id="wsName" class="info-v">-</span></div>
			<div class="info-row"><span class="info-k">Path</span><span id="wsPath" class="info-v">-</span></div>
			<div class="info-row"><span class="info-k">License key</span><span id="wsCard" class="info-v">-</span></div>
			<div class="info-row"><span class="info-k">Expires</span><span id="wsExpire" class="info-v">-</span></div>
		</div>
	</div>

	<!-- Queue -->
	<div class="card">
		<div class="card-head"><span class="card-title">Message queue</span><span id="queueBadge" class="card-badge off">0 items</span></div>
		<div id="queueList"><div class="empty">Queue is empty</div></div>
	</div>

	<!-- Log -->
	<div class="card">
		<div class="card-head section-toggle" onclick="toggleSection('logList',this)">
			<span class="card-title">Activity log</span>
			<span class="chevron open">\u203A</span>
		</div>
		<div id="logList" class="log-list"></div>
	</div>
</div>
<script>
(function(){
var ws,reconnT,curQuestion=null,selectedAnswers={},reconnDelay=1000,maxReconnDelay=30000,reconnAttempts=0;
var $=function(id){return document.getElementById(id)};
var esc=function(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')};
function fmtTime(){var d=new Date();return [d.getHours(),d.getMinutes(),d.getSeconds()].map(function(v){return String(v).padStart(2,'0')}).join(':')}
function log(m){var el=document.createElement('div');el.className='log-item';el.innerHTML='<span class="log-time">'+fmtTime()+'</span><span>'+esc(m)+'</span>';var L=$('logList');L.appendChild(el);L.scrollTop=L.scrollHeight;if(L.children.length>60)L.removeChild(L.firstChild)}

window.toggleSection=function(id,el){
	var body=$(id);if(!body)return;
	var hidden=body.style.display==='none';
	body.style.display=hidden?'':'none';
	var chev=el.querySelector('.chevron');
	if(chev){chev.className=hidden?'chevron open':'chevron'}
};

// Send message
var input=$('msgInput'),sendBtn=$('sendBtn'),sendStatus=$('sendStatus');
function updateSendBtn(){sendBtn.disabled=!input.value.trim()||!ws||ws.readyState!==1}
input.addEventListener('input',updateSendBtn);
input.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();doSend()}});
sendBtn.addEventListener('click',doSend);
function doSend(){
	var txt=input.value.trim();if(!txt||!ws||ws.readyState!==1)return;
	ws.send(JSON.stringify({type:'sendText',text:txt}));
	input.value='';updateSendBtn();
	sendStatus.innerHTML='<span class="sent-ok">Sent</span>';
	log('Send: '+txt.substring(0,40)+(txt.length>40?'...':''));
	setTimeout(function(){sendStatus.innerHTML=''},2000);
	input.focus();
}

// Render AI question
function renderQuestion(q){
	curQuestion=q;selectedAnswers={};
	var card=$('questionCard'),body=$('questionBody');
	if(!q||!q.questions||!q.questions.length){card.classList.add('hidden');return}
	card.classList.remove('hidden');
	var h='';
	for(var i=0;i<q.questions.length;i++){
		var qi=q.questions[i];
		selectedAnswers[qi.id]=[];
		h+='<div class="q-block" data-qid="'+esc(qi.id)+'">';
		h+='<div class="q-text">'+esc(qi.question)+'</div>';
		h+='<div class="q-options">';
		for(var j=0;j<qi.options.length;j++){
			var opt=qi.options[j];
			h+='<div class="q-opt'+(qi.allow_multiple?' multi':'')+'" data-qid="'+esc(qi.id)+'" data-oid="'+esc(opt.id)+'" onclick="toggleOpt(this)">';
			h+='<span class="check"></span><span>'+esc(opt.label)+'</span></div>';
		}
		h+='</div>';
		h+='<input class="q-other" data-qid="'+esc(qi.id)+'" placeholder="Additional notes (optional)">';
		h+='</div>';
	}
	h+='<div class="q-actions"><button class="btn btn-danger btn-sm" onclick="cancelQ()">Cancel</button><button class="btn btn-warn btn-sm" onclick="submitQ()">Submit answer</button></div>';
	body.innerHTML=h;
	card.scrollIntoView({behavior:'smooth',block:'nearest'});
}

window.toggleOpt=function(el){
	var qid=el.getAttribute('data-qid'),oid=el.getAttribute('data-oid');
	if(!curQuestion)return;
	var qi=curQuestion.questions.find(function(q){return q.id===qid});
	if(!qi)return;
	var arr=selectedAnswers[qid]||[];
	var idx=arr.indexOf(oid);
	if(qi.allow_multiple){
		if(idx>-1)arr.splice(idx,1);else arr.push(oid);
	}else{
		arr=idx>-1?[]:[oid];
		var opts=el.parentNode.querySelectorAll('.q-opt');
		for(var k=0;k<opts.length;k++)opts[k].classList.remove('selected');
	}
	selectedAnswers[qid]=arr;
	el.classList.toggle('selected',arr.indexOf(oid)>-1);
};

window.submitQ=function(){
	if(!curQuestion||!ws||ws.readyState!==1)return;
	var answers=[];
	for(var i=0;i<curQuestion.questions.length;i++){
		var qi=curQuestion.questions[i];
		var otherInput=document.querySelector('.q-other[data-qid="'+qi.id+'"]');
		answers.push({questionId:qi.id,selected:selectedAnswers[qi.id]||[],other:otherInput?otherInput.value.trim():''});
	}
	ws.send(JSON.stringify({type:'submitAnswer',data:{id:curQuestion.id,answers:answers}}));
	$('questionCard').classList.add('hidden');
	curQuestion=null;
	log('Answer submitted');
};

window.cancelQ=function(){
	if(!ws||ws.readyState!==1)return;
	ws.send(JSON.stringify({type:'cancelQuestion'}));
	$('questionCard').classList.add('hidden');
	curQuestion=null;
	log('Answer cancelled');
};

// Render AI reply
function renderReply(reply){
	var card=$('replyCard'),content=$('replyContent');
	if(!reply||!reply.content){card.classList.add('hidden');return}
	card.classList.remove('hidden');
	content.textContent=reply.content;
	card.scrollIntoView({behavior:'smooth',block:'nearest'});
}
$('replyAck').addEventListener('click',function(){
	if(ws&&ws.readyState===1)ws.send(JSON.stringify({type:'ackReply'}));
	$('replyCard').classList.add('hidden');
	log('Reply acknowledged');
});

// Render queue
function renderQueue(items){
	var L=$('queueList');
	if(!items||!items.length){L.innerHTML='<div class="empty">Queue is empty</div>';$('queueBadge').textContent='0 items';$('queueBadge').className='card-badge off';return}
	$('queueBadge').textContent=items.length+' items';$('queueBadge').className='card-badge on';
	var h='';
	for(var i=0;i<items.length;i++){
		var it=items[i],tp=it.type||'text',preview=tp==='text'?(it.content||''):(tp==='image'?'[Image]':'[File] '+(it.path||'').split(/[\\/\\\\]/).pop());
		var time=it.timestamp?new Date(it.timestamp).toLocaleTimeString():'';
		h+='<div class="queue-item"><span class="qi-type '+tp+'">'+({text:'Text',image:'Image',file:'File'}[tp]||tp)+'</span><span class="qi-content">'+esc(preview.substring(0,120))+'</span><span class="qi-time">'+time+'</span></div>';
	}
	L.innerHTML=h;
}

function updateDashboard(d){
	$('statConn').textContent=d.cardActive?'Online':'Offline';$('statConn').className='stat-val '+(d.cardActive?'on':'off');
	$('statQueue').textContent=d.queueCount||0;
	$('statWs').textContent=d.wsClients||0;
	if(d.workspace){$('wsName').textContent=d.workspace.name||'-';$('wsPath').textContent=d.workspace.path||'-'}
	$('wsCard').textContent=d.cardCode||'-';
	$('wsExpire').textContent=d.cardExpiresAt?new Date(d.cardExpiresAt).toLocaleString():'-';
	renderQueue(d.queue||[]);
	if(d.question)renderQuestion(d.question);
	if(d.reply)renderReply(d.reply);
}

function connect(){
	if(ws)return;ws=new WebSocket('ws://'+location.host);
	ws.onopen=function(){reconnDelay=1000;reconnAttempts=0;log('Connected');updateSendBtn();$('statConn').textContent='Online';$('statConn').className='stat-val on'};
	ws.onclose=function(){ws=null;updateSendBtn();reconnAttempts++;var delay=Math.min(reconnDelay*Math.pow(1.5,reconnAttempts-1),maxReconnDelay);var sec=Math.round(delay/1000);if(reconnAttempts<=3){log('Disconnected, reconnecting in '+sec+'s')}else if(reconnAttempts%5===0){log('Still reconnecting... (attempt '+reconnAttempts+')')};$('statConn').textContent='Offline';$('statConn').className='stat-val off';reconnT=setTimeout(connect,delay)};
	ws.onerror=function(){if(reconnAttempts<=2)log('Connection error')};
	ws.onmessage=function(e){
		try{
			var m=JSON.parse(e.data);
			if(m.type==='init'||m.type==='stateUpdate'){updateDashboard(m);updateSendBtn()}
			else if(m.type==='queueUpdate'){$('statQueue').textContent=m.count||0}
			else if(m.type==='pong'){}
		}catch(err){log('Parse error')}
	};
}

fetch('/api/status').then(function(r){return r.json()}).then(updateDashboard).catch(function(){});
connect();
})();
</script>
</body>
</html>`;
}

// src/extension.ts
var mainPanel;
var pollTimer2;
var lastQuestionId;
var lastReplyTimestamp;
var lastQueueCount;
var lastCardValid;
var chatTriggered = false;
var extensionVersion = "0.0.0";
var currentDataDir = "";
var remotePollTimer;
var heartbeatTimer;
var lastReplyContent;
var lastRemoteQuestionId;
var idleTimer;
var lastActivityTime = Date.now();
var IDLE_TIMEOUT_MS = 30 * 60 * 1e3;
function resetIdleTimer() {
  lastActivityTime = Date.now();
}
function startIdleTimer() {
  if (idleTimer)
    clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    if (!isCardValid())
      return;
    if (Date.now() - lastActivityTime >= IDLE_TIMEOUT_MS) {
      sendText("Hello");
      triggerCursorChat();
      resetIdleTimer();
    }
  }, 6e4);
}
function computeDataDir(workspaceFolders) {
  const rootDir = path2.join(os2.homedir(), ".moyu-message");
  if (workspaceFolders.length === 0)
    return rootDir;
  const primary = workspaceFolders[0].uri.fsPath;
  const hash = crypto2.createHash("md5").update(primary).digest("hex").slice(0, 12);
  return path2.join(rootDir, hash);
}
function activate(context) {
  extensionVersion = context.extension.packageJSON?.version || "0.0.0";
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  currentDataDir = computeDataDir(workspaceFolders);
  setDataDir(currentDataDir);
  migrateFromRootDir();
  const provider = new MessengerViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "mcpMessenger.mainView",
      provider
    )
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("mcpMessenger.setupMcp", () => {
      const workspaceFolders2 = vscode.workspace.workspaceFolders;
      if (!workspaceFolders2?.length) {
        vscode.window.showErrorMessage("Please open a workspace first");
        return;
      }
      const changedCount = setupMcpForFolders(workspaceFolders2);
      if (changedCount >= 0) {
        vscode.window.showInformationMessage(
          changedCount > 0 ? `MCP config installed to ${changedCount} workspace(s). Restart Cursor to apply.` : "MCP config already exists; no need to install again"
        );
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("mcpMessenger.removeMcp", () => {
      const workspaceFolders2 = vscode.workspace.workspaceFolders;
      if (!workspaceFolders2?.length)
        return;
      let removedCount = 0;
      for (const folder of workspaceFolders2) {
        if (removeMcpConfig(folder.uri.fsPath)) {
          removedCount++;
        }
      }
      vscode.window.showInformationMessage(
        removedCount > 0 ? `MCP config removed from ${removedCount} workspace(s)` : "No MCP config found to remove"
      );
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "mcpMessenger.sendFile",
      (uri) => {
        if (uri) {
          sendFile(uri.fsPath);
          vscode.window.showInformationMessage(
            "File added to message queue"
          );
        }
      }
    )
  );
  startPolling();
  startRemotePolling();
  startHeartbeat();
  startIdleTimer();
  autoSetupMcp();
  setWorkspaceInfo(getWorkspaceName(), getWorkspacePath() || "");
  startLocalServer().then((port) => {
    console.log(`jefr console started: http://127.0.0.1:${port}`);
  }).catch((e) => {
    console.error("Failed to start console server:", e);
  });
  context.subscriptions.push(
    vscode.commands.registerCommand("mcpMessenger.openConsole", () => {
      const port = getServerPort();
      if (!port) {
        vscode.window.showWarningMessage("Console server is not running yet");
        return;
      }
      const url = `http://127.0.0.1:${port}`;
      vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      if (event.added.length > 0) {
        autoSetupMcp(event.added);
      }
    })
  );
  context.subscriptions.push({
    dispose: () => {
      if (pollTimer2)
        clearInterval(pollTimer2);
    }
  });
}
function deactivate() {
  if (pollTimer2)
    clearInterval(pollTimer2);
  if (remotePollTimer)
    clearInterval(remotePollTimer);
  if (heartbeatTimer)
    clearInterval(heartbeatTimer);
  if (idleTimer)
    clearInterval(idleTimer);
  stopLocalServer();
}
function startPolling() {
  const poll = () => {
    if (!mainPanel)
      return;
    const question = readQuestion();
    if (question) {
      if (question.id !== lastQuestionId) {
        mainPanel.webview.postMessage({
          type: "showQuestion",
          data: question
        });
        lastQuestionId = question.id;
        pushQuestionToRemoteNow(question);
      }
    } else if (lastQuestionId) {
      mainPanel.webview.postMessage({ type: "clearQuestion" });
      lastQuestionId = void 0;
    }
    const reply = readReply();
    if (reply && reply.timestamp !== lastReplyTimestamp) {
      mainPanel.webview.postMessage({
        type: "showReply",
        data: reply
      });
      lastReplyTimestamp = reply.timestamp;
    } else if (!reply) {
      lastReplyTimestamp = void 0;
    }
    const cardValid = isCardValid();
    if (cardValid !== lastCardValid) {
      mainPanel.webview.postMessage({
        type: "cardState",
        data: { active: true }
      });
      lastCardValid = cardValid;
    }
    const count = getQueueCount();
    if (count !== lastQueueCount) {
      mainPanel.webview.postMessage({
        type: "queueCount",
        count
      });
      mainPanel.webview.postMessage({
        type: "queueData",
        data: readQueue()
      });
      lastQueueCount = count;
    }
  };
  poll();
  pollTimer2 = setInterval(poll, 500);
}
function getWorkspaceName() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].name;
  }
  return "default";
}
function getWorkspacePath() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return void 0;
}
function pushQuestionToRemoteNow(question) {
  if (!REMOTE_API_ENABLED)
    return;
  const card = readCardState();
  if (!card || !isCardValid())
    return;
  const wsName = getWorkspaceName();
  if (question.id === lastRemoteQuestionId)
    return;
  lastRemoteQuestionId = question.id;
  pushRemoteQuestion(card.code, question.id, question.questions, wsName).catch(() => {
  });
}
function startRemotePolling() {
  return;
  if (remotePollTimer)
    return;
  const wsName = getWorkspaceName();
  const remotePoll = async () => {
    const card = readCardState();
    if (!card || !isCardValid())
      return;
    try {
      const messages = await pollRemoteMessages(card.code, wsName);
      for (const msg of messages) {
        sendText(msg.content);
        resetIdleTimer();
        if (!chatTriggered)
          triggerCursorChat();
      }
    } catch {
    }
    const reply = readReply();
    if (reply && reply.content) {
      const replyKey = reply.timestamp + reply.content.slice(0, 50);
      if (replyKey !== lastReplyContent) {
        lastReplyContent = replyKey;
        resetIdleTimer();
        try {
          await pushRemoteReply(card.code, reply.content, wsName);
        } catch {
        }
      }
    } else {
      lastReplyContent = void 0;
    }
    const question = readQuestion();
    if (question && question.id !== lastRemoteQuestionId) {
      lastRemoteQuestionId = question.id;
      try {
        await pushRemoteQuestion(card.code, question.id, question.questions, wsName);
      } catch {
      }
    } else if (!question && lastRemoteQuestionId) {
      try {
        await cancelRemoteQuestion(card.code, lastRemoteQuestionId);
      } catch {
      }
      lastRemoteQuestionId = void 0;
    }
    if (question && lastRemoteQuestionId) {
      try {
        const result = await pollRemoteAnswer(card.code, lastRemoteQuestionId);
        if (result?.answered && result.answer) {
          writeAnswer(result.answer);
        }
      } catch {
      }
    }
  };
  remotePollTimer = setInterval(remotePoll, 3e3);
}
function startHeartbeat() {
  return;
  if (heartbeatTimer)
    return;
  const beat = async () => {
    const card = readCardState();
    if (!card || !isCardValid())
      return;
    await sendWorkspaceHeartbeat(card.code, getWorkspaceName(), getWorkspacePath());
  };
  beat();
  heartbeatTimer = setInterval(beat, 15e3);
}
function autoSetupMcp(workspaceFolders = vscode.workspace.workspaceFolders || []) {
  const globalChanged = setupGlobalMcpConfig(currentDataDir);
  if (workspaceFolders.length === 0) {
    if (globalChanged) {
      vscode.window.showInformationMessage("jefr MCP installed to global config. Restart Cursor to apply.");
    }
    return;
  }
  const changedCount = setupMcpForFolders(workspaceFolders);
  if (changedCount > 0 || globalChanged) {
    vscode.window.showInformationMessage(
      `jefr auto-installed config to ${changedCount} workspace(s). Restart Cursor to apply.`
    );
  }
}
async function triggerCursorChat() {
  // Disabled for now: do not auto-open/focus the Cursor chat.
  return;
  // if (chatTriggered)
  //   return;
  // chatTriggered = true;
  // try {
  //   await vscode.commands.executeCommand("workbench.action.chat.newChat");
  //   await new Promise((r) => setTimeout(r, 500));
  //   await vscode.commands.executeCommand("workbench.action.chat.open", {
  //     query: "Hello, please handle my message"
  //   });
  // } catch {
  //   try {
  //     await vscode.commands.executeCommand("workbench.action.chat.open");
  //   } catch {
  //   }
  // }
}
function setupMcpForFolders(workspaceFolders) {
  let changedCount = 0;
  for (const folder of workspaceFolders) {
    try {
      if (setupMcpConfig(folder.uri.fsPath, currentDataDir)) {
        changedCount++;
      }
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to install MCP config: ${folder.name} - ${e.message}`
      );
    }
  }
  return changedCount;
}
var MessengerViewProvider = class {
  constructor(extensionUri) {
    this.extensionUri = extensionUri;
  }
  resolveWebviewView(webviewView) {
    mainPanel = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          this.pushCurrentState();
          this.pushCardState();
          mainPanel?.webview.postMessage({ type: "version", version: extensionVersion });
          mainPanel?.webview.postMessage({ type: "injectedTokenState", injected: !!readInjectedToken() });
          this.pushQueueData();
          break;
        case "sendText":
          if (!this.checkCard())
            return;
          sendText(msg.text);
          resetIdleTimer();
          triggerCursorChat();
          break;
        case "pickAttachment":
          if (!this.checkCard())
            return;
          this.handlePickAttachment();
          break;
        case "sendImage":
          if (!this.checkCard())
            return;
          this.handleSendImage(msg.caption);
          resetIdleTimer();
          break;
        case "sendPastedImage":
          if (!this.checkCard())
            return;
          this.handlePastedImage(msg.dataUrl, msg.caption);
          resetIdleTimer();
          triggerCursorChat();
          break;
        case "sendFile":
          if (!this.checkCard())
            return;
          this.handleSendFile();
          resetIdleTimer();
          break;
        case "resendFile":
          if (!this.checkCard())
            return;
          if (msg.path) {
            sendFile(msg.path);
            resetIdleTimer();
            triggerCursorChat();
          }
          break;
        case "submitAnswer":
          writeAnswer(msg.data);
          break;
        case "cancelQuestion":
          cancelQuestion();
          break;
        case "ackReply":
          this.ackReply(msg.timestamp);
          break;
        case "activateCard":
          this.handleActivateCard(msg.code);
          break;
        case "logoutCard":
          clearCardState();
          this.pushCardState();
          break;
        case "getQueue":
          this.pushQueueData();
          break;
        case "deleteQueueItem":
          deleteQueueItem(msg.id);
          this.pushQueueData();
          break;
        case "clearQueue":
          clearQueue();
          this.pushQueueData();
          break;
        case "updateQueueItem":
          updateQueueItem(msg.id, { content: msg.content });
          this.pushQueueData();
          break;
        case "fetchUsage":
          this.handleFetchUsage();
          break;
        case "injectToken":
          this.handleInjectToken(msg.token);
          break;
        case "clearInjectedToken":
          this.handleClearInjectedToken();
          break;
        case "openConsole":
          vscode.commands.executeCommand("mcpMessenger.openConsole");
          break;
        case "getServerInfo":
          mainPanel?.webview.postMessage({
            type: "serverInfo",
            data: { port: getServerPort(), clients: getConnectedClients() }
          });
          break;
      }
    });
    webviewView.onDidDispose(() => {
      if (mainPanel === webviewView) {
        mainPanel = void 0;
        lastQuestionId = void 0;
        lastReplyTimestamp = void 0;
        lastQueueCount = void 0;
      }
    });
  }
  handlePastedImage(dataUrl, caption) {
    try {
      const match = dataUrl.match(
        /^data:image\/(\w+);base64,(.+)$/
      );
      if (!match)
        return;
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const buf = Buffer.from(match[2], "base64");
      const tmpPath = path2.join(
        os2.tmpdir(),
        "mcp_" + Date.now() + "." + ext
      );
      fs2.writeFileSync(tmpPath, buf);
      sendImage(tmpPath, caption);
    } catch {
    }
  }
  async handlePickAttachment() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      filters: {
        Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
        Files: ["*"]
      }
    });
    if (!uris?.length) {
      return;
    }
    for (const uri of uris) {
      const name = path.basename(uri.fsPath);
      const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(uri.fsPath);
      if (isImage) {
        let dataUrl = void 0;
        try {
          const buf = fs.readFileSync(uri.fsPath);
          const ext2 = path.extname(uri.fsPath).slice(1).toLowerCase() || "png";
          const mime = ext2 === "svg" ? "svg+xml" : ext2 === "jpg" ? "jpeg" : ext2;
          dataUrl = `data:image/${mime};base64,${buf.toString("base64")}`;
        } catch {
        }
        mainPanel?.webview.postMessage({
          type: "attachmentAdded",
          item: {
            id: makeId(),
            type: "image",
            path: uri.fsPath,
            name,
            dataUrl
          }
        });
      } else {
        mainPanel?.webview.postMessage({
          type: "attachmentAdded",
          item: {
            id: makeId(),
            type: "file",
            path: uri.fsPath,
            name
          }
        });
      }
    }
  }
  async handleSendImage(caption) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: {
        Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]
      }
    });
    if (uris?.[0]) {
      sendImage(uris[0].fsPath, caption);
    }
  }
  async handleSendFile() {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false
    });
    if (uris?.[0]) {
      sendFile(uris[0].fsPath);
    }
  }
  pushCurrentState() {
    if (!mainPanel)
      return;
    const question = readQuestion();
    if (question) {
      mainPanel.webview.postMessage({
        type: "showQuestion",
        data: question
      });
      lastQuestionId = question.id;
    } else {
      mainPanel.webview.postMessage({ type: "clearQuestion" });
      lastQuestionId = void 0;
    }
    const reply = readReply();
    if (reply) {
      mainPanel.webview.postMessage({
        type: "showReply",
        data: reply
      });
      lastReplyTimestamp = reply.timestamp;
    } else {
      lastReplyTimestamp = void 0;
    }
    const count = getQueueCount();
    mainPanel.webview.postMessage({
      type: "queueCount",
      count
    });
    lastQueueCount = count;
  }
  checkCard() {
    return true;
  }
  pushQueueData() {
    if (!mainPanel)
      return;
    mainPanel.webview.postMessage({ type: "queueData", data: readQueue() });
  }
  pushCardState() {
    if (!mainPanel)
      return;
    mainPanel.webview.postMessage({ type: "cardState", data: { active: true } });
  }
  async handleActivateCard(code) {
    if (!mainPanel || !code)
      return;
    try {
      const result = await activateCard(code);
      if (result.success) {
        mainPanel.webview.postMessage({ type: "cardActivated", data: result.data });
        vscode.window.showInformationMessage(`License activated successfully. Valid for ${result.data.duration_hours} hours`);
      } else {
        mainPanel.webview.postMessage({ type: "cardError", error: result.error || "Activation failed" });
      }
    } catch (e) {
      mainPanel.webview.postMessage({ type: "cardError", error: e.message || "Network error" });
    }
  }
  async handleFetchUsage() {
    if (!mainPanel)
      return;
    mainPanel.webview.postMessage({ type: "usageLoading" });
    try {
      const result = await fetchCursorUsage();
      mainPanel.webview.postMessage({ type: "usageData", data: result });
    } catch (e) {
      mainPanel.webview.postMessage({ type: "usageData", data: { success: false, error: e.message || "Query failed" } });
    }
  }
  async handleInjectToken(token) {
    if (!mainPanel || !token)
      return;
    writeInjectedToken(token.trim());
    mainPanel.webview.postMessage({ type: "injectedTokenState", injected: true });
    this.handleFetchUsage();
  }
  handleClearInjectedToken() {
    if (!mainPanel)
      return;
    clearInjectedToken();
    mainPanel.webview.postMessage({ type: "injectedTokenState", injected: false });
    this.handleFetchUsage();
  }
  async ackReply(timestamp) {
    const reply = readReply();
    if (!reply) {
      lastReplyTimestamp = void 0;
      return;
    }
    if (!timestamp || reply.timestamp === timestamp) {
      if (REMOTE_API_ENABLED) {
        const card = readCardState();
        if (card && isCardValid() && reply.content) {
          const replyKey = reply.timestamp + reply.content.slice(0, 50);
          if (replyKey !== lastReplyContent) {
            lastReplyContent = replyKey;
            try {
              await pushRemoteReply(card.code, reply.content, getWorkspaceName());
            } catch {
            }
          }
        }
      }
      clearReply();
      lastReplyTimestamp = void 0;
    }
  }
  getHtml(webview) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta
		http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
	>
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
	<script nonce="${nonce}">
	(function(){
		const vscode = acquireVsCodeApi();

		/* \u2500\u2500 Drag & Drop \u2500\u2500 */
		var dragRetry = 0;
		function setupDragDrop(){
			var area = document.querySelector('.input-area');
			if(!area){ if(dragRetry++<30) setTimeout(setupDragDrop,500); return; }
			var dragCount = 0;
			area.addEventListener('dragenter', function(e){ e.preventDefault(); e.stopPropagation(); dragCount++; area.classList.add('drag-over'); });
			area.addEventListener('dragleave', function(e){ e.preventDefault(); e.stopPropagation(); dragCount--; if(dragCount<=0){dragCount=0;area.classList.remove('drag-over');} });
			area.addEventListener('dragover', function(e){ e.preventDefault(); e.stopPropagation(); });
			area.addEventListener('drop', function(e){
				e.preventDefault(); e.stopPropagation(); dragCount=0; area.classList.remove('drag-over');
				var files = e.dataTransfer && e.dataTransfer.files;
				if(!files||!files.length) return;
				Array.from(files).forEach(function(file){
					if(file.type && file.type.startsWith('image/')){
						var r = new FileReader(); r.onload=function(ev){ vscode.postMessage({type:'sendPastedImage',dataUrl:ev.target.result,caption:''}); }; r.readAsDataURL(file);
					} else {
						var r2 = new FileReader(); r2.onload=function(ev){ var c=ev.target.result; var p=c.length>500?c.slice(0,500)+'...':c; vscode.postMessage({type:'sendText',text:'[File: '+file.name+']\\n'+p}); }; r2.readAsText(file);
					}
				});
			});
		}


		/* \u2500\u2500 Font zoom (Ctrl/Cmd +/-/0 and Ctrl+wheel) \u2500\u2500 */
		var ZOOM_KEY = 'jefr.zoom';
		var ZOOM_MIN = 0.5, ZOOM_MAX = 3, ZOOM_STEP = 0.1;
		function getZoom(){
			var z = parseFloat(localStorage.getItem(ZOOM_KEY));
			return (isFinite(z) && z > 0) ? z : 1;
		}
		function applyZoom(z){
			z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z*100)/100));
			document.body.style.zoom = z;
			try { localStorage.setItem(ZOOM_KEY, String(z)); } catch(e){}
			return z;
		}
		function setupZoom(){
			applyZoom(getZoom());
			window.addEventListener('keydown', function(e){
				if(!(e.ctrlKey || e.metaKey)) return;
				var k = e.key;
				if(k === '+' || k === '=' ){ e.preventDefault(); applyZoom(getZoom()+ZOOM_STEP); }
				else if(k === '-' || k === '_'){ e.preventDefault(); applyZoom(getZoom()-ZOOM_STEP); }
				else if(k === '0'){ e.preventDefault(); applyZoom(1); }
			}, true);
			window.addEventListener('wheel', function(e){
				if(!(e.ctrlKey || e.metaKey)) return;
				e.preventDefault();
				applyZoom(getZoom() + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
			}, { passive: false, capture: true });
		}

		/* \u2500\u2500 Enhanced history (placeholder) \u2500\u2500 */
		function enhanceHistory(){}

		/* \u2500\u2500 Tutorial \u2500\u2500 */
		var tRetry = 0;
		function setupTutorial(){
			var app = document.querySelector('.app');
			if(!app){ if(tRetry++<30) setTimeout(setupTutorial,500); return; }
			if(app.querySelector('.tutorial-section')) return;
			var section = document.createElement('div');
			section.className = 'tutorial-section';
			var btn = document.createElement('button');
			btn.className = 'tutorial-btn';
			btn.innerHTML = '\\u{1F4D6} Tutorial';
			var body = document.createElement('div');
			body.className = 'tutorial-body';
			var steps = [
				['Install','Install jefr from VSIX, then restart Cursor'],
				['Check MCP','Cursor Settings \\u2192 Tools & MCP \\u2192 enable jefr'],
				['Start chat','Send a message in the bottom panel; AI replies in the loop']
			];
			var html='';
			for(var i=0;i<steps.length;i++){
				html+='<div class="tutorial-step"><span class="step-num">'+(i+1)+'</span><div class="step-content"><div class="step-title">'+steps[i][0]+'</div><div class="step-desc">'+steps[i][1]+'</div></div></div>';
			}
			body.innerHTML=html;
			section.appendChild(btn);
			section.appendChild(body);
			app.appendChild(section);
			btn.addEventListener('click',function(){ body.classList.toggle('show'); });
		}

		/* \u2500\u2500 Init \u2500\u2500 */
		function init(){ setupZoom(); setupDragDrop(); enhanceHistory(); setupTutorial(); }
		if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', init); }
		else { init(); }
	})();
	</script>
</body>
</html>`;
  }
};
function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
//# sourceMappingURL=extension.js.map
