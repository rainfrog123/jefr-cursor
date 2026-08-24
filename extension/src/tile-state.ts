/**
 * Tile state types and state machine logic for multi-agent management.
 *
 * The state machine tracks each agent tile through its lifecycle:
 *   idle → generating → planning → mcp_connected → (back to idle on drop)
 *
 * This replaces the complex agentStats reconciliation with a simpler,
 * event-driven model based on real-time CDP data.
 */

import {
  activityFromDb,
  getTranscriptActivity,
  getTranscriptTurnEnd,
  mergeLiveActivity,
} from "./agentTranscript";
import type { TranscriptActivity } from "./agentTranscript";
import { composerAliveAt, getComposerActivity } from "./composerState";
import type { TileInfo, TileState } from "./cdp-monitor";

// ── Types ────────────────────────────────────────────────────────────────────

type HeartbeatState = "waiting" | "working";

const MISSING_TILE_GRACE_MS = 10_000;

/** How long after the last live MCP card we keep treating a tile as connected.
 *  The check_messages loop is bursty: the live tool card sits in the DOM only
 *  while a call is actually running, then vanishes for a beat while the agent
 *  plans / generates / re-arms the next call. Without a grace window, every poll
 *  in that gap reads as a disconnect, so the tile flaps mcp_connected ↔
 *  planning/idle several times a second — bouncing the connected count and
 *  spamming connect/disconnect transitions. Holding the connection across gaps
 *  shorter than this makes a healthy loop read as a steady "MCP connected"; a
 *  loop that has actually stopped still drops once the gap exceeds the window. */
const MCP_GRACE_MS = 8_000;

/** How long to hold a tile as "working" after the last visibly-busy poll, so the
 *  sub-second gap between one tool finishing and the next generation starting
 *  doesn't flicker a busy agent to idle — which could otherwise trip a spurious
 *  drop while the agent is mid-task. */
const BUSY_GRACE_MS = 8_000;

/** How long an agent keeps benefit of the doubt after the last INDEPENDENT proof
 *  that it's doing something (live MCP card, busy tile, running tool card, or a
 *  transcript that's still growing).
 *
 *  This exists because the drop signals below are mostly inferences, and the
 *  thing they infer from is unreliable while an agent is working normally: the
 *  MCP heartbeat is only refreshed while parked in check_messages (or for a
 *  while after send_progress), so an agent that receives a message and then
 *  works quietly has NO heartbeat at all. Add one poll where a CDP selector
 *  misses the busy state and the tile reads as an abrupt server drop — the
 *  "working agent shown as dropped" bug. Requiring a sustained absence of every
 *  liveness signal makes that impossible without meaningfully delaying a real
 *  drop, which stays dead for far longer than this. */
const LIVENESS_GRACE_MS = 20_000;

/** How long a tile must read continuously non-live before the UI is allowed to
 *  label it dropped. `getDroppedAgents` has always had a confirm window for the
 *  self-heal, but the badge in the panel had none — so a single unlucky poll
 *  could flash "Dropped" on a healthy agent and then take it back. */
const UI_DROP_CONFIRM_MS = 6_000;

function isLiveState(state: TileState): boolean {
  return state !== "idle";
}

/** True when we've seen independent proof of life within the grace window.
 *  Deliberately NOT derived from the MCP heartbeat: the server keeps a "working"
 *  beat warm for minutes after a send_progress, so folding it in here would
 *  resurrect the bug where a standby tile reads as Working long after its loop
 *  ended. */
function isRecentlyAlive(a: AgentState, now = Date.now()): boolean {
  return a.lastAliveAt > 0 && now - a.lastAliveAt < LIVENESS_GRACE_MS;
}

/** Debounce for the UI's drop badges: the tile must have read non-live
 *  continuously for UI_DROP_CONFIRM_MS. A genuinely dropped tile clears this
 *  trivially — `droppedSince` is backdated when the drop was already complete on
 *  discovery — while a healthy agent that blips for a poll or two never does. */
function dropConfirmed(a: AgentState, now: number): boolean {
  return a.droppedSince > 0 && now - a.droppedSince >= UI_DROP_CONFIRM_MS;
}

/** "Online" in the strict sense: actively parked in the MCP loop (held-open
 *  check_messages, or its waiting heartbeat) — NOT merely busy (generating /
 *  planning) or idle. Drives the connected count so a working agent doesn't
 *  inflate "connected" and a flicker doesn't bounce it. */
function isConnectedState(state: TileState): boolean {
  return state === "mcp_connected" || state === "waiting";
}

