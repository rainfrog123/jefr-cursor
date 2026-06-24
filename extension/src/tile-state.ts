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

function stateWithHeartbeat(tileState: TileState, heartbeatState?: HeartbeatState): TileState {
  return heartbeatState && tileState === "idle" ? heartbeatState : tileState;
}

function isMcpLoopState(state: TileState): boolean {
  return state === "mcp_connected" || state === "waiting" || state === "working";
}

function isLiveState(state: TileState): boolean {
  return state !== "idle";
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
  /** Total times this agent has connected to MCP. */
  connectCount: number;
  /** Times we've attempted to reconnect this agent. */
  reconnectCount: number;
  /** Consecutive reconnect attempts since last successful connect. */
  reconnectStreak: number;
  /** Epoch ms of last reconnect attempt. */
  lastReconnectAt: number;
  /** True when the tile shows a "Worked for ..." completion stamp — i.e. the turn
   *  ended and the MCP connection cut out. The reliable "dropped" signal. */
  worked: boolean;
  /** Epoch ms this agent was last seen in a tile. Drives the forget window so
   *  vanished tiles don't linger in the map forever. */
  lastSeen: number;
}

export interface AgentTransition {
  type: "connected" | "disconnected" | "state_changed" | "new_agent";
  agentId: string;
  from?: TileState;
  to?: TileState;
}

// ── State Manager ────────────────────────────────────────────────────────────

export class TileStateManager {
  private agents = new Map<string, AgentState>();
  private listeners: Array<(transitions: AgentTransition[]) => void> = [];

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
      if (!tile.agentId) continue;
      seen.add(tile.agentId);
      const state = stateWithHeartbeat(tile.state, heartbeatStates.get(tile.agentId));

      const existing = this.agents.get(tile.agentId);
      if (!existing) {
        // New agent discovered
        const newState: AgentState = {
          agentId: tile.agentId,
          tileIndex: tile.index,
          state,
          model: tile.model,
          queueCount: queueCounts.get(tile.agentId) || 0,
          firstSeen: now,
          connectedSince: isMcpLoopState(state) ? now : 0,
          connectCount: isMcpLoopState(state) ? 1 : 0,
          reconnectCount: 0,
          reconnectStreak: 0,
          lastReconnectAt: 0,
          worked: tile.worked,
          lastSeen: now,
        };
        this.agents.set(tile.agentId, newState);
        transitions.push({ type: "new_agent", agentId: tile.agentId, to: state });
        if (isMcpLoopState(state)) {
          transitions.push({ type: "connected", agentId: tile.agentId, to: state });
        }
      } else {
        // Update existing agent
        const prevState = existing.state;
        const wasConnected = isMcpLoopState(prevState);
        existing.tileIndex = tile.index;
        existing.model = tile.model;
        existing.queueCount = queueCounts.get(tile.agentId) || 0;
        existing.worked = tile.worked;
        existing.lastSeen = now;

        if (prevState !== state) {
          const isConnected = isMcpLoopState(state);
          existing.state = state;
          transitions.push({
            type: "state_changed",
            agentId: tile.agentId,
            from: prevState,
            to: state,
          });

          // Track MCP connection
          if (isConnected && !wasConnected) {
            existing.connectedSince = now;
            existing.connectCount++;
            existing.reconnectStreak = 0;
            transitions.push({ type: "connected", agentId: tile.agentId, to: state });
          } else if (wasConnected && !isConnected) {
            existing.connectedSince = 0;
            transitions.push({ type: "disconnected", agentId: tile.agentId, from: prevState, to: state });
          }
        }
      }
    }

    // Agents no longer visible: clear stale live state, emit a drop if they were
    // connected, and forget them once they've been gone past the window.
    for (const [agentId, agent] of this.agents) {
      if (seen.has(agentId)) continue;

      if (agent.tileIndex >= 0) {
        // First poll where the tile is gone: reset its transient state so it
        // can't be reported as still generating/planning/connected.
        const prevState = agent.state;
        agent.tileIndex = -1;
        agent.connectedSince = 0;
        agent.worked = false;
        if (prevState !== "idle") {
          agent.state = "idle";
          if (prevState === "mcp_connected") {
            transitions.push({ type: "disconnected", agentId, from: prevState, to: "idle" });
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

  /** Get agents that need reconnection: a confirmed cut-out — visible, connected
   *  before, now idle, and showing the "Worked for ..." completion stamp. The
   *  stamp distinguishes a real drop from a tile that's merely idle (freshly
   *  spawned, or the user is mid-type), avoiding needless re-primes. */
  getDroppedAgents(): AgentState[] {
    return this.getAgents().filter((a) =>
      // Must be visible (tileIndex >= 0)
      a.tileIndex >= 0 &&
      // Must have connected before (so it's a DROP, not a new tile)
      a.connectCount > 0 &&
      // Not currently live (MCP loop, working heartbeat, generating, or planning)
      !isLiveState(a.state) &&
      // The turn actually ended (completion stamp present) — a real cut-out.
      a.worked
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
        connected: isLiveState(a.state),
        // Preserve CDP state for UI — the type now supports all states
        state: a.state as AgentView["state"],
        queueCount: a.queueCount,
        connectCount: a.connectCount,
        reconnectCount: a.reconnectCount,
        connectedSince: a.connectedSince,
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
  queueCount: number;
  connectCount: number;
  reconnectCount: number;
  connectedSince: number;
  model: string;
  tileIndex: number;
}
