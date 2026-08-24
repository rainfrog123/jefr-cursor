var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined")
    return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/messenger.ts
import * as fs2 from "fs";
import * as path2 from "path";
import * as os2 from "os";

// src/agentTranscript.ts
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
var preferredRoots = [];
function workspacePathToProjectSlug(fsPath) {
  let s = fsPath.replace(/\\/g, "/").replace(/\/+$/, "");
  s = s.replace(/^([A-Za-z]):/, (_, d) => d.toLowerCase());
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
function cursorProjectsRoot() {
  return path.join(os.homedir(), ".cursor", "projects");
}
function transcriptFileFor(projectDir, agentId) {
  return path.join(projectDir, "agent-transcripts", agentId, `${agentId}.jsonl`);
}
function findTranscriptPath(agentId) {
  if (!agentId || agentId.startsWith("tile:"))
    return void 0;
  const projects = cursorProjectsRoot();
  for (const root of preferredRoots) {
    const slug = workspacePathToProjectSlug(root);
    const candidate = transcriptFileFor(path.join(projects, slug), agentId);
    if (fs.existsSync(candidate))
      return candidate;
  }
  let dirs = [];
  try {
    dirs = fs.readdirSync(projects);
  } catch {
    return void 0;
  }
  for (const slug of dirs) {
    const candidate = transcriptFileFor(path.join(projects, slug), agentId);
    if (fs.existsSync(candidate))
      return candidate;
  }
  return void 0;
}
var cache = /* @__PURE__ */ new Map();
function readLastJsonlRecord(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (st.size === 0)
    return null;
  const fd = fs.openSync(file, "r");
  try {
    const start = Math.max(0, st.size - 16384);
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const candidates = start > 0 ? lines.slice(1) : lines;
    for (let i = candidates.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(candidates[i]);
      } catch {
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}
function classifyStatus(raw) {
  const s = typeof raw === "string" ? raw.toLowerCase() : "";
  if (s === "success" || s === "ok" || s === "completed")
    return "success";
  if (s === "error" || s === "failed" || s === "aborted" || s === "cancelled") {
    return "error";
  }
  return "other";
}
function getTranscriptTurnEnd(agentId) {
  const file = findTranscriptPath(agentId);
  if (!file)
    return { ended: false };
  let st;
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
  let result = {
    ended: false,
    path: file,
    mtimeMs: st.mtimeMs
  };
  if (last && typeof last === "object" && last.type === "turn_ended") {
    const rec = last;
    const status = classifyStatus(rec.status);
    result = {
      ended: true,
      status,
      rawStatus: typeof rec.status === "string" ? rec.status : void 0,
      error: typeof rec.error === "string" ? rec.error : void 0,
      path: file,
      mtimeMs: st.mtimeMs
    };
  }
  cache.set(agentId, { mtimeMs: st.mtimeMs, size: st.size, result });
  return result;
}
function isTranscriptTurnDead(agentId) {
  return getTranscriptTurnEnd(agentId).ended;
}
function isTranscriptDeadConfirmed(agentId, heartbeatAlive) {
  return !heartbeatAlive && isTranscriptTurnDead(agentId);
}

// src/messenger.ts
var ROOT_DATA_DIR = path2.join(os2.homedir(), ".moyu-message");
var dataDir = process.env.MESSENGER_DATA_DIR || ROOT_DATA_DIR;
var QUEUE_FILE = path2.join(dataDir, "queue.json");
var QUESTION_FILE = path2.join(dataDir, "question.json");
var ANSWER_FILE = path2.join(dataDir, "answer.json");
var REPLY_FILE = path2.join(dataDir, "reply.json");
var CARD_FILE = path2.join(dataDir, "card.json");
var INJECTED_TOKEN_FILE = path2.join(dataDir, "injected-token.json");
var HISTORY_FILE = path2.join(dataDir, "history.json");
var HEARTBEAT_FILE = path2.join(dataDir, "agent-alive.json");
var QUEUE_LOCK_DIR = path2.join(dataDir, "queue.lock");
var RULES_FILE_NAME = "mcp-messenger.mdc";
var LEGACY_RULES_FILE_NAME = "system.mdc";
function selectedAgentFile() {
  return path2.join(dataDir, "selected-agent.json");
}
function readSelectedAgentId() {
  const file = selectedAgentFile();
  if (!fs2.existsSync(file)) {
    return void 0;
  }
  try {
    const data = JSON.parse(fs2.readFileSync(file, "utf-8"));
    const id = typeof data.agentId === "string" ? sanitizeAgentId(data.agentId) : "";
    return id || void 0;
  } catch {
    return void 0;
  }
}
function writeSelectedAgentId(agentId) {
  ensureDir();
  const file = selectedAgentFile();
  if (!agentId) {
    try {
      fs2.unlinkSync(file);
    } catch {
    }
    return;
  }
  fs2.writeFileSync(
    file,
    JSON.stringify({ agentId: sanitizeAgentId(agentId), timestamp: (/* @__PURE__ */ new Date()).toISOString() }),
    "utf-8"
  );
}
function setDataDir(dir) {
  dataDir = dir;
  QUEUE_FILE = path2.join(dir, "queue.json");
  QUESTION_FILE = path2.join(dir, "question.json");
  ANSWER_FILE = path2.join(dir, "answer.json");
  REPLY_FILE = path2.join(dir, "reply.json");
  CARD_FILE = path2.join(dir, "card.json");
  INJECTED_TOKEN_FILE = path2.join(dir, "injected-token.json");
  HISTORY_FILE = path2.join(dir, "history.json");
  HEARTBEAT_FILE = path2.join(dir, "agent-alive.json");
  QUEUE_LOCK_DIR = path2.join(dir, "queue.lock");
}
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
    }
  }
}
function acquireQueueLock(timeoutMs = 2e3) {
  const start = Date.now();
  for (; ; ) {
    try {
      fs2.mkdirSync(QUEUE_LOCK_DIR);
      return true;
    } catch {
      try {
        const st = fs2.statSync(QUEUE_LOCK_DIR);
        if (Date.now() - st.mtimeMs > 5e3) {
          try {
            fs2.rmdirSync(QUEUE_LOCK_DIR);
          } catch {
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
function releaseQueueLock() {
  try {
    fs2.rmdirSync(QUEUE_LOCK_DIR);
  } catch {
  }
}
function withQueueLock(fn) {
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
function robustWriteFile(file, data) {
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try {
      fs2.writeFileSync(file, data, "utf-8");
      return;
    } catch (e) {
      lastErr = e;
      const code = e?.code;
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
var AGENT_STALE_MS = 6e3;
function getAgentStatus() {
  return getAgentStatusFor(void 0);
}
function getAgentStatusFor(agentId) {
  const file = path2.join(agentDirFor(agentId), "agent-alive.json");
  let heartbeatAlive = false;
  let state = "idle";
  try {
    if (fs2.existsSync(file)) {
      const data = JSON.parse(fs2.readFileSync(file, "utf-8"));
      const ts = typeof data.ts === "number" ? data.ts : 0;
      if (Date.now() - ts < AGENT_STALE_MS) {
        heartbeatAlive = true;
        state = data.state === "working" ? "working" : "waiting";
      }
    }
  } catch {
  }
  if (agentId && isTranscriptDeadConfirmed(agentId, heartbeatAlive)) {
    return { alive: false, state: "idle" };
  }
  if (heartbeatAlive) {
    return { alive: true, state };
  }
  return { alive: false, state: "idle" };
}
var HISTORY_CAP = 150;
function readSharedHistory() {
  ensureDir();
  if (!fs2.existsSync(HISTORY_FILE)) {
    return [];
  }
  try {
    const data = JSON.parse(fs2.readFileSync(HISTORY_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function appendSharedHistory(item) {
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
    fs2.writeFileSync(HISTORY_FILE, JSON.stringify(hist, null, 2), "utf-8");
  } catch {
  }
}
function appendReplyToSharedHistory(reply) {
  if (!reply.content || typeof reply.percent === "number") {
    return;
  }
  const timestamp = reply.timestamp || (/* @__PURE__ */ new Date()).toISOString();
  appendSharedHistory({
    id: "reply-" + timestamp,
    kind: "reply",
    text: reply.content,
    timestamp
  });
}
function clearSharedHistory() {
  try {
    fs2.writeFileSync(HISTORY_FILE, "[]", "utf-8");
  } catch {
  }
}
function migrateFromRootDir() {
  if (dataDir === ROOT_DATA_DIR) {
    return;
  }
  const rootCardFile = path2.join(ROOT_DATA_DIR, "card.json");
  if (fs2.existsSync(rootCardFile) && !fs2.existsSync(CARD_FILE)) {
    ensureDir();
    fs2.copyFileSync(rootCardFile, CARD_FILE);
  }
}
var REMOTE_API_ENABLED = false;
function ensureDir() {
  if (!fs2.existsSync(dataDir)) {
    fs2.mkdirSync(dataDir, { recursive: true });
  }
}
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function readQueue() {
  ensureDir();
  if (!fs2.existsSync(QUEUE_FILE)) {
    return [];
  }
  try {
    const data = JSON.parse(fs2.readFileSync(QUEUE_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function writeQueue(items) {
  ensureDir();
  robustWriteFile(QUEUE_FILE, JSON.stringify(items, null, 2));
}
function formatHistoryTime(date = /* @__PURE__ */ new Date()) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}
var historySink = null;
function setHistorySink(fn) {
  historySink = fn;
}
function pushHistoryItem(item) {
  historySink?.(item);
}
function sendText(text) {
  const item = {
    id: makeId(),
    type: "text",
    content: text,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  withQueueLock(() => {
    const queue = readQueue();
    queue.push(item);
    writeQueue(queue);
  });
  appendSharedHistory({ id: item.id, kind: "text", text, timestamp: item.timestamp });
  return item;
}
function sendImage(filePath, caption) {
  const item = {
    id: makeId(),
    type: "image",
    path: filePath,
    caption,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  withQueueLock(() => {
    const queue = readQueue();
    queue.push(item);
    writeQueue(queue);
  });
  return item;
}
function sendFile(filePath) {
  withQueueLock(() => {
    const queue = readQueue();
    queue.push({
      id: makeId(),
      type: "file",
      path: filePath,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    writeQueue(queue);
  });
}
function getQueueCount() {
  return readQueue().length;
}
function deleteQueueItem(id) {
  withQueueLock(() => {
    const queue = readQueue();
    writeQueue(queue.filter((item) => item.id !== id));
  });
}
function clearQueue() {
  withQueueLock(() => writeQueue([]));
}
function updateQueueItem(id, updates) {
  withQueueLock(() => {
    const queue = readQueue();
    const idx = queue.findIndex((item) => item.id === id);
    if (idx === -1) {
      return;
    }
    if (updates.content !== void 0 && queue[idx].type === "text") {
      queue[idx].content = updates.content;
    }
    writeQueue(queue);
  });
}
function readQuestion() {
  if (!fs2.existsSync(QUESTION_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs2.readFileSync(QUESTION_FILE, "utf-8"));
    return data && data.id && data.questions ? data : null;
  } catch {
    return null;
  }
}
function writeAnswer(answer) {
  ensureDir();
  fs2.writeFileSync(ANSWER_FILE, JSON.stringify(answer, null, 2), "utf-8");
}
function cancelQuestion() {
  const q = readQuestion();
  if (!q) {
    return;
  }
  const answers = q.questions.map((qi, i) => ({
    questionId: qi.id,
    selected: [],
    other: i === 0 ? "User cancelled the answer" : ""
  }));
  writeAnswer({ id: q.id, answers });
}
function readReply() {
  if (!fs2.existsSync(REPLY_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs2.readFileSync(REPLY_FILE, "utf-8"));
    return data && data.content ? data : null;
  } catch {
    return null;
  }
}
function clearReply() {
  try {
    fs2.unlinkSync(REPLY_FILE);
  } catch {
  }
}
var AGENTS_SUBDIR = "agents";
function sanitizeAgentId(agentId) {
  if (!agentId || typeof agentId !== "string") {
    return "";
  }
  return agentId.trim().replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
}
function agentDirFor(agentId) {
  const id = sanitizeAgentId(agentId);
  return id ? path2.join(dataDir, AGENTS_SUBDIR, id) : dataDir;
}
function forgetAgentDir(agentId) {
  const id = sanitizeAgentId(agentId);
  if (!id) {
    return;
  }
  try {
    fs2.rmSync(path2.join(dataDir, AGENTS_SUBDIR, id), {
      recursive: true,
      force: true
    });
  } catch {
  }
}
function ensureDirAt(dir) {
  if (!fs2.existsSync(dir)) {
    fs2.mkdirSync(dir, { recursive: true });
  }
}
function acquireLockIn(lockDir, timeoutMs = 2e3) {
  const start = Date.now();
  for (; ; ) {
    try {
      fs2.mkdirSync(lockDir);
      return true;
    } catch {
      try {
        const st = fs2.statSync(lockDir);
        if (Date.now() - st.mtimeMs > 5e3) {
          try {
            fs2.rmdirSync(lockDir);
          } catch {
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
function withLockIn(dir, fn) {
  ensureDirAt(dir);
  const lockDir = path2.join(dir, "queue.lock");
  const locked = acquireLockIn(lockDir);
  try {
    return fn();
  } finally {
    if (locked) {
      try {
        fs2.rmdirSync(lockDir);
      } catch {
      }
    }
  }
}
function readJsonArrayAt(file) {
  if (!fs2.existsSync(file)) {
    return [];
  }
  try {
    const data = JSON.parse(fs2.readFileSync(file, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}
function readQueueFor(agentId) {
  const dir = agentDirFor(agentId);
  ensureDirAt(dir);
  return readJsonArrayAt(path2.join(dir, "queue.json"));
}
function writeQueueFor(items, agentId) {
  const dir = agentDirFor(agentId);
  ensureDirAt(dir);
  robustWriteFile(path2.join(dir, "queue.json"), JSON.stringify(items, null, 2));
}
function getQueueCountFor(agentId) {
  return readQueueFor(agentId).length;
}
function sendTextTo(agentId, text) {
  const item = {
    id: makeId(),
    type: "text",
    content: text,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path2.join(dir, "queue.json"));
    queue.push(item);
    robustWriteFile(path2.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
  appendSharedHistory({ id: item.id, kind: "text", text, timestamp: item.timestamp });
  return item;
}
function sendImageTo(agentId, filePath, caption, dataUrl) {
  const item = {
    id: makeId(),
    type: "image",
    path: filePath,
    caption,
    dataUrl,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path2.join(dir, "queue.json"));
    queue.push(item);
    robustWriteFile(path2.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
  return item;
}
function sendImagesTo(agentId, images, caption) {
  const first = images[0] || {};
  const item = {
    id: makeId(),
    type: "image",
    path: first.path,
    dataUrl: first.dataUrl,
    name: first.name,
    caption,
    images,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path2.join(dir, "queue.json"));
    queue.push(item);
    robustWriteFile(path2.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
  return item;
}
function sendFileTo(agentId, filePath) {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path2.join(dir, "queue.json"));
    queue.push({
      id: makeId(),
      type: "file",
      path: filePath,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    robustWriteFile(path2.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
}
function deleteQueueItemFor(id, agentId) {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path2.join(dir, "queue.json"));
    robustWriteFile(
      path2.join(dir, "queue.json"),
      JSON.stringify(queue.filter((it) => it.id !== id), null, 2)
    );
  });
}
function clearQueueFor(agentId) {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => writeQueueFor([], agentId));
}
function listAgentDirIds() {
  try {
    const base = path2.join(dataDir, AGENTS_SUBDIR);
    return fs2.readdirSync(base).filter((id) => {
      try {
        return fs2.statSync(path2.join(base, id)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}
function clearAllQueues() {
  clearQueueFor(void 0);
  try {
    const base = path2.join(dataDir, AGENTS_SUBDIR);
    for (const id of fs2.readdirSync(base)) {
      try {
        if (fs2.statSync(path2.join(base, id)).isDirectory())
          clearQueueFor(id);
      } catch {
      }
    }
  } catch {
  }
}
function updateQueueItemFor(id, updates, agentId) {
  const dir = agentDirFor(agentId);
  withLockIn(dir, () => {
    const queue = readJsonArrayAt(path2.join(dir, "queue.json"));
    const idx = queue.findIndex((it) => it.id === id);
    if (idx === -1) {
      return;
    }
    if (updates.content !== void 0 && queue[idx].type === "text") {
      queue[idx].content = updates.content;
    }
    robustWriteFile(path2.join(dir, "queue.json"), JSON.stringify(queue, null, 2));
  });
}
function readReplyFor(agentId) {
  const file = path2.join(agentDirFor(agentId), "reply.json");
  if (!fs2.existsSync(file)) {
    return null;
  }
  try {
    const data = JSON.parse(fs2.readFileSync(file, "utf-8"));
    return data && data.content ? data : null;
  } catch {
    return null;
  }
}
function clearReplyFor(agentId) {
  try {
    fs2.unlinkSync(path2.join(agentDirFor(agentId), "reply.json"));
  } catch {
  }
}
function readQuestionFor(agentId) {
  const file = path2.join(agentDirFor(agentId), "question.json");
  if (!fs2.existsSync(file)) {
    return null;
  }
  try {
    const data = JSON.parse(fs2.readFileSync(file, "utf-8"));
    return data && data.id && data.questions ? data : null;
  } catch {
    return null;
  }
}
function writeAnswerFor(answer, agentId) {
  const dir = agentDirFor(agentId);
  ensureDirAt(dir);
  fs2.writeFileSync(path2.join(dir, "answer.json"), JSON.stringify(answer, null, 2), "utf-8");
}
function cancelQuestionFor(agentId) {
  const q = readQuestionFor(agentId);
  if (!q) {
    return;
  }
  const answers = q.questions.map((qi, i) => ({
    questionId: qi.id,
    selected: [],
    other: i === 0 ? "User cancelled the answer" : ""
  }));
  writeAnswerFor({ id: q.id, answers }, agentId);
}
function listLiveAgents(maxAgeMs = AGENT_STALE_MS) {
  const root = path2.join(dataDir, AGENTS_SUBDIR);
  let ids = [];
  try {
    ids = fs2.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const beat = path2.join(root, id, "agent-alive.json");
    try {
      const data = JSON.parse(fs2.readFileSync(beat, "utf-8"));
      const ts = typeof data.ts === "number" ? data.ts : 0;
      if (Date.now() - ts > maxAgeMs) {
        continue;
      }
      const state = data.state === "working" ? "working" : "waiting";
      out.push({ id, state, ts, queueCount: getQueueCountFor(id) });
    } catch {
    }
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
function scanAllAgents(maxAgeMs = AGENT_STALE_MS) {
  const root = path2.join(dataDir, AGENTS_SUBDIR);
  let ids = [];
  try {
    ids = fs2.readdirSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const dir = path2.join(root, id);
    try {
      if (!fs2.statSync(dir).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    let ts = 0;
    let beatState = "idle";
    try {
      const data = JSON.parse(fs2.readFileSync(path2.join(dir, "agent-alive.json"), "utf-8"));
      ts = typeof data.ts === "number" ? data.ts : 0;
      beatState = data.state === "working" ? "working" : "waiting";
    } catch {
    }
    const hbFresh = ts > 0 && Date.now() - ts <= maxAgeMs;
    const connected = hbFresh && !isTranscriptDeadConfirmed(id, hbFresh);
    out.push({
      id,
      connected,
      state: connected ? beatState : "idle",
      ts,
      queueCount: getQueueCountFor(id)
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
function readCardState() {
  ensureDir();
  if (!fs2.existsSync(CARD_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs2.readFileSync(CARD_FILE, "utf-8"));
    return data && data.code ? data : null;
  } catch {
    return null;
  }
}
function writeCardState(state) {
  ensureDir();
  fs2.writeFileSync(CARD_FILE, JSON.stringify(state, null, 2), "utf-8");
}
function clearCardState() {
  try {
    fs2.unlinkSync(CARD_FILE);
  } catch {
  }
}
function apiRequest(_endpoint, _body) {
  return Promise.resolve({ success: false, error: "remote API disabled" });
}
async function activateCard(_code, _machineId) {
  return {
    success: true,
    data: {
      code: "",
      expires_at: "",
      activated_at: (/* @__PURE__ */ new Date()).toISOString(),
      duration_hours: 0
    }
  };
}
function isCardValid() {
  return true;
}
async function pollRemoteMessages(cardCode, workspace) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-poll", {
      code: cardCode,
      workspace: workspace || ""
    });
    if (resp.success && Array.isArray(resp.data)) {
      return resp.data;
    }
    return [];
  } catch {
    return [];
  }
}
async function pushRemoteReply(cardCode, content, workspace) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-reply", {
      code: cardCode,
      content,
      workspace: workspace || null
    });
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
async function pushRemoteQuestion(cardCode, questionId, questions, workspace) {
  try {
    const resp = await apiRequest("/mcp-cards/remote-question", {
      code: cardCode,
      question_id: questionId,
      questions,
      workspace: workspace || null
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
    const resp = await apiRequest(
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
function getCursorConfigDir() {
  switch (process.platform) {
    case "win32":
      return path2.join(
        process.env.APPDATA || path2.join(os2.homedir(), "AppData", "Roaming"),
        "Cursor"
      );
    case "darwin":
      return path2.join(os2.homedir(), "Library", "Application Support", "Cursor");
    default:
      return path2.join(os2.homedir(), ".config", "Cursor");
  }
}
function readVscdbViaSqlite(dbPath) {
  try {
    const { DatabaseSync } = __require("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const tokenRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
    const emailRow = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/cachedEmail");
    db.close();
    if (tokenRow?.value) {
      return { token: tokenRow.value, email: emailRow?.value || "" };
    }
  } catch {
  }
  try {
    const { execSync } = __require("child_process");
    const escaped = dbPath.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const script = `const{DatabaseSync}=require("node:sqlite");const db=new DatabaseSync('${escaped}',{readOnly:true});const t=db.prepare("SELECT value FROM ItemTable WHERE key=?").get("cursorAuth/accessToken");const e=db.prepare("SELECT value FROM ItemTable WHERE key=?").get("cursorAuth/cachedEmail");db.close();console.log(JSON.stringify({t:t?.value||"",e:e?.value||""}))`;
    const out = execSync(`node --disable-warning=ExperimentalWarning -e "${script}"`, {
      encoding: "utf-8",
      timeout: 1e4,
      windowsHide: true
    }).trim();
    const parsed = JSON.parse(out);
    if (parsed.t) {
      return { token: parsed.t, email: parsed.e || "" };
    }
  } catch {
  }
  return null;
}
function readCursorAuth() {
  const gsDir = path2.join(getCursorConfigDir(), "User", "globalStorage");
  const dbPath = path2.join(gsDir, "state.vscdb");
  if (fs2.existsSync(dbPath)) {
    const result = readVscdbViaSqlite(dbPath);
    if (result) {
      return result;
    }
  }
  const jsonPath = path2.join(gsDir, "storage.json");
  if (fs2.existsSync(jsonPath)) {
    try {
      const data = JSON.parse(fs2.readFileSync(jsonPath, "utf-8"));
      const token = data["cursorAuth/accessToken"];
      if (token) {
        return { token, email: data["cursorAuth/cachedEmail"] || "" };
      }
    } catch {
    }
  }
  const authPath = path2.join(gsDir, "cursor.auth.json");
  if (fs2.existsSync(authPath)) {
    try {
      const data = JSON.parse(fs2.readFileSync(authPath, "utf-8"));
      if (data.token) {
        return { token: data.token, email: data.email || "" };
      }
    } catch {
    }
  }
  return null;
}
function readInjectedToken() {
  ensureDir();
  if (!fs2.existsSync(INJECTED_TOKEN_FILE)) {
    return null;
  }
  try {
    const data = JSON.parse(fs2.readFileSync(INJECTED_TOKEN_FILE, "utf-8"));
    return data && data.token ? data : null;
  } catch {
    return null;
  }
}
function writeInjectedToken(token) {
  ensureDir();
  fs2.writeFileSync(INJECTED_TOKEN_FILE, JSON.stringify({ token }, null, 2), "utf-8");
}
function clearInjectedToken() {
  try {
    fs2.unlinkSync(INJECTED_TOKEN_FILE);
  } catch {
  }
}
function getEffectiveAuth() {
  const injected = readInjectedToken();
  if (injected) {
    return { token: injected.token, email: "" };
  }
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
  const extDir = path2.dirname(path2.dirname(__filename));
  return path2.join(extDir, "dist", "mcp-server.mjs");
}
function getGlobalMcpJsonPath() {
  return path2.join(os2.homedir(), ".cursor", "mcp.json");
}
function applyMcpServerEntry(config, messengerDataDir) {
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  delete config.mcpServers["moyu-message"];
  delete config.mcpServers["jefr cursor"];
  delete config.mcpServers["jefr"];
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
  const cursorDir = path2.dirname(mcpJsonPath);
  if (!fs2.existsSync(cursorDir)) {
    fs2.mkdirSync(cursorDir, { recursive: true });
  }
  const previousContent = fs2.existsSync(mcpJsonPath) ? fs2.readFileSync(mcpJsonPath, "utf-8") : "";
  let config = {};
  if (fs2.existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(previousContent);
    } catch {
    }
  }
  applyMcpServerEntry(config, messengerDataDir);
  const nextContent = JSON.stringify(config, null, 2);
  if (nextContent !== previousContent) {
    fs2.writeFileSync(mcpJsonPath, nextContent, "utf-8");
    return true;
  }
  return false;
}
function setupMcpConfig(workspaceFolder, messengerDataDir) {
  const cursorDir = path2.join(workspaceFolder, ".cursor");
  if (!fs2.existsSync(cursorDir)) {
    fs2.mkdirSync(cursorDir, { recursive: true });
  }
  const mcpJsonPath = path2.join(cursorDir, "mcp.json");
  const previousContent = fs2.existsSync(mcpJsonPath) ? fs2.readFileSync(mcpJsonPath, "utf-8") : "";
  let config = {};
  if (fs2.existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(previousContent);
    } catch {
    }
  }
  if (!config.mcpServers) {
    config.mcpServers = {};
  }
  applyMcpServerEntry(config, messengerDataDir);
  const nextContent = JSON.stringify(config, null, 2);
  let changed = false;
  if (nextContent !== previousContent) {
    fs2.writeFileSync(mcpJsonPath, nextContent, "utf-8");
    changed = true;
  }
  if (setupCursorRules(workspaceFolder)) {
    changed = true;
  }
  return changed;
}
function removeMcpConfig(workspaceFolder) {
  const mcpJsonPath = path2.join(workspaceFolder, ".cursor", "mcp.json");
  let removed = false;
  if (fs2.existsSync(mcpJsonPath)) {
    try {
      const config = JSON.parse(fs2.readFileSync(mcpJsonPath, "utf-8"));
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
        fs2.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2), "utf-8");
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
2. \`check_messages\` blocks until the user sends a new message; process it, reply, then call \`check_messages\` again \u2014 perpetual loop: reply \u2192 check_messages \u2192 receive message \u2192 reply \u2192 check_messages.
3. Never call \`check_messages\` at the start of a turn or before the reply is complete. Only exception: the user explicitly asks to end the conversation.
4. After writing a plan (Plan), finishing analysis (Debug), or answering a question (Ask), do not end the turn \u2014 call \`check_messages\` and wait for user feedback.
5. When the user must choose or confirm (pick a plan, framework, approve an action, etc.), call \`ask_question\`. Do not use Cursor's built-in ask_user_question.
6. \`ask_question\` format: \`{ "questions": [{ "question": "Question text", "options": [{ "id": "a", "label": "Option A" }, { "id": "b", "label": "Option B" }], "allow_multiple": false }] }\`
7. Single-select: \`allow_multiple: false\`; multi-select: \`allow_multiple: true\`; one \`questions\` array may mix both.
8. Users may add custom text (Other field) on each question; no extra option needed for that.
9. After \`ask_question\` returns an answer, still call \`check_messages\` to keep listening.
10. Do not use \`ask_question\` at the end of every turn to ask "anything else?"; end turns with \`check_messages\` only. Use \`ask_question\` only when a real decision is needed.
11. \`check_messages\` accepts optional \`reply\` (string, Markdown): summary shown in the plugin modal. Example: \`{ "reply": "## Summary
Changes complete..." }\`
12. Before ending a session, prefer passing \`reply\` with key conclusions; omit \`reply\` if no summary is needed.
13. Do not spawn subagents for parallel tasks.
14. If \`check_messages\` or \`ask_question\` returns early due to client cancel, connection issues, or internal errors, and the user did not ask to end the chat, do not show internal \`[system]\` text to the user \u2014 call the tool again immediately.
15. During multi-step work, after each key step call \`send_progress\` with a summary. Example: \`{ "progress": "## Step 1 complete
Updated xxx file..." }\`. \`send_progress\` returns immediately; continue to the next step.
16. \`progress\` should include: what was done, current approach, next step. Use concise Markdown.

---
**End of turn (mandatory)**: Only after the reply is **fully complete**, the last step must call the jefr MCP \`check_messages\` tool (CallMcpTool, server identifier for jefr, toolName \`check_messages\`, arguments \`{}\`). Never call it at the start of a turn or before the reply is done. Use \`ask_question\` only when the user must make a choice during the task (e.g. pick a framework or plan).`;
function setupCursorRules(workspaceFolder) {
  const rulesDir = path2.join(workspaceFolder, ".cursor", "rules");
  if (!fs2.existsSync(rulesDir)) {
    fs2.mkdirSync(rulesDir, { recursive: true });
  }
  const currentRulesPath = path2.join(rulesDir, RULES_FILE_NAME);
  let changed = false;
  const previousRulesContent = fs2.existsSync(currentRulesPath) ? fs2.readFileSync(currentRulesPath, "utf-8") : "";
  if (previousRulesContent !== RULES_CONTENT) {
    fs2.writeFileSync(currentRulesPath, RULES_CONTENT, "utf-8");
    changed = true;
  }
  const legacyRulesPath = path2.join(rulesDir, LEGACY_RULES_FILE_NAME);
  if (removeLegacyRulesIfManaged(legacyRulesPath)) {
    changed = true;
  }
  return changed;
}
function removeCursorRules(workspaceFolder) {
  const rulesDir = path2.join(workspaceFolder, ".cursor", "rules");
  let removed = false;
  const currentRulesPath = path2.join(rulesDir, RULES_FILE_NAME);
  if (fs2.existsSync(currentRulesPath)) {
    fs2.unlinkSync(currentRulesPath);
    removed = true;
  }
  const legacyRulesPath = path2.join(rulesDir, LEGACY_RULES_FILE_NAME);
  if (removeLegacyRulesIfManaged(legacyRulesPath)) {
    removed = true;
  }
  return removed;
}
function removeLegacyRulesIfManaged(filePath) {
  if (!fs2.existsSync(filePath)) {
    return false;
  }
  try {
    const content = fs2.readFileSync(filePath, "utf-8");
    if (content === RULES_CONTENT) {
      fs2.unlinkSync(filePath);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}
export {
  REMOTE_API_ENABLED,
  activateCard,
  agentDirFor,
  appendReplyToSharedHistory,
  appendSharedHistory,
  cancelQuestion,
  cancelQuestionFor,
  cancelRemoteQuestion,
  clearAllQueues,
  clearCardState,
  clearInjectedToken,
  clearQueue,
  clearQueueFor,
  clearReply,
  clearReplyFor,
  clearSharedHistory,
  deleteQueueItem,
  deleteQueueItemFor,
  fetchCursorUsage,
  forgetAgentDir,
  formatHistoryTime,
  getAgentStatus,
  getAgentStatusFor,
  getQueueCount,
  getQueueCountFor,
  isCardValid,
  listAgentDirIds,
  listLiveAgents,
  makeId,
  migrateFromRootDir,
  pollRemoteAnswer,
  pollRemoteMessages,
  pushHistoryItem,
  pushRemoteQuestion,
  pushRemoteReply,
  readCardState,
  readInjectedToken,
  readQuestion,
  readQuestionFor,
  readQueue,
  readQueueFor,
  readReply,
  readReplyFor,
  readSelectedAgentId,
  readSharedHistory,
  removeMcpConfig,
  scanAllAgents,
  sendFile,
  sendFileTo,
  sendImage,
  sendImageTo,
  sendImagesTo,
  sendText,
  sendTextTo,
  sendWorkspaceHeartbeat,
  setDataDir,
  setHistorySink,
  setupGlobalMcpConfig,
  setupMcpConfig,
  updateQueueItem,
  updateQueueItemFor,
  writeAnswer,
  writeAnswerFor,
  writeCardState,
  writeInjectedToken,
  writeQueue,
  writeSelectedAgentId
};