/** A previously-connected tile whose MCP loop died ABRUPTLY — a "server drop"
 *  rather than a polite turn-end. There's no "Worked for…" stamp (that's the
 *  clean-cutoff case), so without this it would fall through to a plain "down"
 *  tile and never be reconnected.
 *
 *  The signals fall into two tiers, and conflating them is what produced false
 *  drops on healthy agents:
 *
 *  RENDERED — Cursor actually drew the death in the tile, and the CDP query
 *  refuses to report it while the tile is generating / planning / running a
 *  tool. Trustworthy on sight:
 *    • mcpErrored    — a Cancelled/failed check_messages card, read from the
 *                      card's own status attribute rather than its text.
 *
 *  INFERRED — absence of evidence, which is exactly what a busy agent also looks
 *  like. Each of these is true for long stretches of perfectly normal work, so
 *  they only count once every independent liveness signal has been quiet for
 *  LIVENESS_GRACE_MS:
 *    • !heartbeatAlive — the beat went stale. Only meaningful if we ever saw one:
 *                      an agent that doesn't pass agent_id never writes a
 *                      per-agent heartbeat, and "never existed" is not a death.
 *    • queueCount>0  — messages stranded with no live loop to drain them. Also
 *                      just what it looks like when the user sends something
 *                      mid-turn.
 *    • transcriptErrorEnd — a final `turn_ended` with status:error. Cursor only
 *                      flushes the jsonl at turn boundaries, so early in a NEW
 *                      turn this can still be the PREVIOUS turn's record.
 *    • standbyCutoff — a regex for "standing by" over the tile's trailing text.
 *                      A pattern match on a reply is not Cursor reporting a
 *                      death: an agent that said it minutes ago and is working
 *                      again still matches until the text scrolls out of range. */
function isServerDropped(a: AgentState, now = Date.now()): boolean {
  if (a.connectCount === 0 || isLiveState(a.state) || a.worked) return false;
  if (a.mcpErrored) return true;
  if (isRecentlyAlive(a, now)) return false;
  return (
    (a.heartbeatEverSeen && !a.heartbeatAlive) ||
    a.queueCount > 0 ||
    a.transcriptErrorEnd ||
    a.standbyCutoff
  );
}

/** True when a real (non-synthetic) visible tile is NOT live right now — i.e. it
 *  is not parked in the MCP loop and not busy (generating / planning / working).
 *  "Keep N connected" means keep N agents actually live, so the self-heal targets
 *  ANY non-live tile — a clean cut-off ("Worked for…"), an abrupt server drop, OR
 *  a plain idle/"down" tile (e.g. one re-discovered idle after a reload, or whose
 *  loop ended with no stamp). Drives each agent's `notLiveSince` stamp so the
 *  CONFIRM window can require a sustained non-live state before acting. */
function isUnhealthy(a: AgentState): boolean {
  return (
    !a.agentId.startsWith("tile:") &&
    a.tileIndex >= 0 &&
    !isLiveState(a.state)
  );
}

/** Collapse the raw CDP tile state into the displayed state, applying the MCP
 *  grace window so brief gaps between check_messages calls don't flap the tile.
 *  `loopAlive` = this tile pinged the MCP loop within MCP_GRACE_MS. */
