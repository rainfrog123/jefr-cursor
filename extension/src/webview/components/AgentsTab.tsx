/**
 * Agents tab: the agents manager — lists every addressable agent with its live
 * connection status, uptime, connect/reconnect counts, a "Talk" (set as main
 * agent) action, a per-agent Reconnect, and the global Auto-reconnect toggle.
 */
import React, { useEffect, useState } from "react";
import { post } from "../vscode";
import type { LiveAgentInfo } from "../types";

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

export function AgentsTab(props: {
  agents: LiveAgentInfo[];
  selectedAgentId: string | null;
  autoReconnect: boolean;
  onSelectAgent: (id: string | null) => void;
}): JSX.Element {
  const { agents, selectedAgentId, autoReconnect, onSelectAgent } = props;

  // Tick once a second so live uptime counters advance.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const connectedCount = agents.filter((a) => a.connected).length;

  return (
    <div className="agents-tab">
      <div className="agents-card">
        <div className="agents-head">
          <span className="agents-title">Agents</span>
          <span className="agents-sub">
            {connectedCount}/{agents.length} connected
          </span>
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

        {agents.length === 0 ? (
          <p className="agents-empty">
            No addressable agents yet. Open the <strong>General</strong> tab and
            use <strong>Run workflow</strong> to spawn one — it self-identifies by
            its agentId and will appear here.
          </p>
        ) : (
          <div className="agents-list">
            {agents.map((a) => {
              const isMain = selectedAgentId === a.id;
              const uptime = a.connected ? Date.now() - a.connectedSince : 0;
              return (
                <div key={a.id} className={"agent-row" + (isMain ? " main" : "")}>
                  <span
                    className={"agent-dot " + (a.connected ? "on " + a.state : "off")}
                    title={a.connected ? a.state : "disconnected"}
                  />
                  <span className="agent-id" title={a.id}>
                    {a.id.slice(0, 8)}
                  </span>
                  <span className="agent-meta">
                    {a.connected ? a.state : "down"}
                    {a.connected ? ` · up ${fmtDuration(uptime)}` : ""}
                    {a.queueCount ? ` · ${a.queueCount} queued` : ""}
                  </span>
                  <span className="agent-counts" title="connects · reconnects">
                    c{a.connectCount}/r{a.reconnectCount}
                  </span>
                  <span className="agent-row-actions">
                    <button
                      className={"btn btn-small " + (isMain ? "btn-secondary" : "btn-primary")}
                      onClick={() => onSelectAgent(isMain ? null : a.id)}
                      title={isMain ? "Currently the main agent" : "Talk to this agent"}
                    >
                      {isMain ? "Main" : "Talk"}
                    </button>
                    <button
                      className="btn btn-secondary btn-small"
                      onClick={() => post({ type: "reconnectAgent", agentId: a.id })}
                      title="Re-prime this agent's tile now"
                    >
                      Reconnect
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
