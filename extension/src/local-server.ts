import * as http from "http";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { IncomingMessage, ServerResponse, Server } from "http";
import type { Socket } from "net";
import {
  readQuestionFor,
  readReplyFor,
  getQueueCountFor,
  readQueueFor,
  sendTextTo,
  sendImageTo,
  pushHistoryItem,
  readSharedHistory,
  appendSharedHistory,
  appendReplyToSharedHistory,
  writeAnswerFor,
  cancelQuestionFor,
  clearReplyFor,
  getAgentStatusFor,
  deleteQueueItemFor,
  clearQueueFor,
  readSelectedAgentId,
} from "./messenger";

/** Decode a `data:` URL into a temp file and queue it as an image message.
 *  Returns true if it was handled. Used for images pasted in the Obsidian plugin. */
function handlePastedImage(
  dataUrl: string,
  caption?: string,
  target?: string,
): boolean {
  const match = /^data:image\/([\w.+-]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) return false;
  try {
    const extRaw = match[1].toLowerCase();
    const ext = extRaw === "jpeg" ? "jpg" : extRaw === "svg+xml" ? "svg" : extRaw;
    const buf = Buffer.from(match[2], "base64");
    const tmpPath = path.join(os.tmpdir(), `jefr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`);
    fs.writeFileSync(tmpPath, buf);
    const tgt = target !== undefined ? target : targetAgentId();
    const item = sendImageTo(tgt, tmpPath, caption, dataUrl);
    // Echo into the panel history with the inline data so it shows a thumbnail.
    pushHistoryItem({ ...item, dataUrl });
    // Record in the shared history so all front-ends can render it.
    appendSharedHistory({
      id: item.id,
      kind: "image",
      dataUrl,
      caption,
      name: path.basename(tmpPath),
      path: tmpPath,
      timestamp: item.timestamp,
    });
    return true;
  } catch {
    return false;
  }
}

const WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const PREFERRED_PORT = 39517;
/** Largest single WS message / HTTP body we accept (guards against a malformed
 *  or hostile frame growing the read buffer without bound). Images are a few MB. */
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
/** Retries on the preferred port before falling back to an ephemeral one — a
 *  window reload can leave the old host holding the port for a beat. */
const PORT_RETRY_MAX = 6;
const PORT_RETRY_DELAY_MS = 400;
/** Where the chosen port is published so a port-aware client can discover it
 *  even if we had to fall back off the preferred port. */
const PORT_FILE = path.join(os.homedir(), ".moyu-message", "server.json");

function writePortFile(port: number): void {
  try {
    fs.mkdirSync(path.dirname(PORT_FILE), { recursive: true });
    fs.writeFileSync(
      PORT_FILE,
      JSON.stringify({ port, pid: process.pid, preferred: PREFERRED_PORT, ts: Date.now() }),
      "utf-8",
    );
  } catch {
    // best-effort discovery file
  }
}

function removePortFile(): void {
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {
    // already gone
  }
}

interface WsClient {
  socket: Socket;
  alive: boolean;
}

interface WorkspaceInfo {
  name: string;
  path: string;
}

let server: Server | null = null;
let wsClients: WsClient[] = [];
let serverPort = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastPushState = "";
let _workspaceInfo: WorkspaceInfo = { name: "", path: "" };
/** Mirrors the jefr panel's Agent Picker — Obsidian sends follow this target. */
let _selectedAgentId: string | undefined;

export function setWorkspaceInfo(name: string, wsPath: string): void {
  _workspaceInfo = { name, path: wsPath };
}

export function setSelectedAgentId(agentId?: string): void {
  _selectedAgentId = agentId && agentId.trim() ? agentId.trim() : undefined;
  lastPushState = "";
  broadcastStateNow();
}

function targetAgentId(): string | undefined {
  return _selectedAgentId || readSelectedAgentId();
}

export function getServerPort(): number {
  return serverPort;
}

