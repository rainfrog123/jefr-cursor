// proto_multiagent.mjs — isolated proof that per-agent_id queue partitioning
// routes messages to the right agent with NO cross-talk, using the same
// file-IPC model as the real jefr server (just namespaced by agent_id).
//
// Run: node proto_multiagent.mjs
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const ROOT = path.join(os.tmpdir(), "jefr-proto-" + Date.now());

// --- server-side helpers (mirror of index.ts, but namespaced) ----------------
const agentDir = (id) => (id ? path.join(ROOT, "agents", id) : ROOT);
const queueFile = (id) => path.join(agentDir(id), "queue.json");
const aliveFile = (id) => path.join(agentDir(id), "agent-alive.json");

async function readQueue(id) {
  try { return JSON.parse(await fs.readFile(queueFile(id), "utf-8")); } catch { return []; }
}
// The ONLY change from today's server: drain is scoped to the agent's own dir.
async function drainQueue(id) {
  const q = await readQueue(id);
  if (q.length) await fs.writeFile(queueFile(id), "[]");
  return q;
}
async function touchAlive(id, state) {
  await fs.mkdir(agentDir(id), { recursive: true });
  await fs.writeFile(aliveFile(id), JSON.stringify({ ts: Date.now(), state, agentId: id }));
}
// panel-side: discover live agents (fresh heartbeat) by scanning agents/*/
async function listLiveAgents(maxAgeMs = 10000) {
  const dir = path.join(ROOT, "agents");
  let ids = [];
  try { ids = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const id of ids) {
    try {
      const a = JSON.parse(await fs.readFile(aliveFile(id), "utf-8"));
      if (Date.now() - a.ts <= maxAgeMs) out.push({ id, state: a.state });
    } catch {}
  }
  return out;
}
// panel-side: route a send to a SPECIFIC agent's queue
async function sendTo(id, text) {
  await fs.mkdir(agentDir(id), { recursive: true });
  const q = await readQueue(id);
  q.push({ type: "text", content: text, ts: Date.now() });
  await fs.writeFile(queueFile(id), JSON.stringify(q));
}

// --- simulate two agents looping check_messages(agent_id) --------------------
function makeAgent(id) {
  const received = [];
  let stop = false;
  const loop = (async () => {
    await touchAlive(id, "waiting");
    while (!stop) {
      const msgs = await drainQueue(id);
      for (const m of msgs) received.push(m.content);
      await touchAlive(id, "waiting");
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  return { id, received, stop: () => { stop = true; return loop; } };
}

async function main() {
  const A = makeAgent("2172207b-002c-4d84-b22b-c4fcd585286e"); // tile 0
  const B = makeAgent("cb6c7115-1dce-43f6-b760-59aca419802c"); // tile 1
  await new Promise((r) => setTimeout(r, 60));

  console.log("live agents:", JSON.stringify(await listLiveAgents()));

  // Panel sends, each addressed to a specific agent:
  await sendTo(A.id, "msg-1 -> A");
  await sendTo(B.id, "msg-2 -> B");
  await sendTo(A.id, "msg-3 -> A");
  await sendTo(B.id, "msg-4 -> B");
  await new Promise((r) => setTimeout(r, 200));

  await A.stop(); await B.stop();

  console.log("A.received:", JSON.stringify(A.received));
  console.log("B.received:", JSON.stringify(B.received));

  const aOk = JSON.stringify(A.received) === JSON.stringify(["msg-1 -> A", "msg-3 -> A"]);
  const bOk = JSON.stringify(B.received) === JSON.stringify(["msg-2 -> B", "msg-4 -> B"]);
  const noCrossTalk = !A.received.some((m) => m.includes("B")) && !B.received.some((m) => m.includes("A"));
  console.log("\nRESULT:", aOk && bOk && noCrossTalk ? "PASS — clean routing, zero cross-talk" : "FAIL");

  await fs.rm(ROOT, { recursive: true, force: true });
}
main();