function resolveState(
  rawState: TileState,
  heartbeatState: HeartbeatState | undefined,
  loopAlive: boolean,
  mcpErrored: boolean,
  busyAlive: boolean,
  ended: boolean,
  aliveRecently: boolean,
): TileState {
  // A live MCP card right now is the strongest signal.
  if (rawState === "mcp_connected") return "mcp_connected";
  // Visibly busy RIGHT NOW (generating text, planning, or running a tool) — the
  // agent is alive and mid-task. This wins over a stale cancelled card so an agent
  // that recovered and is working again is never misread as dropped.
  if (rawState === "generating" || rawState === "planning") return rawState;
  // A fresh "waiting" heartbeat is CONCLUSIVE proof of life: the MCP server is
  // blocked in check_messages for this agent right now (it beats every 2.5s and
  // goes stale within 6s, so "fresh" can only mean "blocked moments ago"). Every
  // "ended" signal below — a stale Cancelled card still newest while the new call
  // re-arms, an old "Worked for…" stamp or standby text in the tail, a leftover
  // transcript turn_ended — is necessarily history. Without this veto a parked,
  // healthy agent whose tail ends with its own standby reply reads idle here and
  // gets badged "Server dropped" (via standbyCutoff / queueCount) while it is
  // literally listening. (A "working" heartbeat is only 3-min inertia and does
  // NOT earn this veto — a real drop can happen inside that window.)
  if (heartbeatState === "waiting") return "mcp_connected";
  // Not live now AND the last check_messages card is cancelled/failed = a real
  // drop. Overrides the MCP grace window AND the heartbeat's 3-min BUSY_WINDOW
  // inertia, both of which would otherwise keep a just-dropped tile reading live
  // (and so mask the drop) for minutes after it happened.
  //
  // It must NOT override a recent busy observation, though. A Cancelled card
  // from an earlier drop-and-recover stays in the scrollback, and the CDP query
  // only suppresses it while the tile is visibly busy *this poll* — so during
  // the sub-second gap between two tool calls this line used to fire on a
  // perfectly healthy agent. The UI badge survived that (it waits for
  // UI_DROP_CONFIRM_MS), but the resolved state still flipped to idle for a
  // poll, which registered a disconnect: uptime reset to zero and the connect
  // count ticked up. Deferring to the 8s busy window costs that much extra
  // latency on a genuine drop — a dropped tile stops being busy, so the window
  // lapses on its own — and keeps a working agent's stats intact.
  if (mcpErrored && !busyAlive) return "idle";
  // Inside the grace window after a recent ping, hold the connection so the
  // planning/generating/idle blip between calls doesn't read as a disconnect.
  if (loopAlive) return "mcp_connected";
  // The turn ENDED / loop cut out — proven by a "Worked for…" completion stamp OR
  // by the injected prompt being restored, un-sent, into the composer. Either vetoes
  // the two "still alive" inertia signals below (the busy-grace window and a
  // lingering "working" heartbeat), so a cut-off tile stops reading as "Working"
  // (which masked the drop). During real work neither is set, so the grace/heartbeat
  // still smooth over the gaps between tool calls.
  if (busyAlive && !ended) return "generating";
  // Nothing in the DOM says busy, but something independent proved the agent was
  // alive moments ago — a running tool card, or a transcript still being
  // appended to. A CDP selector miss (virtualized tile, DOM churn, a tool card
  // shape we don't recognise) is far more likely than an agent that produced
  // fresh evidence of work and then instantly died, so keep it reading as busy.
  // `ended` still vetoes: a turn with a real completion stamp is over.
  if (aliveRecently && !ended) return "generating";
  // (No "waiting" upgrade here — a fresh waiting heartbeat already returned
  // conclusively above. A lingering "working" heartbeat from the post-call
  // inertia ticker must NOT keep a standby/dead tile reading as Working.)
  return rawState;
}

export interface AgentState {
  /** Stable Cursor agent ID (from React fiber). */
  agentId: string;
  /** Current tile index (-1 if not visible). */
  tileIndex: number;
  /** Current state from CDP. */
  state: TileState;
  /** Model name from the picker. */
  model: string;
  /** Number of items in this agent's message queue. */
  queueCount: number;
  /** Epoch ms when this agent first connected. */
  firstSeen: number;
  /** Epoch ms when the current MCP connection started. */
  connectedSince: number;
  /** Epoch ms we last saw THIS tile actively in the MCP loop (a live
   *  check_messages card). Drives the grace window that keeps a bursty-but-healthy
   *  loop reading as connected across the gaps between calls. */
  lastMcpAt: number;
  /** Epoch ms we last saw THIS tile visibly busy (generating / planning / running
   *  a tool). Drives the busy-grace window that keeps a working tile from
   *  flickering to idle between tool calls. */
  lastBusyAt: number;
  /** Epoch ms of the last INDEPENDENT proof this agent was doing something: a
   *  live MCP card, a busy tile, a running tool card, or a transcript that grew
   *  without ending. Excludes the MCP heartbeat on purpose (see isRecentlyAlive).
   *  Gates every inferred drop signal, so a quiet-but-working agent can't be
   *  called dropped by absence of evidence alone. */
  lastAliveAt: number;
  /** Total times this agent has connected to MCP. */
  connectCount: number;
  /** Times we've attempted to reconnect this agent. */
  reconnectCount: number;
  /** Consecutive reconnect attempts since last successful connect. */
  reconnectStreak: number;
  /** Epoch ms of last reconnect attempt. */
  lastReconnectAt: number;
  /** True when the tile shows a "Worked for ..." completion stamp — i.e. the turn
   *  ended and the MCP connection cut out. The reliable clean-cutoff signal. */
  worked: boolean;
  /** True when the tile is idle with the injected prompt restored, un-sent, in its
   *  composer — Cursor puts the draft back when a held-open turn dies. Catches a
   *  cut-off with no "Worked for…" stamp. Only treated as a drop for an agent that
   *  already connected (connectCount > 0), so a fresh spawn isn't misflagged. */
  draftPending: boolean;
  /** True when the transcript tail shows the agent ended with a standby reply
   *  (no blocked check_messages) — the loop is cut even without a "Worked for…"
   *  stamp or a restored composer draft. */
  standbyCutoff: boolean;
  /** Newest tool-card labels rendered in the tile — the only live, mid-turn view
   *  of what this agent is doing (the transcript isn't flushed until turn end). */
  liveTools: string[];
  /** True while the newest tool card is still running. */
  liveToolRunning: boolean;
  /** True when a jefr check_messages card is in a cancelled/failed state — the
   *  server-drop fingerprint: the held-open call died WITHOUT a clean turn-end,
   *  so there's no "Worked for…" stamp. Used to catch a drop that would otherwise
   *  read as a plain "down" tile. (Only visible while the card is rendered — long
   *  transcripts virtualize it away, which is why `heartbeatAlive` backs it up.) */
  mcpErrored: boolean;
  /** True when the agent's MCP heartbeat file is fresh (within the stale window).
   *  DOM-independent, so it catches a drop even when Cursor has virtualized the
   *  cancelled card out of the transcript: a previously-connected tile that is no
   *  longer live AND whose heartbeat has gone stale = its loop died. */
  heartbeatAlive: boolean;
  /** True once this agent has written a per-agent heartbeat at least once. An
   *  agent that never passes `agent_id` writes only the shared root beat, so its
   *  per-agent file never appears — without this, "no heartbeat" would read as a
   *  permanent drop for every such tile. */
  heartbeatEverSeen: boolean;
  /** True when the Cursor agent transcript's *last* record is turn_ended with a
   *  non-success status (error / abort / auth / policy). Hard dead signal. */
  transcriptErrorEnd: boolean;
  /** True when the transcript's last record is turn_ended with status success —
   *  clean turn finish (same role as a "Worked for…" stamp). */
  transcriptCleanEnd: boolean;
  /** Epoch ms this agent was last seen in a tile. Drives the forget window so
   *  vanished tiles don't linger in the map forever. */
  lastSeen: number;
  /** Epoch ms this tile first entered a confirmed-dropped condition (cut-off
   *  "Worked for…" stamp or a server drop) and has stayed there since. 0 when the
   *  tile is live / not dropped. Drives the self-heal CONFIRM window: a tile must
   *  stay dropped for `confirmMs` before it's closed + replaced, so a momentary
   *  blip never triggers a needless respawn. Reset to 0 the moment the tile is
   *  live again (or vanishes). */
  droppedSince: number;
  /** How long the most recent live connection lasted before it dropped (ms).
   *  Captured at drop time — BEFORE `connectedSince` is cleared — so a
   *  dropped / server-dropped tile (whose `connectedSince` is now 0) can still
   *  report "connected for X" in the UI. 0 until the first real drop. */
  lastConnectedMs: number;
}

