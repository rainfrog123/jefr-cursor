/**
 * Agents tab — the hub of the panel. Shows a "General · shared" card plus one
 * card per agent tile. Clicking a card makes it the ACTIVE agent: the one the
 * Obsidian plugin (and the webview) routes to. Stats live on each card; the
 * Add / fill-pool / auto-reconnect controls sit at the top.
 */
import React, { useEffect, useState } from "react";
import { post } from "../vscode";
import type { LiveAgentInfo } from "../types";
import { DEFAULT_WORKFLOW_MODEL } from "../workflowModels";
import { agentStatus, stateClass, stateLabel } from "../agentStatus";
import { fmtConnect, fmtDuration } from "../format";

export function AgentsTab(props: {
  agents: LiveAgentInfo[];
  selectedAgentId: string | null;
  autoReconnect: boolean;
  targetAgentCount: number;
  cdpConnected?: boolean;
  workflowRunning?: boolean;
  connectingAgentId?: string | null;
  connectingSince?: number;
  sharedQueueCount?: number;
  onSelectAgent: (id: string | null) => void;
  onOpenDetail: (id: string | null) => void;
}): JSX.Element {
  const {
    agents,
    selectedAgentId,
    autoReconnect,
    targetAgentCount,
    cdpConnected,
    workflowRunning,
    connectingAgentId,
    connectingSince,
    sharedQueueCount,
    onSelectAgent,
    onOpenDetail,
  } = props;

  // Activate an agent: select it (routes MCP/Obsidian here) ONLY. We never refocus
  // the tile in the Cursor agent window on a card click — stealing focus there is
  // unwanted and can interrupt a running spawn.
  const activate = (id: string | null) => {
    if (id !== selectedAgentId) onSelectAgent(id);
  };

  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // A tile that's still being primed (the active connecting target) flaps
  // idle ↔ generating while it spins up; exclude it so the count doesn't bounce
  // until it has actually made it into the MCP loop.
  const connectedCount = agents.filter(
    (a) => a.connected && a.id !== connectingAgentId,
  ).length;
  const slotsLeft = Math.max(0, targetAgentCount - agents.length);
  // Manual "Add agent" is uncapped — you can grow the pool to as many agents as
  // you like. "Fill" only tops up to the auto-baseline (targetAgentCount).
  const canAddOne = !workflowRunning;
  const canFill = agents.length < targetAgentCount && !workflowRunning;
  const sorted = [...agents].sort(
    (a, b) => (a.tileIndex ?? 0) - (b.tileIndex ?? 0),
  );
  // Always render every agent, at least the baseline count of slots, and one
  // trailing empty slot so you can keep adding past the baseline.
  const slotCount = Math.max(targetAgentCount, agents.length + 1);

  const addAgent = () => {
    post({ type: "addAgent", model: DEFAULT_WORKFLOW_MODEL });
  };

  const fillPool = () => {
    post({ type: "addAgents", model: DEFAULT_WORKFLOW_MODEL });
  };

  // Force the host to re-scan CDP and re-push the full roster, so every tile
  // actually open in Cursor (including dropped ones) shows up immediately.
  const refresh = () => {
    post({ type: "refreshAgents" });
  };

  return (
    <div className="agents-tab">
      <div className="agents-hero">
        <div className="agents-hero-text">
          <h2 className="agents-hero-title">Agent pool</h2>
        </div>
        <div className="agents-hero-stats">
          <div className="agents-stat">
            <span className="agents-stat-num">{connectedCount}</span>
            <span className="agents-stat-label">connected</span>
          </div>
          <div className="agents-stat">
            <span className="agents-stat-num">{agents.length}</span>
            <span className="agents-stat-label">online</span>
          </div>
          <div
            className={`agents-stat cdp ${cdpConnected ? "on" : "off"}`}
            title={
              cdpConnected
                ? "CDP monitoring active (port 9222)"
                : "CDP offline — using file heartbeats"
            }
          >
            <span className="agents-stat-num">{cdpConnected ? "CDP" : "—"}</span>
            <span className="agents-stat-label">monitor</span>
          </div>
        </div>
      </div>

      <div className="agents-toolbar">
        <button
          className="btn btn-primary btn-small"
          disabled={!canAddOne}
          onClick={addAgent}
          title={`Spawn a new agent tile (${DEFAULT_WORKFLOW_MODEL}). No cap — add as many as you want.`}
        >
          + Add agent
        </button>
        <button
          className="btn btn-primary btn-small"
          disabled={!canFill}
          onClick={fillPool}
          title={`Fill the pool to ${targetAgentCount} agents in one click (${DEFAULT_WORKFLOW_MODEL}). Spawns are queued and run one at a time.`}
        >
          {slotsLeft > 0 ? `+ Add ${slotsLeft}` : `Fill ${targetAgentCount}`}
        </button>
        <button
          className="btn btn-secondary btn-small"
          onClick={refresh}
          title="Re-scan Cursor and refresh the roster (pulls in every open tile, including dropped ones)"
        >
          ↻ Refresh
        </button>
        {slotsLeft > 0 && agents.length > 0 && (
          <span className="agents-slots-hint">
            {slotsLeft} slot{slotsLeft !== 1 ? "s" : ""} free
          </span>
        )}
        <label
          className="agents-auto"
          title={`Keep ${targetAgentCount} agents MCP-connected: close any cut-off tile and spawn a replacement, and top up the pool.`}
        >
          <input
            type="checkbox"
            checked={autoReconnect}
            onChange={(e) =>
              post({ type: "setAutoReconnect", enabled: e.target.checked })
            }
          />
          Keep {targetAgentCount} connected
        </label>
      </div>

      <div className="agents-slots">
        {/* General / shared — always the first card. */}
        <div
          className={
            "agent-slot filled general" +
            (selectedAgentId === null ? " main" : "")
          }
          role="button"
          aria-pressed={selectedAgentId === null}
          title="Make the shared queue active (double-click to open the shared chat)"
          onClick={() => activate(null)}
          onDoubleClick={() => onOpenDetail(null)}
        >
          <span className="agent-slot-num">★</span>
          <span className="agent-dot shared" />
          <div className="agent-slot-body">
            <span className="agent-id">General</span>
            <span className="agent-meta">
              Shared
              {selectedAgentId === null ? " · active" : ""}
              {sharedQueueCount ? ` · ${sharedQueueCount} queued` : ""}
            </span>
          </div>
          <div className="agent-slot-actions">
            <button
              className="btn btn-secondary btn-small agent-details-btn"
              onClick={(e) => {
                e.stopPropagation();
                onOpenDetail(null);
              }}
              title="Open the shared chat"
              aria-label="Open shared chat"
            >
              ⤢
            </button>
          </div>
        </div>

        {Array.from({ length: slotCount }, (_, slot) => {
          const a = sorted[slot];
          if (!a) {
            return (
              <div key={`empty-${slot}`} className="agent-slot empty">
                <span className="agent-slot-num">{slot + 1}</span>
                <span className="agent-slot-label">Empty slot</span>
                <button
                  className="btn btn-secondary btn-small"
                  disabled={!canAddOne}
                  onClick={addAgent}
                >
                  Add
                </button>
              </div>
            );
          }

          const isMain = selectedAgentId === a.id;
          // Label uses the live STATE (so a busy tile reads "Working"); the count
          // still uses a.connected (any live state), so it never drops to 0 while
          // an agent is working.
          const status = agentStatus(
            a.state,
            a.id === connectingAgentId,
            a.dropped,
            a.serverDropped,
          );
          const label = stateLabel(status);
          const dotClass = stateClass(status);
          // Live elapsed timer while this tile is being spawned / re-primed.
          const connectingElapsed =
            status === "connecting" && connectingSince && connectingSince > 0
              ? Date.now() - connectingSince
              : 0;
          // Don't surface uptime / time-to-connect while still connecting or after
          // a cut-off — those only make sense once the MCP loop is actually live
          // (a cut-off tile's "uptime" would just keep ticking on a dead loop).
          const connecting = status === "connecting";
          // Uptime only makes sense while the MCP loop is actually live. A tile
          // that's connecting, cut off, or fully down has a dead loop, so its
          // sticky connectedSince would otherwise keep ticking on the client.
          const live = status === "mcp_connected" || status === "working";
          const showUptime = live && a.connectedSince > 0;
          const uptime = showUptime ? Date.now() - a.connectedSince : 0;
          const showConnectMs = !connecting && a.connectMs != null;
          // After a drop, show how long the connection actually held before it
          // died — captured at drop time, so it survives connectedSince clearing.
          const isDropped = status === "cutoff" || status === "server_dropped";
          const showHeld =
            isDropped && a.lastConnectedMs != null && a.lastConnectedMs > 0;

          return (
            <div
              key={a.id}
              className={"agent-slot filled" + (isMain ? " main" : "")}
              role="button"
              aria-pressed={isMain}
              title={
                isMain
                  ? "Active agent — Obsidian routes here (click to refocus its tile, double-click to open)"
                  : "Click to make active (double-click to open details & chat)"
              }
              onClick={() => activate(a.id)}
              onDoubleClick={() => onOpenDetail(a.id)}
            >
              <span className="agent-slot-num">{slot + 1}</span>
              <span className={`agent-dot ${dotClass}`} title={label} />
              <div className="agent-slot-body">
                <span className="agent-id" title={a.id}>
                  {a.id.slice(0, 8)}
                  {isMain && <span className="agent-active-tag">active</span>}
                </span>
                <span className="agent-meta">
                  {label}
                  {a.queueCount ? ` · ${a.queueCount} queued` : ""}
                </span>
                {connectingElapsed > 0 && (
                  <span className="agent-timing">
                    connecting {fmtDuration(connectingElapsed)}
                  </span>
                )}
                {(showUptime || showConnectMs) && (
                  <span className="agent-timing">
                    {showUptime && `up ${fmtDuration(uptime)}`}
                    {showUptime && showConnectMs && " · "}
                    {showConnectMs && `spawned in ${fmtConnect(a.connectMs)}`}
                  </span>
                )}
                {showHeld && (
                  <span className="agent-timing" title="How long this agent stayed connected before it dropped">
                    connected for {fmtDuration(a.lastConnectedMs!)}
                  </span>
                )}
                {a.model && (
                  <span className="agent-model" title={a.model}>
                    {a.model}
                  </span>
                )}
              </div>
              <div className="agent-slot-actions">
                <button
                  className="btn btn-secondary btn-small agent-details-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenDetail(a.id);
                  }}
                  title="Open details and chat directly with this agent"
                  aria-label="Open details"
                >
                  ⤢
                </button>
                <button
                  className="btn btn-secondary btn-small"
                  onClick={(e) => {
                    e.stopPropagation();
                    post({ type: "reconnectAgent", agentId: a.id });
                  }}
                  disabled={workflowRunning}
                  title="Re-prime this tile's MCP loop"
                >
                  ↻
                </button>
                <button
                  className="btn btn-danger btn-small"
                  onClick={(e) => {
                    e.stopPropagation();
                    post({ type: "deleteAgent", agentId: a.id });
                  }}
                  title="Remove from roster and close tile"
                >
                  ×
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {agents.length === 0 && (
        <p className="agents-empty-hint">
          No agents yet. Click <strong>Add agent</strong> to spawn one via CDP
          (requires <code>--remote-debugging-port=9222</code>).
        </p>
      )}
    </div>
  );
}
