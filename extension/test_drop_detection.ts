/**
 * Regression tests for the "working agent shown as dropped" bug.
 *
 * The scenario that produced it: an agent working a long turn is only visibly
 * busy on *most* polls. In the sub-second gap between two tool calls the CDP
 * query reports `idle`, and at that instant every "is it dead?" inference lines
 * up at once — stale transcript turn_ended from the PREVIOUS turn, a stale
 * heartbeat (only written while parked in check_messages), and a leftover
 * Cancelled card in the scrollback.
 *
 * Run: npx esbuild test_drop_detection.ts --bundle --platform=node
 *        --format=cjs --outfile=/tmp/t.cjs && node /tmp/t.cjs
 */
import { TileStateManager } from "./src/tile-state";
import type { TileInfo } from "./src/cdp-monitor";
import { clearTranscriptCache } from "./src/agentTranscript";
import { newStat, reconcile } from "./src/agentStats";
import {
  clearComposerCache,
  composerAliveAt,
  getComposerActivity,
  getComposerLiveness,
  isComposerStateAvailable,
} from "./src/composerState";

const AGENT = "11111111-2222-3333-4444-555555555555";

function tile(over: Partial<TileInfo> = {}): TileInfo {
  return {
    index: 0,
    agentId: AGENT,
    model: "Opus 4.8",
    state: "generating",
    mcpVisible: false,
    mcpErrored: false,
    generating: true,
    planning: false,
    worked: false,
    draftPending: false,
    standbyCutoff: false,
    billingBlocked: false,
    liveTools: [],
    liveToolRunning: false,
    statusText: "",
    ...over,
  } as TileInfo;
}

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}

function viewOf(m: TileStateManager) {
  return m.toAgentViews().find((v) => v.id === AGENT)!;
}

/** Drive the manager through polls; returns the manager. */
function run(seq: TileInfo[], heartbeat = new Map<string, "waiting" | "working">()) {
  const m = new TileStateManager();
  for (const t of seq) m.update([t], new Map(), 5 * 60_000, heartbeat);
  return m;
}

console.log("\n=== 1. Agent connects, then works through a long turn ===");
{
  const hb = new Map<string, "waiting" | "working">([[AGENT, "waiting"]]);
  const m = new TileStateManager();
  // Connect (live MCP card).
  m.update([tile({ state: "mcp_connected", mcpVisible: true })], new Map(), 5 * 60_000, hb);
  const connected = viewOf(m);
  check("reads connected after a live MCP card", connected.connected, `state=${connected.state}`);

  // Now it starts WORKING. The heartbeat goes stale (an agent doing work is not
  // parked inside check_messages), and the tile blips idle between tool calls.
  const noHb = new Map<string, "waiting" | "working">();
  const seq: TileInfo[] = [
    tile({ state: "generating" }),
    tile({ state: "idle", generating: false }), // gap between two tool calls
    tile({ state: "generating" }),
    tile({ state: "idle", generating: false }), // another gap
    tile({ state: "planning", generating: false, planning: true }),
  ];
  let everDropped = false;
  let everDisconnected = false;
  for (const t of seq) {
    m.update([t], new Map(), 5 * 60_000, noHb);
    const v = viewOf(m);
    if (v.dropped || v.serverDropped) everDropped = true;
    if (!v.connected) everDisconnected = true;
  }
  check("never flags dropped while working", !everDropped);
  check("never flips to disconnected mid-turn", !everDisconnected);
  const v = viewOf(m);
  check("connect count stays 1 (no phantom reconnects)", v.connectCount === 1, `got ${v.connectCount}`);
  check("uptime stamp survives the whole turn", v.connectedSince > 0);
}

console.log("\n=== 2. Stale Cancelled card in scrollback while still working ===");
{
  const hb = new Map<string, "waiting" | "working">([[AGENT, "waiting"]]);
  const m = new TileStateManager();
  m.update([tile({ state: "mcp_connected", mcpVisible: true })], new Map(), 5 * 60_000, hb);
  const before = viewOf(m);

  // Agent recovered and is working again, but an old Cancelled check_messages
  // card is still rendered. On the poll that lands in a tool-call gap, the CDP
  // query stops suppressing it and reports mcpErrored.
  const noHb = new Map<string, "waiting" | "working">();
  m.update([tile({ state: "generating" })], new Map(), 5 * 60_000, noHb);
  m.update(
    [tile({ state: "idle", generating: false, mcpErrored: true })],
    new Map(),
    5 * 60_000,
    noHb,
  );
  const v = viewOf(m);
  check("stale Cancelled card does not flip a busy agent to dropped", !v.serverDropped && !v.dropped);
  check("connect count not inflated by the blip", v.connectCount === before.connectCount, `got ${v.connectCount}`);
  check("uptime not reset by the blip", v.connectedSince === before.connectedSince);
}