export function getConnectedClients(): number {
  return wsClients.length;
}

export function startLocalServer(
  port: number = PREFERRED_PORT,
  attempt = 0,
): Promise<number> {
  return new Promise((resolve, reject) => {
    if (server) {
      resolve(serverPort);
      return;
    }
    let settled = false;
    const srv = http.createServer(handleHttp);
    srv.on("upgrade", handleUpgrade);
    srv.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        srv.close();
      } catch {
        // ignore
      }
      if (err && err.code === "EADDRINUSE" && port === PREFERRED_PORT) {
        if (attempt < PORT_RETRY_MAX) {
          // A previous extension host (window reload) may still be releasing the
          // port. Retry the SAME preferred port briefly so a fixed-port client
          // (Obsidian) keeps working across reloads instead of us hopping ports.
          setTimeout(
            () => startLocalServer(PREFERRED_PORT, attempt + 1).then(resolve, reject),
            PORT_RETRY_DELAY_MS,
          );
        } else {
          // Still taken — fall back to an ephemeral port, but publish it in the
          // port file and warn loudly so the mismatch is diagnosable.
          console.warn(
            `[jefr] port ${PREFERRED_PORT} is still in use after ${PORT_RETRY_MAX} retries; ` +
              `falling back to an ephemeral port. A fixed-port client must read ${PORT_FILE}.`,
          );
          startLocalServer(0, attempt + 1).then(resolve, reject);
        }
      } else {
        reject(err);
      }
    });
    srv.listen(port, "127.0.0.1", () => {
      if (settled) {
        return;
      }
      settled = true;
      server = srv;
      serverPort = (srv.address() as { port: number }).port;
      writePortFile(serverPort);
      if (serverPort !== PREFERRED_PORT) {
        console.warn(
          `[jefr] local server bound to ${serverPort} (preferred ${PREFERRED_PORT} unavailable). ` +
            `Clients should read the port from ${PORT_FILE}.`,
        );
      }
      startPushPolling();
      resolve(serverPort);
    });
  });
}

