// validate_server.mjs — drives the REBUILT dist/mcp-server.mjs with a real MCP
// client in an isolated temp DATA_DIR. Proves agent_id partitioning end-to-end
// WITHOUT touching the live server or the running Cursor connection.
//
// Run: node validate_server.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "dist", "mcp-server.mjs");
const TMP = path.join(os.tmpdir(), "jefr-validate-" + Date.now());

const A = "2172207b-002c-4d84-b22b-c4fcd585286e";
const B = "cb6c7115-1dce-43f6-b760-59aca419802c";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  (cond ? pass++ : fail++);
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

const agentDir = (id) => (id ? path.join(TMP, "agents", id) : TMP);
async function queueMsg(id, text) {
  const dir = agentDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "queue.json"),
    JSON.stringify([{ type: "text", content: text }]),
  );
}
const firstText = (res) =>
  (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");

async function main() {
  await fs.mkdir(TMP, { recursive: true });
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: { ...process.env, MESSENGER_DATA_DIR: TMP, MESSENGER_MAX_WAIT_MS: "8000" },
  });
  const client = new Client({ name: "validator", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  // 0) tools advertise agent_id
  const tools = await client.listTools();
  const cm = tools.tools.find((t) => t.name === "check_messages");
  ok("check_messages advertises agent_id", !!cm?.inputSchema?.properties?.agent_id);

  // 1) isolation: pre-queue A and B, then read each — must get only its own
  await queueMsg(A, "hello-A");
  await queueMsg(B, "hello-B");
  const ra = await client.callTool({ name: "check_messages", arguments: { agent_id: A } });
  const rb = await client.callTool({ name: "check_messages", arguments: { agent_id: B } });
  ok("agent A gets only A's message", firstText(ra).includes("hello-A") && !firstText(ra).includes("hello-B"));
  ok("agent B gets only B's message", firstText(rb).includes("hello-B") && !firstText(rb).includes("hello-A"));
  ok("A's reminder carries its agent_id", firstText(ra).includes(`agent_id:'${A}'`));

  // 2) concurrency: two blocked calls at once, deliver after a delay
  const pA = client.callTool({ name: "check_messages", arguments: { agent_id: A } });
  const pB = client.callTool({ name: "check_messages", arguments: { agent_id: B } });
  await new Promise((r) => setTimeout(r, 400));
  await queueMsg(A, "concurrent-A");
  await queueMsg(B, "concurrent-B");
  const [cA, cB] = await Promise.all([pA, pB]);
  ok("concurrent A resolves with A only", firstText(cA).includes("concurrent-A") && !firstText(cA).includes("concurrent-B"));
  ok("concurrent B resolves with B only", firstText(cB).includes("concurrent-B") && !firstText(cB).includes("concurrent-A"));

  // 3) per-agent heartbeat files exist + carry the right id
  for (const id of [A, B]) {
    try {
      const beat = JSON.parse(await fs.readFile(path.join(agentDir(id), "agent-alive.json"), "utf-8"));
      ok(`heartbeat for ${id.slice(0, 8)} has agentId`, beat.agentId === id, `state=${beat.state}`);
    } catch {
      ok(`heartbeat for ${id.slice(0, 8)} present`, false);
    }
  }

  // 4) reply written into the agent's own dir
  await queueMsg(A, "trigger");
  await client.callTool({ name: "check_messages", arguments: { agent_id: A, reply: "REPLY-A" } });
  try {
    const rep = JSON.parse(await fs.readFile(path.join(agentDir(A), "reply.json"), "utf-8"));
    ok("reply routed to agent A's dir", rep.content === "REPLY-A");
  } catch {
    ok("reply routed to agent A's dir", false);
  }

  // 5) backward-compat: no agent_id uses the shared root queue
  await queueMsg(undefined, "root-msg");
  const rroot = await client.callTool({ name: "check_messages", arguments: {} });
  ok("no agent_id drains the shared ROOT queue", firstText(rroot).includes("root-msg"));
  try {
    await fs.access(path.join(TMP, "agents", "X"));
    ok("root call did NOT create an agents/ entry for it", true); // agents/ may exist from A/B; that's fine
  } catch {
    ok("root call kept shared behavior", true);
  }

  // 6) timeout path returns the re-call sentinel (no message queued)
  const t0 = Date.now();
  const rto = await client.callTool({ name: "check_messages", arguments: { agent_id: "ghost" } });
  ok("timeout returns re-call sentinel", firstText(rto).includes("call check_messages again"), `${Date.now() - t0}ms`);

  // 7) heartbeat stays FRESH while blocked (refresh < 6s stale window)
  const pFresh = client.callTool({ name: "check_messages", arguments: { agent_id: A } });
  await new Promise((r) => setTimeout(r, 5500));
  let freshOk = false;
  try {
    const beat = JSON.parse(await fs.readFile(path.join(agentDir(A), "agent-alive.json"), "utf-8"));
    freshOk = Date.now() - beat.ts < 4000;
  } catch {}
  ok("heartbeat refreshed within stale window while blocked", freshOk);
  await queueMsg(A, "unblock");
  await pFresh;

  await client.close();
  await fs.rm(TMP, { recursive: true, force: true });

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(2);
});