export interface AgentTransition {
  type: "connected" | "disconnected" | "state_changed" | "new_agent";
  agentId: string;
  from?: TileState;
  to?: TileState;
  /** For "disconnected": how long the tile had been connected (ms), captured
   *  before `connectedSince` is cleared, so the log can report the held time. */
  connectedMs?: number;
}

// ── State Manager ────────────────────────────────────────────────────────────

export class TileStateManager {
  private agents = new Map<string, AgentState>();
  private listeners: Array<(transitions: AgentTransition[]) => void> = [];

  /** Resolve a stable tracking id for a tile. Prefers the real React-fiber
   *  agentId. When that isn't available (a freshly-opened tile, or a flaky poll
   *  where the fiber walk missed), reuse the agent already tracked in this tile
   *  slot so a momentary miss never drops a live tile; otherwise synthesize a
   *  slot id so the new tile still appears on the Agents page. */
  private resolveTileId(tile: TileInfo, seen: Set<string>): string {
    if (tile.agentId) return tile.agentId;
    for (const a of this.agents.values()) {
      if (a.tileIndex === tile.index && !seen.has(a.agentId)) {
        return a.agentId;
      }
    }
    return `tile:${tile.index}`;
  }

  /** Update state from CDP tile info. Returns transitions that occurred.
   *  `forgetMs` drops vanished agents from the map after that long unseen.
   *  Fresh MCP heartbeats override an otherwise-idle CDP tile, because the DOM
   *  can look idle while the agent is actively doing tool work. */
  update(
    tiles: TileInfo[],
    queueCounts: Map<string, number>,
    forgetMs = 5 * 60_000,
    heartbeatStates: Map<string, HeartbeatState> = new Map(),
  ): AgentTransition[] {
    const now = Date.now();
    const transitions: AgentTransition[] = [];
    const seen = new Set<string>();

    // Process visible tiles
    for (const tile of tiles) {
      // Every visible tile gets tracked so the Agents page mirrors Cursor 1:1 —
      // even a brand-new tile whose React-fiber agentId hasn't resolved yet.
      const id = this.resolveTileId(tile, seen);
      seen.add(id);

      const existing = this.agents.get(id);
      // Track when this tile last showed a live MCP card, and whether that was
      // recent enough to ride out the gap between check_messages calls.
      const rawMcp = tile.state === "mcp_connected";
      const lastMcpAt = rawMcp ? now : existing?.lastMcpAt ?? 0;
      const loopAlive =
        !!existing &&
        existing.connectCount > 0 &&
        lastMcpAt > 0 &&
        now - lastMcpAt < MCP_GRACE_MS;
      // Track when this tile was last visibly busy, and whether that's recent
      // enough to ride out the brief gap between tool calls.
      const rawBusy = tile.state === "generating" || tile.state === "planning";
      const lastBusyAt = rawBusy ? now : existing?.lastBusyAt ?? 0;
      const busyAlive = lastBusyAt > 0 && now - lastBusyAt < BUSY_GRACE_MS;
      const heartbeatAlive = heartbeatStates.has(id);
      const heartbeatEverSeen = heartbeatAlive || !!existing?.heartbeatEverSeen;
      // Transcript turn_ended is only a *confirming* death signal. Fresh MCP
      // heartbeat or a visibly busy tile (generating / planning / live MCP card)
      // means the agent is still working — don't flip to dropped mid-turn.
      // (False positive we hit: leftover turn_ended + busy agent ⇒ "Dropped".)
      const turnEnd = id.startsWith("tile:")
        ? { ended: false as const, mtimeMs: undefined }
        : getTranscriptTurnEnd(id);
      // A transcript that grew without ending the turn means Cursor is still
      // checkpointing this agent's work — proof of life that survives any
      // DOM/selector problem. Stamped with the file's own mtime rather than the
      // time we noticed it, so the grace window measures from when the agent
      // actually did something.
      const transcriptAliveAt =
        !turnEnd.ended && turnEnd.mtimeMs !== undefined ? turnEnd.mtimeMs : 0;
      const domAliveNow = rawMcp || rawBusy || !!tile.liveToolRunning;
      // Cursor's own record of the conversation. Unlike everything above it
      // keeps updating while the agent works quietly and with no Agents window
      // open, so it covers the exact gap that produced false drops. Returns 0
      // when the store isn't readable — never treated as evidence of death.
      const composerAliveAtMs = composerAliveAt(id);
      const lastAliveAt = Math.max(
        domAliveNow ? now : 0,
        transcriptAliveAt,
        composerAliveAtMs,
        existing?.lastAliveAt ?? 0,
      );
      const aliveRecently =
        lastAliveAt > 0 && now - lastAliveAt < LIVENESS_GRACE_MS;
      // Two extra guards beyond the original busy/heartbeat checks:
      //   • `busyAlive` instead of `rawBusy` — a turn_ended left over from the
      //     previous turn must not win during the sub-second gap between two
      //     tool calls, which is exactly when rawBusy is false.
      //   • the record must not predate our last proof of life. If the agent was
      //     demonstrably working AFTER the file was last written, then what's in
      //     the file describes an older turn, not this one.
      const transcriptConfirmed =
        turnEnd.ended &&
        !heartbeatAlive &&
        !busyAlive &&
        !rawMcp &&
        !aliveRecently &&
        (turnEnd.mtimeMs ?? 0) >= lastAliveAt;
      const transcriptCleanEnd =
        transcriptConfirmed && turnEnd.status === "success";
      const transcriptErrorEnd =
        transcriptConfirmed && turnEnd.status !== "success";
      const turnOver =
        tile.worked ||
        tile.draftPending ||
        tile.standbyCutoff ||
        transcriptConfirmed;
      const state = resolveState(
        tile.state,
        heartbeatStates.get(id),
        loopAlive,
        tile.mcpErrored || transcriptErrorEnd,
        busyAlive,
        turnOver,
        aliveRecently,
      );
      // Clean transcript end counts as a "Worked for…" equivalent. The error end
      // still forces the state to idle, but it is NOT folded into the stored
      // `mcpErrored`: that field means "Cursor rendered a cancelled card", which
      // isServerDropped trusts on sight, and an inferred transcript verdict has
      // not earned that. It stays available as its own, grace-gated signal.
      const worked = tile.worked || transcriptCleanEnd;
      const mcpErrored = tile.mcpErrored;
      if (!existing) {
        // New agent discovered
        const newState: AgentState = {
          agentId: id,
          tileIndex: tile.index,
          state,
          model: tile.model,
          queueCount: queueCounts.get(id) || 0,
          firstSeen: now,
          connectedSince: isConnectedState(state) ? now : 0,
          lastMcpAt,
          lastBusyAt,
          lastAliveAt,
          // A "Worked for…" completion stamp proves the tile already ran a full
          // MCP turn, so even if we never caught it live (it finished before our
          // first poll, or was adopted via Refresh after the turn ended) it has
          // connected at least once. Seed connectCount so the present stamp can
          // classify it as a re-primeable "Dropped" tile instead of falling
          // through to a plain, unreconnectable "Down".
          connectCount:
            isConnectedState(state) || worked || transcriptConfirmed ? 1 : 0,
          reconnectCount: 0,
          reconnectStreak: 0,
          lastReconnectAt: 0,
          worked,
          draftPending: tile.draftPending,
          standbyCutoff: tile.standbyCutoff,
          liveTools: tile.liveTools ?? [],
          liveToolRunning: tile.liveToolRunning ?? false,
          mcpErrored,
          heartbeatAlive,
          heartbeatEverSeen,
          transcriptErrorEnd,
          transcriptCleanEnd,
          lastSeen: now,
          lastConnectedMs: 0,
          droppedSince: 0,
        };
        if (isUnhealthy(newState)) {
          // A pre-existing ENDED loop (worked stamp / server drop) is a confirmed
          // drop — backdate so the self-heal acts immediately, not 10s from
          // discovery. A plain idle/empty tile (incl. a brand-new one, or one
          // mid-spawn) gets the normal 10s confirm so it isn't recycled instantly.
          newState.droppedSince =
            newState.worked || isServerDropped(newState) ? 1 : now;
        }
        this.agents.set(id, newState);
        transitions.push({ type: "new_agent", agentId: id, to: state });
        if (isConnectedState(state)) {
          transitions.push({ type: "connected", agentId: id, to: state });
        }
      } else {
        // Update existing agent
        const prevState = existing.state;
        existing.tileIndex = tile.index;
        existing.model = tile.model;
        existing.queueCount = queueCounts.get(id) || 0;
        existing.worked = worked;
        existing.draftPending = tile.draftPending;
        existing.standbyCutoff = tile.standbyCutoff;
        existing.liveTools = tile.liveTools ?? [];
        existing.liveToolRunning = tile.liveToolRunning ?? false;
        existing.mcpErrored = mcpErrored;
        existing.heartbeatAlive = heartbeatAlive;
        existing.heartbeatEverSeen = heartbeatEverSeen;
        existing.transcriptErrorEnd = transcriptErrorEnd;
        existing.transcriptCleanEnd = transcriptCleanEnd;
        existing.lastMcpAt = lastMcpAt;
        existing.lastBusyAt = lastBusyAt;
        existing.lastAliveAt = lastAliveAt;
        existing.lastSeen = now;

        if (prevState !== state) {
          existing.state = state;
          transitions.push({
            type: "state_changed",
            agentId: id,
            from: prevState,
            to: state,
          });

          // A real (re)connect: entering the parked MCP loop either for the FIRST
          // time, or back from a fully-down (idle) state. The parked↔busy
          // (generating / planning) churn within one live turn — re-arming the
          // next check_messages call — is NOT a new connect, so it no longer
          // inflates the connect count or spams the transition log.
          // connectedSince is sticky: stamped on the first connect and kept while
          // the tile stays alive, so uptime counts from the real connect.
          const enteredLoop =
            isConnectedState(state) &&
            !isConnectedState(prevState) &&
            (existing.connectCount === 0 || !isLiveState(prevState));
          // A real disconnect: the turn went fully idle after being alive.
          const wentDown = !isLiveState(state) && isLiveState(prevState);
          if (enteredLoop) {
            if (!existing.connectedSince) existing.connectedSince = now;
            existing.connectCount++;
            existing.reconnectStreak = 0;
            transitions.push({ type: "connected", agentId: id, to: state });
          } else if (wentDown && existing.connectCount > 0) {
            const heldMs = existing.connectedSince
              ? now - existing.connectedSince
              : 0;
            // Remember how long it stayed up so the dropped tile can show it
            // even after connectedSince is cleared below.
            if (heldMs > 0) existing.lastConnectedMs = heldMs;
            transitions.push({
              type: "disconnected",
              agentId: id,
              from: prevState,
              to: state,
              connectedMs: heldMs > 0 ? heldMs : undefined,
            });
            // The loop is no longer live, so clear the uptime stamp: a still-
            // visible tile that went idle shouldn't keep accruing "uptime". A
            // later real (re)connect re-stamps it via the enteredLoop branch.
            existing.connectedSince = 0;
          }
        }

        // Backfill connectCount for a tile we only ever saw post-completion. A
        // "Worked for…" stamp means it ran a full MCP turn, so it has connected
        // at least once — even though the monitor never caught a live card for
        // it. Without this, both the "Dropped" and "Server dropped"
        // classifications (gated on connectCount > 0) stay suppressed and the
        // cleanly cut-off tile is mis-shown as plain "Down" and skipped by
        // auto-reconnect.
        if (existing.connectCount === 0 && (worked || transcriptConfirmed)) {
          existing.connectCount = 1;
        }

        // Maintain the non-live confirm stamp: start the clock the first poll this
        // tile reads as non-live, and keep it ticking until the tile is live again
        // (or vanishes, handled below). A live/healthy tile always clears it.
        if (isUnhealthy(existing)) {
          if (!existing.droppedSince) existing.droppedSince = now;
        } else {
          existing.droppedSince = 0;
        }
      }
    }

    // Agents no longer visible: clear stale live state, emit a drop if they were
    // connected, and forget them once they've been gone past the window.
    for (const [agentId, agent] of this.agents) {
      if (seen.has(agentId)) continue;

      // Synthetic slot ids (tiles without a resolved agentId) aren't durable —
      // drop them the instant their tile is gone instead of lingering.
      if (agentId.startsWith("tile:")) {
        this.agents.delete(agentId);
        continue;
      }

      if (now - agent.lastSeen <= MISSING_TILE_GRACE_MS) {
        continue;
      }

      if (agent.tileIndex >= 0) {
        // First poll where the tile is gone: reset its transient state so it
        // can't be reported as still generating/planning/connected.
        const prevState = agent.state;
        // Capture how long it had been connected BEFORE we clear the stamp, so a
        // drop-by-vanish can still report the held time.
        const prevConnectedSince = agent.connectedSince;
        agent.tileIndex = -1;
        agent.connectedSince = 0;
        agent.lastMcpAt = 0;
        agent.lastBusyAt = 0;
        agent.lastAliveAt = 0;
        agent.worked = false;
        agent.draftPending = false;
        agent.standbyCutoff = false;
        agent.mcpErrored = false;
        agent.heartbeatAlive = false;
        // A tile that's no longer visible isn't a reconnectable in-place drop —
        // clear the confirm clock so a later reappearance restarts it cleanly.
        agent.droppedSince = 0;
        if (prevState !== "idle") {
          agent.state = "idle";
          const heldMs = prevConnectedSince ? now - prevConnectedSince : 0;
          if (heldMs > 0) agent.lastConnectedMs = heldMs;
          if (prevState === "mcp_connected") {
            transitions.push({
              type: "disconnected",
              agentId,
              from: prevState,
              to: "idle",
              connectedMs: heldMs > 0 ? heldMs : undefined,
            });
          }
        }
      }

      // Tombstone cleanup: a tile that closed (or a past session) shouldn't
      // linger in the map and drive reconnects forever.
      if (now - agent.lastSeen > forgetMs) {
        this.agents.delete(agentId);
      }
    }

    // Notify listeners
    if (transitions.length > 0) {
      for (const listener of this.listeners) {
        listener(transitions);
      }
    }

    return transitions;
  }