console.log("\n=== 3. A running tool card is proof of life on its own ===");
{
  const noHb = new Map<string, "waiting" | "working">();
  const hb = new Map<string, "waiting" | "working">([[AGENT, "waiting"]]);
  const m = new TileStateManager();
  m.update([tile({ state: "mcp_connected", mcpVisible: true })], new Map(), 5 * 60_000, hb);
  // CDP misses the busy state (selector drift) but a tool card is still running.
  m.update(
    [tile({ state: "idle", generating: false, liveTools: ["Ran Read foo.ts"], liveToolRunning: true })],
    new Map(),
    5 * 60_000,
    noHb,
  );
  const v = viewOf(m);
  check("running tool card keeps it alive despite idle CDP state", !v.dropped && !v.serverDropped, `state=${v.state}`);
}

console.log("\n=== 4. A REAL drop is still detected ===");
{
  const hb = new Map<string, "waiting" | "working">([[AGENT, "waiting"]]);
  const m = new TileStateManager();
  m.update([tile({ state: "mcp_connected", mcpVisible: true })], new Map(), 5 * 60_000, hb);

  // Age the tile past every grace window. This is what a real drop looks like a
  // few polls later: the MCP grace window (8s after the last live card) and the
  // busy window have both lapsed. Holding "connected" *inside* those windows is
  // deliberate — it's what stops a bursty-but-healthy loop from flapping — so a
  // test that polls instantly is testing the grace window, not the drop.
  const aged = m.getAgents().find((a) => a.agentId === AGENT)!;
  const longAgo = Date.now() - 60_000;
  aged.lastMcpAt = longAgo;
  aged.lastBusyAt = longAgo;
  aged.lastAliveAt = longAgo;

  // Turn ends cleanly: "Worked for…" stamp, idle, no heartbeat.
  const noHb = new Map<string, "waiting" | "working">();
  m.update(
    [tile({ state: "idle", generating: false, worked: true })],
    new Map(),
    5 * 60_000,
    noHb,
  );
  const immediately = viewOf(m);
  check("stops reporting connected once the turn ends", !immediately.connected, `state=${immediately.state}`);

  // The UI badge is additionally debounced by UI_DROP_CONFIRM_MS, so backdate
  // droppedSince to simulate the tile staying dead rather than blipping.
  const agent = m.getAgents().find((a) => a.agentId === AGENT)!;
  agent.droppedSince = Date.now() - 60_000;
  const confirmed = viewOf(m);
  check("a sustained clean cut-off IS flagged dropped", confirmed.dropped, `dropped=${confirmed.dropped}`);
}

console.log("\n=== 5. Never-connected tile is not called a server drop ===");
{
  const noHb = new Map<string, "waiting" | "working">();
  const m = run([tile({ state: "idle", generating: false })], noHb);
  const v = viewOf(m);
  check("fresh idle tile is not serverDropped", !v.serverDropped);
  check("fresh idle tile is not dropped", !v.dropped);
}

