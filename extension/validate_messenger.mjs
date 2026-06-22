// validate_messenger.mjs — exercises the REAL messenger.ts per-agent functions
// (compiled standalone to dist/messenger.test.mjs) against a temp data dir.
// messenger.ts has no vscode imports, so this tests the actual shipping logic.
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const M = await import(pathToFileURL(path.join(__dirname, "dist", "messenger.test.mjs")).href);

const TMP = path.join(os.tmpdir(), "jefr-msgr-" + Date.now());
fsSync.mkdirSync(TMP, { recursive: true });
M.setDataDir(TMP);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  — " + e : ""}`); };

const A = "2172207b-002c-4d84-b22b-c4fcd585286e";
const B = "cb6c7115-1dce-43f6-b760-59aca419802c";

// 1) per-agent send isolation
M.sendTextTo(A, "to-A");
M.sendTextTo(B, "to-B");
const qA = M.readQueueFor(A), qB = M.readQueueFor(B);
ok("sendTextTo(A) lands only in A's queue", qA.length === 1 && qA[0].content === "to-A");
ok("sendTextTo(B) lands only in B's queue", qB.length === 1 && qB[0].content === "to-B");
ok("getQueueCountFor reflects per-agent counts", M.getQueueCountFor(A) === 1 && M.getQueueCountFor(B) === 1);

// 2) backward-compat: no agent id -> shared root queue (not under agents/)
M.sendTextTo(undefined, "root-msg");
const rootQueue = JSON.parse(fsSync.readFileSync(path.join(TMP, "queue.json"), "utf-8"));
ok("sendTextTo(undefined) writes the shared ROOT queue", rootQueue.length === 1 && rootQueue[0].content === "root-msg");
ok("root send did not leak into agents/", M.readQueueFor(A).length === 1);

// 3) queue edit ops are per-agent
M.sendTextTo(A, "to-A-2");
ok("A queue now has 2", M.getQueueCountFor(A) === 2);
M.deleteQueueItemFor(M.readQueueFor(A)[0].id, A);
ok("deleteQueueItemFor removes one from A", M.getQueueCountFor(A) === 1);
M.clearQueueFor(A);
ok("clearQueueFor empties only A", M.getQueueCountFor(A) === 0 && M.getQueueCountFor(B) === 1);

// 4) reply round-trip per agent
fsSync.writeFileSync(path.join(M.agentDirFor(A), "reply.json"), JSON.stringify({ content: "R-A", timestamp: "t" }));
ok("readReplyFor(A) reads A's reply", M.readReplyFor(A)?.content === "R-A");
ok("readReplyFor(B) is null (no reply)", M.readReplyFor(B) === null);
M.clearReplyFor(A);
ok("clearReplyFor(A) clears it", M.readReplyFor(A) === null);

// 5) question + answer round-trip per agent
fsSync.writeFileSync(
  path.join(M.agentDirFor(B), "question.json"),
  JSON.stringify({ id: "q1", questions: [{ id: "q0", question: "Q?", options: [] }] })
);
ok("readQuestionFor(B) reads B's question", M.readQuestionFor(B)?.id === "q1");
M.writeAnswerFor({ id: "q1", answers: [{ questionId: "q0", selected: [], other: "hi" }] }, B);
const ans = JSON.parse(fsSync.readFileSync(path.join(M.agentDirFor(B), "answer.json"), "utf-8"));
ok("writeAnswerFor(B) writes B's answer", ans.id === "q1");

// 6) roster: connected vs dropped vs never-beat
const beat = (id, ageMs) => fsSync.writeFileSync(
  path.join(M.agentDirFor(id), "agent-alive.json"),
  JSON.stringify({ ts: Date.now() - ageMs, pid: 1, state: "waiting", agentId: id })
);
beat(A, 500);            // fresh -> connected
beat(B, 60_000);         // stale -> dropped (B already has a dir)
M.sendTextTo("00staleonly", "x"); beat("00staleonly", 99_000); // dropped
const roster = M.scanAllAgents();
const find = (id) => roster.find((r) => r.id === id);
ok("scanAllAgents marks fresh A connected", find(A)?.connected === true);
ok("scanAllAgents marks stale B disconnected", find(B)?.connected === false);
ok("scanAllAgents includes dropped agents", !!find("00staleonly") && find("00staleonly").connected === false);
const live = M.listLiveAgents();
ok("listLiveAgents returns only fresh agents", live.length === 1 && live[0].id === A);

// 7) agent id sanitization can't escape the agents/ root: the resolved dir must
//    remain a DIRECT child of <dataDir>/agents (separators are stripped).
const evil = M.agentDirFor("../../etc/evil");
const agentsRoot = path.join(TMP, "agents");
ok(
  "agentDirFor stays within agents/ (no traversal)",
  path.dirname(path.resolve(evil)) === path.resolve(agentsRoot),
  evil
);

fsSync.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