  /** Get all tracked agents. */
  getAgents(): AgentState[] {
    return [...this.agents.values()];
  }

  /** Get a specific agent by ID. */
  getAgent(agentId: string): AgentState | undefined {
    return this.agents.get(agentId);
  }

  /** Get agents that need reconnection. Two reconnectable end-states, both
   *  visible, previously connected, and no longer live:
   *    • clean cut-off — the turn ended with a "Worked for…" completion stamp.
   *    • server drop   — the loop died abruptly (errored check_messages card, or
   *                      messages stranded in the queue) with NO stamp; without
   *                      this arm it would fall through to a plain "down" tile and
   *                      never be re-primed, stranding its queue forever.
   *  The stamp / error / queue gates distinguish a real drop from a tile that's
   *  merely idle (freshly spawned, or the user is mid-type), avoiding needless
   *  re-primes. */
  getDroppedAgents(confirmMs = 0): AgentState[] {
    const now = Date.now();
    return this.getAgents().filter((a) =>
      // Real agentId only — never try to reconnect a synthetic slot id, which
      // the workflow can't target (no fiber agentId to focus).
      !a.agentId.startsWith("tile:") &&
      // Must be visible (tileIndex >= 0)
      a.tileIndex >= 0 &&
      // Must have connected before (so it's a DROP, not a new tile)
      a.connectCount > 0 &&
      // Not currently live (MCP loop, working heartbeat, generating, or planning)
      !isLiveState(a.state) &&
      // A clean cut-out (completion stamp) OR an abrupt server drop.
      (a.worked || a.draftPending || a.transcriptCleanEnd || isServerDropped(a)) &&
      // CONFIRM window: only act on a tile that has stayed dropped for at least
      // `confirmMs` (0 = act immediately, used by the manual "Close dropped").
      (confirmMs <= 0 ||
        (a.droppedSince > 0 && now - a.droppedSince >= confirmMs))
    );
  }

