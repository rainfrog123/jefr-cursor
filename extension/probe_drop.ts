/**
 * Throwaway harness for the drop-detection grace windows.
 *
 * Drives TileStateManager through the scenarios that used to produce a false
 * "Server dropped" on a healthy agent, plus the real-drop cases that must still
 * be caught. Run with: npx esbuild probe_drop.ts --bundle --platform=node
 * --format=cjs --outfile=probe_drop.cjs && node probe_drop.cjs
 */

import { TileStateManager } from "./src/tile-state";
import type { TileInfo, TileState } from "./src/cdp-monitor";

type HB = "waiting" | "working";

function tile(state: TileState, over: Partial<TileInfo> = {}): TileInfo {
  return {
    index: 0,
    agentId: "agent-1",
    model: "opus",
    state,
    mcpVisible: state === "mcp_connected",
    mcpErrored: false,
    generating: state === "generating",
    planning: state === "planning",
    worked: false,
    draftPending: false,
    standbyCutoff: false,
    billingBlocked: false,
    liveTools: [],
    liveToolRunning: false,
    statusText: "",
    ...over,
  };
}

let failures = 0;

function scenario(
  name: string,
  steps: Array<{
    advanceMs?: number;
    tile: TileInfo;
    heartbeat?: HB;
    queue?: number;
  }>,
  expect: { dropped: boolean; serverDropped: boolean; live: boolean },
): void {
  const mgr = new TileStateManager();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    for (const s of steps) {
      clock += s.advanceMs ?? 500;
      const hb = new Map<string, HB>();
      if (s.heartbeat) hb.set("agent-1", s.heartbeat);
      const q = new Map<string, number>([["agent-1", s.queue ?? 0]]);
      mgr.update([s.tile], q, 5 * 60_000, hb);
    }
    const view = mgr.toAgentViews()[0];
    const live = view.state !== "idle";
    const ok =
      view.dropped === expect.dropped &&
      view.serverDropped === expect.serverDropped &&
      live === expect.live;
    if (!ok) failures++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}\n` +
        `      state=${view.state} dropped=${view.dropped} ` +
        `serverDropped=${view.serverDropped}` +
        (ok
          ? ""
          : `\n      expected state.live=${expect.live} dropped=${expect.dropped} ` +
            `serverDropped=${expect.serverDropped}`),
    );
  } finally {
    Date.now = realNow;
  }
}

// Get the agent into a genuinely connected state first: a live MCP card with a
// fresh heartbeat, held long enough to register a real connect.
const connect = [
  { tile: tile("mcp_connected"), heartbeat: "waiting" as HB },
  { tile: tile("mcp_connected"), heartbeat: "waiting" as HB },
  { tile: tile("mcp_connected"), heartbeat: "waiting" as HB },
];

// ── The reported bug ────────────────────────────────────────────────────────
// Agent received a message and is working. It calls no send_progress, so its
// heartbeat went stale seconds ago, and CDP loses the busy state for a stretch.
scenario(
  "working agent, stale heartbeat, CDP misses busy for 10s",
  [
    ...connect,
    { tile: tile("generating"), heartbeat: "waiting" },
    ...Array.from({ length: 20 }, () => ({
      advanceMs: 500,
      tile: tile("idle"),
    })),
  ],
  { dropped: false, serverDropped: false, live: true },
);

// Same, but the user queued a message while the agent works — queueCount > 0
// used to be read as "messages stranded by a dead loop".
scenario(
  "working agent with a queued message and no heartbeat",
  [
    ...connect,
    { tile: tile("generating"), heartbeat: "waiting" },
    ...Array.from({ length: 20 }, () => ({
      advanceMs: 500,
      tile: tile("idle"),
      queue: 2,
    })),
  ],
  { dropped: false, serverDropped: false, live: true },
);

// A tile whose agent never passes agent_id, so a per-agent heartbeat file never
// exists. "Never existed" must not read as "went stale".
scenario(
  "agent that never wrote a heartbeat, briefly idle while working",
  [
    { tile: tile("mcp_connected") },
    { tile: tile("mcp_connected") },
    { tile: tile("generating") },
    ...Array.from({ length: 16 }, () => ({
      advanceMs: 500,
      tile: tile("idle"),
    })),
  ],
  { dropped: false, serverDropped: false, live: true },
);

// ── Real drops must still be caught ─────────────────────────────────────────
// Cursor rendered a cancelled check_messages card: hard evidence, no grace.
scenario(
  "abrupt drop with a cancelled check_messages card",
  [
    ...connect,
    ...Array.from({ length: 20 }, () => ({
      advanceMs: 500,
      tile: tile("idle", { mcpErrored: true }),
    })),
  ],
  { dropped: false, serverDropped: true, live: false },
);

// Clean turn end: "Worked for…" stamp present. Reported once the pre-existing
// 8s MCP grace lapses and the 6s UI confirm has run.
scenario(
  "clean cut-off with a Worked for stamp",
  [
    ...connect,
    ...Array.from({ length: 40 }, () => ({
      advanceMs: 500,
      tile: tile("idle", { worked: true }),
    })),
  ],
  { dropped: true, serverDropped: false, live: false },
);

// A "standing by" reply still in the tile's trailing text must not convict a
// working agent whose busy state CDP happens to miss. The tile does fall to
// idle here — standbyCutoff deliberately vetoes the grace windows, which is what
// stops a genuine standby from reading as "Working" for the whole grace — but it
// must read as plain Down, never as a drop.
scenario(
  "working agent whose tail still reads 'standing by'",
  [
    ...connect,
    { tile: tile("generating"), heartbeat: "waiting" },
    ...Array.from({ length: 16 }, () => ({
      advanceMs: 500,
      tile: tile("idle", { standbyCutoff: true }),
    })),
  ],
  { dropped: false, serverDropped: false, live: false },
);

// Silent death: no card, no stamp, no heartbeat, nothing. Must still be caught
// once every liveness signal has been quiet long enough.
scenario(
  "silent death — no evidence at all, 40s",
  [
    ...connect,
    ...Array.from({ length: 80 }, () => ({
      advanceMs: 500,
      tile: tile("idle"),
    })),
  ],
  { dropped: false, serverDropped: true, live: false },
);

// And it must NOT be reported before the grace has actually elapsed.
scenario(
  "silent death — not yet reported at 5s",
  [
    ...connect,
    ...Array.from({ length: 10 }, () => ({
      advanceMs: 500,
      tile: tile("idle"),
    })),
  ],
  { dropped: false, serverDropped: false, live: true },
);

console.log(failures === 0 ? "\nAll scenarios passed." : `\n${failures} FAILED.`);
process.exit(failures === 0 ? 0 : 1);