export function stopLocalServer(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  for (const c of wsClients) {
    try {
      c.socket.destroy();
    } catch {
      // ignore
    }
  }
  wsClients = [];
  if (server) {
    server.close();
    server = null;
    serverPort = 0;
  }
  removePortFile();
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
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
    const aid = targetAgentId();
    const q = readQuestionFor(aid);
    const reply = readReplyFor(aid);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        cardActive: true,
        cardCode: null,
        cardExpiresAt: null,
        queueCount: getQueueCountFor(aid),
        queue: readQueueFor(aid),
        hasQuestion: !!q,
        hasReply: !!reply,
        workspace: _workspaceInfo,
        wsClients: wsClients.length,
        agent: getAgentStatusFor(aid),
        selectedAgentId: aid || null,
        port: serverPort,
      })
    );
    return;
  }
  if (req.url === "/api/send" && req.method === "POST") {
    let body = "";
    let aborted = false;
    req.on("data", (chunk) => {
      if (aborted) return;
      body += chunk;
      // Guard against an unbounded request body (OOM). 413 + drop the socket.
      if (body.length > MAX_MESSAGE_BYTES) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: false, error: "Payload too large" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted) return;
      try {
        const data = JSON.parse(body);
        if (data.text) {
          const aid = targetAgentId();
          const item = sendTextTo(aid, data.text);
          pushHistoryItem({
            id: item.id,
            type: "text",
            content: data.text,
            timestamp: item.timestamp,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
          broadcastWs({ type: "queueUpdate", count: getQueueCountFor(aid) });
          broadcastStateNow();
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

function handleUpgrade(req: IncomingMessage, socket: Socket): void {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + WS_MAGIC)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  const client: WsClient = { socket, alive: true };
  wsClients.push(client);
  const pushState = buildPushState();
  wsSend(socket, JSON.stringify({ type: "init", ...pushState }));
  let buffer = Buffer.alloc(0);
  // Reassembly state for fragmented messages (a data frame with FIN=0 followed
  // by opcode-0 continuation frames). Most clients send a single frame, but
  // handling fragments keeps large/streamed messages from being dropped.
  let fragOpcode = 0;
  let fragParts: Buffer[] = [];
  let fragBytes = 0;
  const resetFrag = () => {
    fragOpcode = 0;
    fragParts = [];
    fragBytes = 0;
  };
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    // Guard: never let the read buffer grow without bound (malformed/huge frame).
    if (buffer.length > MAX_MESSAGE_BYTES) {
      removeClient(client);
      return;
    }
    while (buffer.length >= 2) {
      const parsed = parseFrame(buffer);
      if (!parsed) {
        break;
      }
      buffer = buffer.subarray(parsed.totalLength);
      // Control frames (8/9/10) can be interleaved between data fragments.
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
      // Data frames: 1 = text (start), 2 = binary (start), 0 = continuation.
      if (parsed.opcode === 1 || parsed.opcode === 2 || parsed.opcode === 0) {
        if (parsed.opcode !== 0) {
          // A new data message starts — drop any incomplete prior fragment.
          fragOpcode = parsed.opcode;
          fragParts = [];
          fragBytes = 0;
        }
        fragParts.push(parsed.payload);
        fragBytes += parsed.payload.length;
        if (fragBytes > MAX_MESSAGE_BYTES) {
          resetFrag();
          removeClient(client);
          return;
        }
        if (parsed.fin) {
          const full = Buffer.concat(fragParts);
          const op = fragOpcode;
          resetFrag();
          if (op === 1) {
            handleWsMessage(client, full.toString("utf-8"));
          }
          // binary (op === 2) is unused by the protocol; ignored.
        }
      }
    }
  });
  socket.on("close", () => removeClient(client));
  socket.on("error", () => removeClient(client));
}

// Recently-seen client message ids, so a resend (after a missed ack) is
// idempotent and never enqueues the same message twice.
const recentCids = new Set<string>();
const recentCidOrder: string[] = [];
function seenCid(cid: unknown): boolean {
  if (typeof cid !== "string" || !cid) return false;
  if (recentCids.has(cid)) return true;
  recentCids.add(cid);
  recentCidOrder.push(cid);
  if (recentCidOrder.length > 500) {
    const old = recentCidOrder.shift();
    if (old) recentCids.delete(old);
  }
  return false;
}

/** Reply to a request with a structured ack (new protocol). No-op without a cid. */
function ack(
  client: WsClient,
  cid: unknown,
  ok: boolean,
  extra?: Record<string, unknown>,
): void {
  if (typeof cid !== "string" || !cid) return;
  wsSend(client.socket, JSON.stringify({ type: "ack", cid, ok, ...extra }));
}

function handleWsMessage(client: WsClient, raw: string): void {
  try {
    const msg = JSON.parse(raw);
    const aid = targetAgentId();
    switch (msg.type) {
      // ── New composite message envelope ──────────────────────────────────
      // { type:"send", cid, targetAgentId?, text?, attachments:[{kind,dataUrl,...}] }
      // One request carries text + image(s) together; replies with a single
      // { type:"ack", cid, ok, queued, error? }. Idempotent by cid.
      case "send": {
        const target =
          typeof msg.targetAgentId === "string" && msg.targetAgentId.trim()
            ? msg.targetAgentId.trim()
            : aid;
        if (seenCid(msg.cid)) {
          ack(client, msg.cid, true, { duplicate: true });
          break;
        }
        const text = typeof msg.text === "string" ? msg.text.trim() : "";
        const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
        const images = atts.filter(
          (a: { kind?: string; dataUrl?: string }) =>
            a && a.kind === "image" && typeof a.dataUrl === "string",
        );
        let queued = 0;
        try {
          if (images.length > 0) {
            // Text rides with the first image as its caption → one message.
            images.forEach((a: { dataUrl: string }, i: number) => {
              if (handlePastedImage(a.dataUrl, i === 0 ? text : "", target)) {
                queued++;
              }
            });
          } else if (text) {
            const item = sendTextTo(target, text);
            pushHistoryItem({
              id: item.id,
              type: "text",
              content: text,
              timestamp: item.timestamp,
            });
            queued++;
          }
          ack(client, msg.cid, true, { queued });
          broadcastWs({ type: "queueUpdate", count: getQueueCountFor(target) });
          broadcastStateNow();
        } catch (e) {
          ack(client, msg.cid, false, { error: String(e), queued });
        }
        break;
      }
      case "sendText":
        if (msg.text) {
          // De-dupe resends by client id; always ack so the client stops resending.
          if (!seenCid(msg.cid)) {
            const item = sendTextTo(aid, msg.text);
            pushHistoryItem({
              id: item.id,
              type: "text",
              content: msg.text,
              timestamp: item.timestamp,
            });
          }
          if (msg.cid) wsSend(client.socket, JSON.stringify({ type: "sendAck", cid: msg.cid }));
          broadcastWs({ type: "queueUpdate", count: getQueueCountFor(aid) });
          broadcastStateNow();
        }
        break;
      case "sendImage":
        if (msg.dataUrl) {
          const fresh = !seenCid(msg.cid);
          if (!fresh || handlePastedImage(msg.dataUrl, msg.caption)) {
            if (msg.cid) wsSend(client.socket, JSON.stringify({ type: "sendAck", cid: msg.cid }));
            broadcastWs({ type: "queueUpdate", count: getQueueCountFor(aid) });
            broadcastStateNow();
          }
        }
        break;
      case "submitAnswer":
        if (msg.data) {
          writeAnswerFor(msg.data, aid);
        }
        break;
      case "cancelQuestion":
        cancelQuestionFor(aid);
        break;
      case "ackReply":
        clearReplyFor(aid);
        break;
      case "deleteQueueItem":
        if (msg.id) {
          deleteQueueItemFor(msg.id, aid);
          broadcastWs({ type: "queueUpdate", count: getQueueCountFor(aid) });
          broadcastStateNow();
        }
        break;
      case "clearQueue":
        clearQueueFor(aid);
        broadcastWs({ type: "queueUpdate", count: getQueueCountFor(aid) });
        broadcastStateNow();
        break;
      case "ping":
        wsSend(client.socket, JSON.stringify({ type: "pong" }));
        break;
    }
  } catch {
    // ignore
  }
}

function removeClient(client: WsClient): void {
  const idx = wsClients.indexOf(client);
  if (idx !== -1) {
    wsClients.splice(idx, 1);
  }
  try {
    client.socket.destroy();
  } catch {
    // ignore
  }
}

function broadcastWs(data: unknown): void {
  const msg = JSON.stringify(data);
  for (const c of wsClients) {
    wsSend(c.socket, msg);
  }
}

interface ParsedFrame {
  opcode: number;
  fin: boolean;
  payload: Buffer;
  totalLength: number;
}

function parseFrame(buf: Buffer): ParsedFrame | null {
  if (buf.length < 2) {
    return null;
  }
  const fin = (buf[0] & 128) !== 0;
  const opcode = buf[0] & 15;
  const masked = (buf[1] & 128) !== 0;
  let payloadLen = buf[1] & 127;
  let offset = 2;
  if (payloadLen === 126) {
    if (buf.length < 4) {
      return null;
    }
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) {
      return null;
    }
    payloadLen = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLen = masked ? 4 : 0;
  const totalLength = offset + maskLen + payloadLen;
  if (buf.length < totalLength) {
    return null;
  }
  let payload = buf.subarray(offset + maskLen, offset + maskLen + payloadLen);
  if (masked) {
    const mask = buf.subarray(offset, offset + 4);
    payload = Buffer.from(payload);
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i % 4];
    }
  }
  return { opcode, fin, payload, totalLength };
}

function buildFrame(payload: string | Buffer, opcode = 1): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload, "utf-8") : payload;
  const len = data.length;
  let header: Buffer;
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

