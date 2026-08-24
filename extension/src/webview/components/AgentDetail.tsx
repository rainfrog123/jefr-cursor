/**
 * Agent detail page — opened by the "Details" button on a card. Shows a back
 * bar, the target's live status + stats (time-to-connect, uptime, model, queue,
 * connect/reconnect counts), per-agent actions, and the chat (history + composer)
 * so you can talk directly to that agent. A null target is the shared "General".
 */
import React, { useEffect, useState } from "react";
import { post } from "../vscode";
import type { Attachment, HistoryItem, LiveAgentInfo } from "../types";
import { ChatTab } from "./ChatTab";
import { ActivityFeed } from "./ActivityFeed";
import { agentStatus, stateClass, stateLabel } from "../agentStatus";
import { fmtConnect, fmtDuration } from "../format";

function Stat(props: { label: string; value: string; title?: string }): JSX.Element {
  return (
    <div className="agent-stat" title={props.title}>
      <span className="agent-stat-label">{props.label}</span>
      <span className="agent-stat-value">{props.value}</span>
    </div>
  );
}

export function AgentDetail(props: {
  agent: LiveAgentInfo | null;
  /** Full roster — General / shared merges every agent's activity feed. */
  agents: LiveAgentInfo[];
  connectingAgentId: string | null;
  workflowRunning?: boolean;
  sharedQueueCount?: number;
  closing?: boolean;
  deleteError?: string;
  history: HistoryItem[];
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  appendHistory: (item: Omit<HistoryItem, "index">) => void;
  onClearHistory: () => void;
  onBack: () => void;
  version?: string;
  onOpenConsole?: () => void;
}): JSX.Element {
  const { agent, connectingAgentId, workflowRunning, closing, deleteError } = props;
  const isGeneral = agent === null;

  // Tick so the uptime stat counts live.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const status = agent
    ? agentStatus(
        agent.state,
        agent.id === connectingAgentId,
        agent.dropped,
        agent.serverDropped,
      )
    : "mcp_connected";
  const label = isGeneral ? "Shared" : stateLabel(status);
  const dotClass = isGeneral ? "shared" : stateClass(status);
  const connecting = status === "connecting";
  // Uptime only makes sense while the MCP loop is actually live. A connecting,
  // cut-off, or fully-down tile has a dead loop, so its sticky connectedSince
  // would otherwise tick forever on the client.
  const live = status === "mcp_connected" || status === "working";
  const showUptime = live && !!agent && agent.connectedSince > 0;
  const uptime = showUptime ? Date.now() - agent!.connectedSince : 0;
  // After a drop, show how long the connection held before it died.
  const isDropped = status === "cutoff" || status === "server_dropped";
  const showHeld =
    isDropped && !!agent && agent.lastConnectedMs != null && agent.lastConnectedMs > 0;

  return (
    <div className="agent-detail">
      <div className="agent-detail-bar">
        <button
          className="agent-back-btn"
          onClick={props.onBack}
          title="Back to the agent list"
        >
          ‹
        </button>
        <span className={`agent-dot ${dotClass}`} title={label} />
        <span className="agent-detail-title" title={agent?.id}>
          {isGeneral ? "General" : agent!.id.slice(0, 8)}
        </span>

        <div className="agent-detail-stats">
          {isGeneral ? (
            <Stat
              label="shared queue"
              value={String(props.sharedQueueCount ?? 0)}
              title="Messages waiting on the shared queue"
            />
          ) : (
            <>
              <Stat label="status" value={label} />
              <Stat
                label="spawned in"
                value={
                  !connecting && agent!.connectMs != null
                    ? fmtConnect(agent!.connectMs)
                    : "—"
                }
                title="Total time the spawn/reconnect workflow took end-to-end (find tile + Auto stand-by + model switch + Enter-hold + connect) — not just the MCP handshake"
              />
              <Stat
                label="uptime"
                value={showUptime ? fmtDuration(uptime) : "—"}
                title="Time since this agent first connected"
              />
              {showHeld && (
                <Stat
                  label="connected for"
                  value={fmtDuration(agent!.lastConnectedMs!)}
                  title="How long this agent stayed connected before it dropped"
                />
              )}
              <Stat label="queued" value={String(agent!.queueCount)} />
              <Stat label="connects" value={String(agent!.connectCount)} />
              <Stat label="reconnects" value={String(agent!.reconnectCount)} />
              {agent!.model && (
                <Stat label="model" value={agent!.model} title={agent!.model} />
              )}
            </>
          )}
        </div>

        {!isGeneral && (
          <div className="agent-detail-actions">
            <button
              type="button"
              className={
                "btn btn-secondary btn-small agent-keep-btn" +
                (agent!.keepConnected ? " on" : "")
              }
              aria-pressed={!!agent!.keepConnected}
              aria-label={
                agent!.keepConnected
                  ? "Keep connected on"
                  : "Keep connected off"
              }
              title={
                agent!.keepConnected
                  ? "Keep on — auto-reconnect when this tile drops"
                  : "Keep off — click to auto-reconnect when this tile drops"
              }
              onClick={() =>
                post({
                  type: "setAgentKeepConnected",
                  agentId: agent!.id,
                  enabled: !agent!.keepConnected,
                })
              }
            >
              <svg
                className="agent-keep-icon"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                {agent!.keepConnected ? (
                  <path
                    fill="currentColor"
                    d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"
                  />
                ) : (
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinejoin="round"
                    d="M16 9V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3z"
                  />
                )}
              </svg>
            </button>
            {isDropped && (
              <button
                className="btn btn-secondary btn-small"
                onClick={() =>
                  post({ type: "reconnectAgent", agentId: agent!.id })
                }
                disabled={workflowRunning}
                title="Re-prime this tile's MCP loop now"
              >
                ↻ Reconnect
              </button>
            )}
            <button
              className={
                "btn btn-danger btn-small" + (closing ? " is-closing" : "")
              }
              onClick={() => {
                if (closing) return;
                post({ type: "deleteAgent", agentId: agent!.id });
                // Stay on detail until close succeeds — host will drop the agent
                // from the list; only navigate back immediately on success path
                // via list refresh. Keep the user here if close fails.
              }}
              disabled={closing}
              title={
                closing
                  ? "Closing tile…"
                  : "Remove from roster and close tile"
              }
              aria-busy={!!closing}
            >
              {closing ? "…" : "×"}
            </button>
          </div>
        )}
      </div>

      <ActivityFeed agent={agent} agents={props.agents} />

      {deleteError && !closing && (
        <p className="agent-close-error-banner" role="alert">
          {deleteError}
        </p>
      )}

      <ChatTab
        history={props.history}
        attachments={props.attachments}
        setAttachments={props.setAttachments}
        appendHistory={props.appendHistory}
        onClearHistory={props.onClearHistory}
        version={props.version}
        onOpenConsole={props.onOpenConsole}
      />
    </div>
  );
}