  /** Tiles the "Keep N connected" self-heal should act on: ANY real, visible tile
   *  that is not live and has stayed non-live for `confirmMs`. Broader than
   *  getDroppedAgents (the clean-cutoff / server-drop subset used for UI labels and
   *  the manual "Close dropped") — Keep-N must also recycle a plain "down" tile
   *  (e.g. one re-discovered idle after a reload, or whose loop ended with no
   *  stamp) so the pool keeps N agents actually mcp_connected / working. */
  getAgentsNeedingHeal(confirmMs = 0): AgentState[] {
    const now = Date.now();
    return this.getAgents().filter(
      (a) =>
        !a.agentId.startsWith("tile:") &&
        a.tileIndex >= 0 &&
        !isLiveState(a.state) &&
        (confirmMs <= 0 ||
          (a.droppedSince > 0 && now - a.droppedSince >= confirmMs)),
    );
  }

  /** Mark a reconnect attempt for an agent. */
  markReconnectAttempt(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.reconnectCount++;
      agent.reconnectStreak++;
      agent.lastReconnectAt = Date.now();
    }
  }

  /** Remove an agent from tracking (e.g., tile closed). */
  forgetAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  /** Listen for state transitions. */
  onTransition(listener: (transitions: AgentTransition[]) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx >= 0) this.listeners.splice(idx, 1);
    };
  }

  /** Convert agent state to the view format expected by the webview. */
  toAgentViews(): AgentView[] {
    const now = Date.now();
    // Stable order: first-seen, then id. Do NOT sort by live tileIndex — Cursor
    // pane order and CDP discovery order flap, which made the Agents pool list
    // reshuffle every poll.
    return this.getAgents()
      .filter((a) => a.tileIndex >= 0) // Only show visible agents
      .sort(
        (a, b) =>
          a.firstSeen - b.firstSeen || a.agentId.localeCompare(b.agentId),
      )
      .map((a) => ({
        id: a.agentId,
        // "connected" = a live state AND the tile has actually reached the MCP
        // loop at least once (connectCount > 0). Requiring connectCount closes
        // the pre-first-connect gap: while a fresh tile is still being primed it
        // flaps idle ↔ generating/planning, and the grace window in resolveState
        // can't smooth that yet (it only arms after the first real connect), so
        // a bare isLiveState() check would bounce the connected count 0↔1. Once
        // the tile is through the loop the grace window keeps this steady.
        connected: isLiveState(a.state) && a.connectCount > 0,
        // Preserve CDP state for UI — the type now supports all states
        state: a.state as AgentView["state"],
        // A clean cut-out: previously connected, now idle, "Worked for..."
        // stamp present. Lets the UI show a distinct reconnectable state.
        dropped:
          dropConfirmed(a, now) &&
          a.connectCount > 0 &&
          !isLiveState(a.state) &&
          (a.worked || a.draftPending || a.transcriptCleanEnd),
        // An abrupt server drop (no clean stamp) — surfaced separately so the UI
        // can flag it distinctly from a polite cut-off. Synthetic slot ids can't
        // be re-primed, so never mark them.
        serverDropped:
          dropConfirmed(a, now) &&
          !a.agentId.startsWith("tile:") &&
          isServerDropped(a, now),
        queueCount: a.queueCount,
        connectCount: a.connectCount,
        reconnectCount: a.reconnectCount,
        connectedSince: a.connectedSince,
        // How long the last connection held before dropping — surfaced so a
        // dropped tile can show "connected for X" even though connectedSince
        // has been cleared back to 0.
        lastConnectedMs: a.lastConnectedMs,
        model: a.model,
        tileIndex: a.tileIndex,
        // Three tiers, best first:
        //   1. live tile cards  — instant, but only while the Agents window is up
        //   2. Cursor's bubbles — always available, about 30s behind
        //   3. the transcript   — only ever describes finished turns
        // The transcript is last because it isn't flushed mid-turn, so for a
        // long-running agent it would otherwise describe the *previous* turn.
        activity: mergeLiveActivity(
          a.agentId,
          a.liveTools,
          a.liveToolRunning,
          activityFromDb(
            getComposerActivity(a.agentId),
            getTranscriptActivity(a.agentId),
          ),
        ),
      }));
  }
}

// ── View types (for webview) ─────────────────────────────────────────────────

export interface AgentView {
  id: string;
  connected: boolean;
  /** CDP state: mcp_connected, generating, planning, idle (or legacy: waiting, working) */
  state: "waiting" | "working" | "idle" | "mcp_connected" | "generating" | "planning";
  /** True when the MCP loop cut out cleanly (turn ended, "Worked for..." present)
   *  and the tile can be reconnected. */
  dropped: boolean;
  /** True when the MCP loop died abruptly (server drop) — no "Worked for…" stamp;
   *  an errored check_messages card or messages stranded in the queue. Re-primed
   *  in place so the queue drains. */
  serverDropped: boolean;
  queueCount: number;
  connectCount: number;
  reconnectCount: number;
  connectedSince: number;
  /** How long the most recent connection lasted before it dropped (ms). 0 until
   *  the tile has dropped at least once. Lets the UI show "connected for X" on a
   *  dropped / server-dropped tile whose connectedSince is already cleared. */
  lastConnectedMs: number;
  model: string;
  tileIndex: number;
  /** Live "what is this agent doing?" from the Cursor transcript tail. */
  activity?: TranscriptActivity;
}
