// validate_agentstats.mjs — tests the REAL agentStats.ts reconcile/pickReconnect
// (compiled standalone). Covers connect/reconnect counting, drop detection,
// debounce, tombstone pruning (forget window), and the auto-reconnect attempt cap.
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const S = await import(pathToFileURL(path.join(__dirname, "dist", "agentStats.test.mjs")).href);

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  — " + e : ""}`); };

const stats = new Map();
let now = 1000;

const OPTS = { forgetMs: 300_000, maxReconnects: 3 };
// A roster entry; `ts` defaults to "now" so connected agents look fresh.
const entry = (id, connected, state = "waiting", q = 0, ts = now) => ({
  id, connected, state, queueCount: q, ts,
});
const viewOf = (res, id) => res.views.find((v) => v.id === id);

// 1) first connect
let r = S.reconcile([entry("A", true)], stats, now, OPTS);
ok("first connect -> connectCount 1", viewOf(r, "A").connectCount === 1);
ok("first connect -> connectedSince set", viewOf(r, "A").connectedSince === now);
ok("first connect -> not in dropped", !r.dropped.includes("A"));
ok("first connect -> not pruned", !r.prune.includes("A"));

// 2) still connected -> no double count
now += 1000;
r = S.reconcile([entry("A", true)], stats, now, OPTS);
ok("still connected -> connectCount stays 1", viewOf(r, "A").connectCount === 1);

// 3) drop (recent ts -> still within forget window, shown as down)
now += 1000;
r = S.reconcile([entry("A", false, "idle", 0, now)], stats, now, OPTS);
ok("drop -> connected false", viewOf(r, "A").connected === false);
ok("drop -> connectedSince 0", viewOf(r, "A").connectedSince === 0);
ok("recent drop -> still shown", !!viewOf(r, "A"));
ok("recent drop -> appears in dropped", r.dropped.includes("A"));

// 4) pickReconnect returns A (never attempted), then debounced after firing
let target = S.pickReconnect(r.dropped, stats, now, 45000);
ok("pickReconnect returns dropped A", target === "A");
stats.get("A").reconnectCount++;
stats.get("A").reconnectsSinceConnect++;
stats.get("A").lastReconnectAt = now;
ok("within debounce -> no target", S.pickReconnect(["A"], stats, now + 1000, 45000) === null);
ok("after debounce -> target again", S.pickReconnect(["A"], stats, now + 46000, 45000) === "A");

// 5) reconnect lands -> connectCount 2, reconnectCount preserved, cap reset
now += 2000;
r = S.reconcile([entry("A", true)], stats, now, OPTS);
ok("reconnect landing -> connectCount 2", viewOf(r, "A").connectCount === 2);
ok("reconnectCount preserved (=1)", viewOf(r, "A").reconnectCount === 1);
ok("landing resets attempt cap", stats.get("A").reconnectsSinceConnect === 0);

// 6) a never-connected down agent (no heartbeat) is a tombstone -> pruned, not shown
now += 1000;
r = S.reconcile([entry("A", true), entry("Z", false, "idle", 0, 0)], stats, now, OPTS);
ok("never-connected Z pruned", r.prune.includes("Z"));
ok("never-connected Z not shown", !viewOf(r, "Z"));
ok("never-connected Z not in dropped", !r.dropped.includes("Z"));

// 7) a previously-connected agent gone longer than forgetMs is pruned
now += 1000;
r = S.reconcile([entry("A", true), entry("B", true)], stats, now, OPTS); // B connects
now += OPTS.forgetMs + 5000;
r = S.reconcile(
  [entry("A", true), entry("B", false, "idle", 0, now - OPTS.forgetMs - 1000)],
  stats, now, OPTS,
);
ok("stale B pruned", r.prune.includes("B"));
ok("stale B not shown", !viewOf(r, "B"));
ok("stale B not in dropped", !r.dropped.includes("B"));
ok("fresh A survives the sweep", !!viewOf(r, "A"));

// 8) reconnect cap: after maxReconnects attempts since last connect, C falls out
//    of eligibility (but stays visible while inside the forget window).
now += 1000;
r = S.reconcile([entry("C", true)], stats, now, OPTS); // C connects, cap reset
for (let i = 0; i < OPTS.maxReconnects; i++) {
  now += 1000;
  r = S.reconcile([entry("A", true), entry("C", false, "idle", 0, now)], stats, now, OPTS);
  ok(`C eligible on attempt ${i + 1}`, r.dropped.includes("C"));
  const s = stats.get("C");
  s.reconnectCount++;
  s.reconnectsSinceConnect++;
  s.lastReconnectAt = now;
}
now += 1000;
r = S.reconcile([entry("A", true), entry("C", false, "idle", 0, now)], stats, now, OPTS);
ok("C exhausted cap -> not in dropped", !r.dropped.includes("C"));
ok("C still shown within forget window", !!viewOf(r, "C"));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