function wsSend(socket: Socket, msg: string): void {
  try {
    wsSendRaw(socket, buildFrame(msg));
  } catch {
    // ignore
  }
}

function wsSendRaw(socket: Socket, buf: Buffer): void {
  try {
    socket.write(buf);
  } catch {
    // ignore
  }
}

function buildPushState() {
  const aid = targetAgentId();
  return {
    cardActive: true,
    cardCode: null,
    cardExpiresAt: null,
    queueCount: getQueueCountFor(aid),
    queue: readQueueFor(aid),
    question: readQuestionFor(aid),
    reply: readReplyFor(aid),
    history: readSharedHistory(),
    workspace: _workspaceInfo,
    wsClients: wsClients.length,
    agent: getAgentStatusFor(aid),
    selectedAgentId: aid || null,
    port: serverPort,
  };
}

/** Push the full current state to all clients immediately (used right after a
 *  send so shared history updates feel instant rather than waiting for the poll). */
function broadcastStateNow(): void {
  if (wsClients.length === 0) return;
  const state = JSON.stringify(buildPushState());
  lastPushState = state;
  broadcastWs({ type: "stateUpdate", ...JSON.parse(state) });
}

/** Mirror a new final reply (no percent) into the shared history. The extension
 *  is the SINGLE writer of history.json, so doing this here (rather than in the
 *  separate MCP server process) avoids lost-write races that dropped messages. */
