/**
 * Tile state types and state machine logic for multi-agent management.
 *
 * The state machine tracks each agent tile through its lifecycle:
 *   idle → generating → planning → mcp_connected → (back to idle on drop)
 *
 * This replaces the complex agentStats reconciliation with a simpler,
 * event-driven model based on real-time CDP data.
 */

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

function isLiveState(state: TileState): boolean {
  return state !== "idle";
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
 *  tile and never be reconnected. Confirmed by any of three signals:
 *    • mcpErrored    — a Cancelled/failed check_messages card (rendered drop).
 *    • queueCount>0  — messages stranded while the loop is no longer live (they
 *                      can't drain until something re-primes the loop).
 *    • !heartbeatAlive — the agent's heartbeat went stale. DOM-independent, so it
 *                      catches a drop even when the cancelled card has been
 *                      virtualized out of a long transcript. */
function isServerDropped(a: AgentState): boolean {
  return (
    a.connectCount > 0 &&
    !isLiveState(a.state) &&
    !a.worked &&
    (a.mcpErrored || a.queueCount > 0 || !a.heartbeatAlive)
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
): TileState {
  // A live MCP card right now is the strongest signal.
  if (rawState === "mcp_connected") return "mcp_connected";
  // Visibly busy RIGHT NOW (generating text, planning, or running a tool) — the
  // agent is alive and mid-task. This wins over a stale cancelled card so an agent
  // that recovered and is working again is never misread as dropped.
  if (rawState === "generating" || rawState === "planning") return rawState;
  // Not live now AND the last check_messages card is cancelled/failed = a real
  // drop. Overrides the MCP grace window AND the heartbeat's 3-min BUSY_WINDOW
  // inertia, both of which would otherwise keep a just-dropped tile reading live
  // (and so mask the drop) for minutes after it happened.
  if (mcpErrored) return "idle";
  // Inside the grace window after a recent ping, hold the connection so the
  // planning/generating/idle blip between calls doesn't read as a disconnect.
  if (loopAlive) return "mcp_connected";
  // Recently busy — ride out the brief gap between a tool finishing and the next
  // generation so a working tile doesn't flicker to idle and trip a false drop.
  if (busyAlive) return "generating";
  // Loop has gone quiet past the window — report the real transient state, but
  // let a fresh heartbeat upgrade an otherwise-idle tile.
  if (heartbeatState && rawState === "idle") return heartbeatState;
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
  /** Epoch ms this agent was last seen in a tile. Drives the forget window so
   *  vanished tiles don't linger in the map forever. */
  lastSeen: number;
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
      const state = resolveState(
        tile.state,
        heartbeatStates.get(id),
        loopAlive,
        tile.mcpErrored,
        busyAlive,
      );
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
          // A "Worked for…" completion stamp proves the tile already ran a full
          // MCP turn, so even if we never caught it live (it finished before our
          // first poll, or was adopted via Refresh after the turn ended) it has
          // connected at least once. Seed connectCount so the present stamp can
          // classify it as a re-primeable "Dropped" tile instead of falling
          // through to a plain, unreconnectable "Down".
          connectCount: isConnectedState(state) || tile.worked ? 1 : 0,
          reconnectCount: 0,
          reconnectStreak: 0,
          lastReconnectAt: 0,
          worked: tile.worked,
          mcpErrored: tile.mcpErrored,
          heartbeatAlive: heartbeatStates.has(id),
          lastSeen: now,
          lastConnectedMs: 0,
        };
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
        existing.worked = tile.worked;
        existing.mcpErrored = tile.mcpErrored;
        existing.heartbeatAlive = heartbeatStates.has(id);
        existing.lastMcpAt = lastMcpAt;
        existing.lastBusyAt = lastBusyAt;
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
        if (existing.connectCount === 0 && tile.worked) {
          existing.connectCount = 1;
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
        agent.worked = false;
        agent.mcpErrored = false;
        agent.heartbeatAlive = false;
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
  getDroppedAgents(): AgentState[] {
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
      (a.worked || isServerDropped(a))
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
    return this.getAgents()
      .filter((a) => a.tileIndex >= 0) // Only show visible agents
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
        dropped: a.connectCount > 0 && !isLiveState(a.state) && a.worked,
        // An abrupt server drop (no clean stamp) — surfaced separately so the UI
        // can flag it distinctly from a polite cut-off. Synthetic slot ids can't
        // be re-primed, so never mark them.
        serverDropped: !a.agentId.startsWith("tile:") && isServerDropped(a),
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
}
