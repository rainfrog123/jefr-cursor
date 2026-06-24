/**
 * Agents tab — manage up to 5 Cursor agent tiles: add, delete, talk (focus),
 * reconnect, and optional auto-reconnect. Uses CDP real-time state.
 */
import React, { useEffect, useState } from "react";
import { post } from "../vscode";
import type { LiveAgentInfo } from "../types";
import { DEFAULT_WORKFLOW_MODEL } from "../workflowModels";

function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function stateLabel(state: string, connected: boolean): string {
  switch (state) {
    case "mcp_connected":
      return "MCP connected";
    case "working":
      return "Working";
    case "generating":
      return "Generating";
    case "planning":
      return "Planning";
    case "waiting":
      return "Waiting";
    case "idle":
      return connected ? "Idle" : "Down";
    default:
      return connected ? "Idle" : "Down";
  }
}

function stateClass(state: string, connected: boolean): string {
  switch (state) {
    case "mcp_connected":
      return "on mcp";
    case "working":
      return "on working";
    case "generating":
      return "on generating";
    case "planning":
      return "on planning";
    case "waiting":
      return "on waiting";
    case "idle":
      return connected ? "on" : "off";
    default:
      return connected ? "on" : "off";
  }
}

export function AgentsTab(props: {
  agents: LiveAgentInfo[];
  selectedAgentId: string | null;
  autoReconnect: boolean;
  targetAgentCount: number;
  cdpConnected?: boolean;
  workflowRunning?: boolean;
  onSelectAgent: (id: string | null) => void;
}): JSX.Element {
  const {
    agents,
    selectedAgentId,
    autoReconnect,
    targetAgentCount,
    cdpConnected,
    workflowRunning,
    onSelectAgent,
  } = props;

  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const connectedCount = agents.filter((a) => a.connected).length;
  const slotsLeft = Math.max(0, targetAgentCount - agents.length);
  const canAdd = agents.length < targetAgentCount && !workflowRunning;
  const sorted = [...agents].sort(
    (a, b) => (a.tileIndex ?? 0) - (b.tileIndex ?? 0),
  );

  const addAgent = () => {
    post({ type: "addAgent", model: DEFAULT_WORKFLOW_MODEL });
  };

  return (
    <div className="agents-tab">
      <div className="agents-hero">
        <div className="agents-hero-text">
          <h2 className="agents-hero-title">Agent pool</h2>
          <p className="agents-hero-desc">
            Up to {targetAgentCount} tiles on{" "}
            <strong>{DEFAULT_WORKFLOW_MODEL}</strong>. Talk focuses the tile in
            Cursor so MCP routes to the right agent.
          </p>
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
          disabled={!canAdd}
          onClick={addAgent}
          title={`Spawn a new agent tile (${DEFAULT_WORKFLOW_MODEL})`}
        >
          + Add agent
        </button>
        {slotsLeft > 0 && agents.length > 0 && (
          <span className="agents-slots-hint">
            {slotsLeft} slot{slotsLeft !== 1 ? "s" : ""} free
          </span>
        )}
        <label className="agents-auto" title="Auto-reconnect dropped agents">
          <input
            type="checkbox"
            checked={autoReconnect}
            onChange={(e) =>
              post({ type: "setAutoReconnect", enabled: e.target.checked })
            }
          />
          Auto-reconnect
        </label>
      </div>

      <div className="agents-slots">
        {Array.from({ length: targetAgentCount }, (_, slot) => {
          const a = sorted[slot];
          if (!a) {
            return (
              <div key={`empty-${slot}`} className="agent-slot empty">
                <span className="agent-slot-num">{slot + 1}</span>
                <span className="agent-slot-label">Empty slot</span>
                <button
                  className="btn btn-secondary btn-small"
                  disabled={!canAdd}
                  onClick={addAgent}
                >
                  Add
                </button>
              </div>
            );
          }

          const isMain = selectedAgentId === a.id;
          const showUptime = a.connected && a.connectedSince > 0;
          const uptime = showUptime ? Date.now() - a.connectedSince : 0;
          const label = stateLabel(a.state, a.connected);
          const dotClass = stateClass(a.state, a.connected);

          return (
            <div
              key={a.id}
              className={"agent-slot filled" + (isMain ? " main" : "")}
            >
              <span className="agent-slot-num">{slot + 1}</span>
              <span className={`agent-dot ${dotClass}`} title={label} />
              <div className="agent-slot-body">
                <span className="agent-id" title={a.id}>
                  {a.id.slice(0, 8)}
                </span>
                <span className="agent-meta">
                  {label}
                  {showUptime && ` · ${fmtDuration(uptime)}`}
                  {a.queueCount ? ` · ${a.queueCount} queued` : ""}
                </span>
                {a.model && (
                  <span className="agent-model" title={a.model}>
                    {a.model}
                  </span>
                )}
              </div>
              <div className="agent-slot-actions">
                <button
                  className={
                    "btn btn-small " +
                    (isMain ? "btn-secondary" : "btn-primary")
                  }
                  onClick={() => {
                    onSelectAgent(isMain ? null : a.id);
                    if (!isMain) post({ type: "focusAgent", agentId: a.id });
                  }}
                  title={
                    isMain
                      ? "Currently selected — click to deselect"
                      : "Talk to this agent (focuses its tile)"
                  }
                >
                  {isMain ? "Active" : "Talk"}
                </button>
                <button
                  className="btn btn-secondary btn-small"
                  onClick={() =>
                    post({ type: "reconnectAgent", agentId: a.id })
                  }
                  disabled={workflowRunning}
                  title="Re-prime this tile's MCP loop"
                >
                  ↻
                </button>
                <button
                  className="btn btn-danger btn-small"
                  onClick={() =>
                    post({ type: "deleteAgent", agentId: a.id })
                  }
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
