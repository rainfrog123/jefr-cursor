// validate_agentstats.mjs — tests the REAL agentStats.ts reconcile/pickReconnect
// (compiled standalone). Covers connect/reconnect counting, drop detection,
// debounce, and that never-connected agents are not reconnected.
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const S = await import(pathToFileURL(path.join(__dirname, "dist", "agentStats.test.mjs")).href);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  — " + e : ""}`); };

const stats = new Map();
const entry = (id, connected, state = "waiting", q = 0) => ({ id, connected, state, queueCount: q });
const viewOf = (res, id) => res.views.find((v) => v.id === id);

let now = 1000;

// 1) first connect
let r = S.reconcile([entry("A", true)], stats, now);
ok("first connect -> connectCount 1", viewOf(r, "A").connectCount === 1);
ok("first connect -> connectedSince set", viewOf(r, "A").connectedSince === now);
ok("first connect -> not in dropped", !r.dropped.includes("A"));

// 2) still connected -> no double count
now += 1000;
r = S.reconcile([entry("A", true)], stats, now);
ok("still connected -> connectCount stays 1", viewOf(r, "A").connectCount === 1);

// 3) drop
now += 1000;
r = S.reconcile([entry("A", false, "idle")], stats, now);
ok("drop -> connected false", viewOf(r, "A").connected === false);
ok("drop -> connectedSince 0", viewOf(r, "A").connectedSince === 0);
ok("drop -> appears in dropped", r.dropped.includes("A"));

// 4) pickReconnect returns A (never attempted), then debounced after firing
let target = S.pickReconnect(r.dropped, stats, now, 45000);
ok("pickReconnect returns dropped A", target === "A");
// simulate firing
stats.get("A").reconnectCount++;
stats.get("A").lastReconnectAt = now;
ok("within debounce -> no target", S.pickReconnect(["A"], stats, now + 1000, 45000) === null);
ok("after debounce -> target again", S.pickReconnect(["A"], stats, now + 46000, 45000) === "A");

// 5) reconnect lands -> connectCount increments to 2, reconnectCount stays 1
now += 2000;
r = S.reconcile([entry("A", true)], stats, now);
ok("reconnect landing -> connectCount 2", viewOf(r, "A").connectCount === 2);
ok("reconnectCount preserved (=1)", viewOf(r, "A").reconnectCount === 1);

// 6) a fresh agent that was NEVER connected then shows down is not reconnect-eligible
now += 1000;
r = S.reconcile([entry("A", true), entry("Z", false, "idle")], stats, now);
ok("never-connected Z not in dropped", !r.dropped.includes("Z"));
ok("Z connectCount 0", viewOf(r, "Z").connectCount === 0);

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