function syncReplyToHistory(): void {
  try {
    const reply = readReplyFor(targetAgentId());
    if (!reply || !reply.content) return;
    appendReplyToSharedHistory(reply);
  } catch {
    // best-effort
  }
}

function startPushPolling(): void {
  if (pollTimer) {
    return;
  }
  pollTimer = setInterval(() => {
    syncReplyToHistory(); // always, even with no ws clients
    if (wsClients.length === 0) {
      return;
    }
    const state = JSON.stringify(buildPushState());
    if (state !== lastPushState) {
      lastPushState = state;
      broadcastWs({ type: "stateUpdate", ...JSON.parse(state) });
    }
  }, 500);
}

function getControlPanelHtml(): string {
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
.compose-area.drop-hl .compose-input{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.thumbs{display:flex;flex-wrap:wrap;gap:8px}
.thumbs:empty{display:none}
.thumb-chip{position:relative;width:56px;height:56px;border-radius:8px;overflow:hidden;border:1px solid var(--border-strong);background:var(--surface-2)}
.thumb-chip img{width:100%;height:100%;object-fit:cover;display:block}
.thumb-rm{position:absolute;top:2px;right:2px;width:18px;height:18px;padding:0;border:none;border-radius:50%;background:rgba(0,0,0,0.6);color:#fff;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center}
.thumb-rm:hover{background:rgba(0,0,0,0.8)}
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
.msgs{max-height:320px;overflow-y:auto;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
.msg-row{display:flex;flex-direction:column;align-items:flex-end;margin-left:auto;max-width:88%}
.msg-row.msg-ai{align-items:flex-start;margin-left:0;margin-right:auto}
.msg-text{background:linear-gradient(135deg,#6d5cf0,#4f46e5);color:#fff;padding:8px 12px;border-radius:14px;border-bottom-right-radius:4px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.msg-reply{background:var(--surface-2);color:var(--fg);border:1px solid var(--border);padding:8px 12px;border-radius:14px;border-bottom-left-radius:4px;font-size:13px;line-height:1.5;white-space:pre-wrap;word-break:break-word}
.msg-img{max-width:100%;max-height:220px;border-radius:12px;display:block}
.msg-cap{background:linear-gradient(135deg,#6d5cf0,#4f46e5);color:#fff;padding:6px 11px;border-radius:12px;border-bottom-right-radius:4px;font-size:12px;margin-top:4px}
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
		<div class="stat-card"><div id="statAgent" class="stat-val off">-</div><div class="stat-label">Agent</div></div>
		<div class="stat-card"><div id="statQueue" class="stat-val num">0</div><div class="stat-label">Queue</div></div>
		<div class="stat-card"><div id="statWs" class="stat-val num">0</div><div class="stat-label">Clients</div></div>
	</div>

	<!-- Send message -->
	<div class="card highlight">
		<div class="card-head"><span class="card-title">Send message</span><span id="sendStatus"></span></div>
		<div class="card-body">
			<div class="compose-area">
				<div id="thumbs" class="thumbs"></div>
				<textarea id="msgInput" class="compose-input" placeholder="Type a message, or paste / drop an image..." rows="3"></textarea>
				<div class="compose-row">
					<span class="compose-hint">Ctrl+Enter to send &middot; paste an image</span>
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

	<!-- Conversation (shared history) -->
	<div class="card">
		<div class="card-head"><span class="card-title">Conversation</span></div>
		<div id="msgs" class="msgs"><div class="empty">No messages yet</div></div>
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
var input=$('msgInput'),sendBtn=$('sendBtn'),sendStatus=$('sendStatus'),thumbs=$('thumbs');
var pendingImages=[];
function canSend(){return (!!input.value.trim()||pendingImages.length>0)&&ws&&ws.readyState===1}
function updateSendBtn(){sendBtn.disabled=!canSend()}
function renderThumbs(){
	if(!thumbs)return;
	thumbs.innerHTML='';
	for(var i=0;i<pendingImages.length;i++){
		(function(img){
			var chip=document.createElement('div');chip.className='thumb-chip';
			var im=document.createElement('img');im.src=img.dataUrl;chip.appendChild(im);
			var rm=document.createElement('button');rm.className='thumb-rm';rm.textContent='\\u00D7';
			rm.onclick=function(){pendingImages=pendingImages.filter(function(x){return x.id!==img.id});renderThumbs();updateSendBtn()};
			chip.appendChild(rm);thumbs.appendChild(chip);
		})(pendingImages[i]);
	}
}
function stageImage(dataUrl){
	if(!dataUrl)return;
	pendingImages.push({id:Date.now()+'-'+Math.random().toString(36).slice(2,7),dataUrl:dataUrl});
	renderThumbs();updateSendBtn();
}
function ingestFiles(files){
	for(var i=0;i<files.length;i++){
		var f=files[i];
		if(f.type&&f.type.indexOf('image/')===0){
			(function(){var r=new FileReader();r.onload=function(ev){stageImage(String(ev.target.result||''))};r.readAsDataURL(f)})();
		}
	}
}
input.addEventListener('input',updateSendBtn);
input.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();doSend()}});
input.addEventListener('paste',function(e){
	var dt=e.clipboardData;if(!dt)return;
	var files=[];
	if(dt.files&&dt.files.length){for(var i=0;i<dt.files.length;i++)files.push(dt.files[i]);}
	else if(dt.items){for(var j=0;j<dt.items.length;j++){var it=dt.items[j];if(it.kind==='file'){var f=it.getAsFile();if(f)files.push(f);}}}
	var imgs=files.filter(function(f){return f.type&&f.type.indexOf('image/')===0});
	if(imgs.length){e.preventDefault();ingestFiles(imgs);}
});
var dropZone=input.parentNode;
dropZone.addEventListener('dragover',function(e){e.preventDefault();dropZone.classList.add('drop-hl')});
dropZone.addEventListener('dragleave',function(){dropZone.classList.remove('drop-hl')});
dropZone.addEventListener('drop',function(e){e.preventDefault();dropZone.classList.remove('drop-hl');var files=e.dataTransfer&&e.dataTransfer.files;if(files&&files.length)ingestFiles(Array.prototype.slice.call(files));});
sendBtn.addEventListener('click',doSend);
function doSend(){
	if(!canSend())return;
	var txt=input.value.trim();
	var atts=pendingImages.map(function(im){return {kind:'image',dataUrl:im.dataUrl}});
	var cid='c'+Date.now()+'-'+Math.random().toString(36).slice(2,7);
	// One composite message (text + image[s]) instead of separate sends.
	ws.send(JSON.stringify({type:'send',cid:cid,text:txt,attachments:atts}));
	log('Send: '+(txt?txt.substring(0,40):'')+(atts.length?' [+'+atts.length+' image]':''));
	input.value='';pendingImages=[];renderThumbs();updateSendBtn();
	sendStatus.innerHTML='<span class="sent-ok">Sent</span>';
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
		var it=items[i],tp=it.type||'text';
		var time=it.timestamp?new Date(it.timestamp).toLocaleTimeString():'';
		var contentHtml;
		if(tp==='image'){
			contentHtml=(it.dataUrl?'<img src="'+it.dataUrl+'" style="max-width:120px;max-height:90px;border-radius:6px;display:block;margin-bottom:4px">':'')+(it.caption?'<div>'+esc(it.caption)+'</div>':(it.dataUrl?'':'[Image]'));
		}else if(tp==='file'){
			contentHtml=esc('[File] '+((it.path||'').split(/[\\/\\\\]/).pop()||''));
		}else{
			contentHtml=esc((it.content||'').substring(0,120));
		}
		h+='<div class="queue-item"><span class="qi-type '+tp+'">'+({text:'Text',image:'Image',file:'File'}[tp]||tp)+'</span><span class="qi-content">'+contentHtml+'</span><span class="qi-time">'+time+'</span></div>';
	}
	L.innerHTML=h;
}

var msgIds={};
function renderMessages(history){
	if(!history)return;
	var M=$('msgs');if(!M)return;
	if(history.length&&M.querySelector('.empty'))M.innerHTML='';
	for(var i=0;i<history.length;i++){
		var it=history[i];if(!it||!it.id||msgIds[it.id])continue;msgIds[it.id]=1;
		var row=document.createElement('div');row.className='msg-row'+(it.kind==='reply'?' msg-ai':'');
		if(it.kind==='image'&&it.dataUrl){
			var im=document.createElement('img');im.className='msg-img';im.src=it.dataUrl;row.appendChild(im);
			if(it.caption){var c=document.createElement('div');c.className='msg-cap';c.textContent=it.caption;row.appendChild(c);}
		}else{
			var t=document.createElement('div');t.className=it.kind==='reply'?'msg-reply':'msg-text';t.textContent=it.kind==='file'?('[File] '+(it.name||'')):(it.caption||it.text||'');row.appendChild(t);
		}
		M.appendChild(row);
	}
	M.scrollTop=M.scrollHeight;
}
function updateDashboard(d){
	$('statConn').textContent=d.cardActive?'Online':'Offline';$('statConn').className='stat-val '+(d.cardActive?'on':'off');
	var ag=d.agent||{alive:false,state:'idle'};
	var agText=ag.alive?(ag.state==='working'?'Busy':'Listening'):'None';
	$('statAgent').textContent=agText;
	$('statAgent').className='stat-val '+(ag.alive?(ag.state==='working'?'num':'on'):'off');
	$('statQueue').textContent=d.queueCount||0;
	$('statWs').textContent=d.wsClients||0;
	if(d.workspace){$('wsName').textContent=d.workspace.name||'-';$('wsPath').textContent=d.workspace.path||'-'}
	$('wsCard').textContent=d.cardCode||'-';
	$('wsExpire').textContent=d.cardExpiresAt?new Date(d.cardExpiresAt).toLocaleString():'-';
	renderQueue(d.queue||[]);
	renderMessages(d.history||[]);
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
			else if(m.type==='ack'){if(!m.ok)log('Send failed: '+(m.error||'unknown'))}
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