console.log("\n=== 6. reconcile(): a quietly-working agent is not auto-reconnected ===");
{
  const now = Date.now();
  const roster = [
    // Heartbeat has gone stale because the agent is working, not parked.
    { id: AGENT, connected: false, state: "idle" as const, queueCount: 0, ts: now - 120_000 },
  ];

  // Without the external signal, this is the old behaviour.
  const statsA = new Map([[AGENT, { ...newStat(), connectCount: 1, lastSeen: now - 120_000 }]]);
  const before = reconcile(roster, statsA, now, {
    forgetMs: 5 * 60_000,
    maxReconnects: 5,
  });
  check(
    "without the signal it IS queued for reconnect (the old bug)",
    before.dropped.includes(AGENT),
  );

  // With Cursor's record showing the conversation advanced 10s ago.
  const statsB = new Map([[AGENT, { ...newStat(), connectCount: 1, lastSeen: now - 120_000 }]]);
  const after = reconcile(roster, statsB, now, {
    forgetMs: 5 * 60_000,
    maxReconnects: 5,
    externalAliveAt: () => now - 10_000,
    externalAliveGraceMs: 5 * 60_000,
  });
  check("with the signal it is NOT queued for reconnect", !after.dropped.includes(AGENT));
  check(
    "and it reports as working rather than idle",
    after.views[0]?.state === "working",
    `state=${after.views[0]?.state}`,
  );

  // A genuinely dead agent must still be reconnectable.
  const statsC = new Map([[AGENT, { ...newStat(), connectCount: 1, lastSeen: now - 120_000 }]]);
  const dead = reconcile(roster, statsC, now, {
    forgetMs: 5 * 60_000,
    maxReconnects: 5,
    externalAliveAt: () => now - 60 * 60_000, // last advanced an hour ago
    externalAliveGraceMs: 5 * 60_000,
  });
  check("a truly stale agent IS still queued for reconnect", dead.dropped.includes(AGENT));
}

console.log("\n=== 7. composerState against the real Cursor store ===");
{
  const avail = isComposerStateAvailable();
  console.log(`  (node:sqlite + state.vscdb reachable: ${avail})`);
  if (!avail) {
    console.log("  SKIP  store not readable from this runtime — feature degrades to old signals");
  } else {
    const live = getComposerLiveness("f3a5b3b5-2db5-42cc-85a8-5c3bdd51a5ff");
    check("reads a record for a real agent", !!live, "no record returned");
    if (live) {
      check("header count is populated", live.headerCount > 0, `got ${live.headerCount}`);
      const age = (Date.now() - live.checkpointMs) / 1000;
      check("checkpoint is recent for a live agent", age < 600, `age=${age.toFixed(0)}s`);
      console.log(`        headers=${live.headerCount}  checkpointAge=${age.toFixed(0)}s`);
    }
    check(
      "unknown agent id returns undefined, not a false verdict",
      getComposerLiveness("00000000-0000-0000-0000-000000000000") === undefined,
    );
    check("composerAliveAt is 0 for an unknown agent", composerAliveAt("nope-not-an-agent") === 0);
  }
}

console.log("\n=== 8. Bubble activity feed from Cursor's store ===");
{
  if (!isComposerStateAvailable()) {
    console.log("  SKIP  store not readable");
  } else {
    const act = getComposerActivity("f3a5b3b5-2db5-42cc-85a8-5c3bdd51a5ff");
    check("returns an activity feed", !!act && act.steps.length > 0, `steps=${act?.steps.length}`);
    if (act) {
      const labelled = act.steps.filter((s) => s.label && s.label.trim().length > 0);
      check("every step has a human label", labelled.length === act.steps.length);
      const tools = act.steps.filter((s) => s.tool);
      check("tool steps carry a tool name", tools.length > 0, `${tools.length} tool steps`);
      console.log("        newest steps:");
      for (const s of act.steps.slice(-5)) {
        console.log(`          [${(s.tool || "text").padEnd(24)}] ${s.status.padEnd(9)} ${s.label.slice(0, 60)}`);
      }
    }
    // Second read must be served from cache and stay identical.
    const a1 = getComposerActivity("f3a5b3b5-2db5-42cc-85a8-5c3bdd51a5ff");
    const a2 = getComposerActivity("f3a5b3b5-2db5-42cc-85a8-5c3bdd51a5ff");
    check(
      "repeat read is stable (firstSeen doesn't drift)",
      JSON.stringify(a1) === JSON.stringify(a2),
    );
    check(
      "unknown agent yields no feed",
      getComposerActivity("00000000-0000-0000-0000-000000000000")?.steps.length !== undefined
        ? getComposerActivity("00000000-0000-0000-0000-000000000000")!.steps.length === 0
        : true,
    );
  }
}

clearTranscriptCache();
clearComposerCache();
console.log(`\n${failures === 0 ? "ALL TESTS PASSED" : failures + " TEST(S) FAILED"}\n`);
process.exit(failures === 0 ? 0 : 1);
