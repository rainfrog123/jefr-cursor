/**
 * Agents tab — the hub of the panel. Shows a "General · shared" card plus one
 * card per agent tile. Clicking a card makes it the ACTIVE agent: the one the
 * Obsidian plugin (and the webview) routes to. Dropped tiles show Keep +
 * Reconnect on the card itself.
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
  targetAgentCount: number;
  /** Shared pool spawn model (chosen in the workflow dropdown). */
  workflowModel: string;
  cdpConnected?: boolean;
  workflowRunning?: boolean;
  connectingAgentId?: string | null;
  connectingSince?: number;
  sharedQueueCount?: number;
  refreshing?: boolean;
  /** Agent ids currently mid-delete (CDP close in flight). */
  closingAgentIds?: Set<string>;
  /** Per-agent close failure message. */
  deleteErrors?: Record<string, string>;
  onRefresh?: () => void;
  onSelectAgent: (id: string | null) => void;
  onOpenDetail: (id: string | null) => void;
}): JSX.Element {
  const {
    agents,
    selectedAgentId,
    targetAgentCount,
    workflowModel,
    cdpConnected,
    workflowRunning,
    connectingAgentId,
    connectingSince,
    sharedQueueCount,
    refreshing,
    closingAgentIds,
    deleteErrors,
    onRefresh,
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
  // Live MCP loop, plus previously-connected tiles that dropped but still occupy
  // a pool slot (keep-N will re-prime them in place, not replace).
  const connectedCount = agents.filter((a) => {
    if (a.id === connectingAgentId) return false;
    return (
      a.connected ||
      (a.connectCount > 0 && (a.dropped || a.serverDropped))
    );
  }).length;
  const slotsLeft = Math.max(0, targetAgentCount - agents.length);
  // Manual "Add agent" is uncapped — you can grow the pool to as many agents as
  // you like. "Fill" only tops up to the auto-baseline (targetAgentCount).
  const canAddOne = !workflowRunning;
  const canFill = agents.length < targetAgentCount && !workflowRunning;
  // Stable pool order. Sorting by live tileIndex reshuffled the list whenever
  // Cursor/CDP reordered panes or when the heartbeat fallback ranked by
  // freshest ts. Prefer host order (already stable); tie-break by id only.
  const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id));
  // Always render every agent, at least the baseline count of slots, and one
  // trailing empty slot so you can keep adding past the baseline.
  const slotCount = Math.max(targetAgentCount, agents.length + 1);

  const spawnModel = workflowModel || DEFAULT_WORKFLOW_MODEL;

  const addAgent = () => {
    post({ type: "addAgent", model: spawnModel });
  };

  const fillPool = () => {
    post({ type: "addAgents", model: spawnModel });
  };

  // Pool target (slots + "Keep N connected" baseline). Host clamps to 1–12 and
  // persists it; we just nudge by ±1.
  const setTarget = (n: number) => post({ type: "setTargetAgentCount", count: n });
  const equalizeTiles = () => post({ type: "equalizeTiles" });

  // Force the host to re-scan CDP and re-push the full roster, so every tile
  // actually open in Cursor (including dropped ones) shows up immediately. Prefer
  // the parent handler (drives the spinner + safety timeout); fall back to a bare
  // post so the button still works if the prop isn't wired.
  const refresh = () => {
    if (refreshing) return;
    if (onRefresh) onRefresh();
    else post({ type: "refreshAgents" });
  };

  return (
    <div className="agents-tab">
      <div className="agents-hero">
        <h2 className="agents-hero-title">Agent pool</h2>
        <div className="agents-pills" aria-label="Pool status">
          <span className="agents-pill" title="MCP-connected agents (excl. still connecting)">
            <strong>{connectedCount}</strong> connected
          </span>
          <span className="agents-pill" title="Agents currently in the roster">
            <strong>{agents.length}</strong> online
          </span>
          <span
            className={"agents-pill cdp " + (cdpConnected ? "on" : "off")}
            title={
              cdpConnected
                ? "CDP monitoring active (port 9222)"
                : "CDP offline — using file heartbeats"
            }
          >
            <span className="agents-pill-dot" />
            CDP
          </span>
        </div>
      </div>

      <div className="agents-toolbar">
        <button
          className="btn btn-primary btn-small"
          disabled={!canAddOne}
          onClick={addAgent}
          title={`Spawn a new agent tile (${spawnModel}). No cap — add as many as you want.`}
        >
          + Add
        </button>
        <button
          className="btn btn-primary btn-small"
          disabled={!canFill}
          onClick={fillPool}
          title={`Fill the pool to ${targetAgentCount} agents in one click (${spawnModel}). Spawns are queued and run one at a time.`}
        >
          {slotsLeft > 0 ? `+${slotsLeft}` : `Fill ${targetAgentCount}`}
        </button>
        <button
          className={"btn btn-secondary btn-small" + (refreshing ? " is-refreshing" : "")}
          onClick={refresh}
          disabled={refreshing}
          title="Re-scan Cursor (force-reconnect CDP) and refresh the roster"
        >
          {refreshing ? "…" : "↻"}
        </button>
        <button
          className="btn btn-secondary btn-small"
          onClick={equalizeTiles}
          title="Make every agent tile the same width"
        >
          ⊟
        </button>

        <div
          className="agents-target"
          title="Pool size: how many agent slots to show and keep connected (1–12)."
        >
          <span className="agents-target-label">Target</span>
          <button
            className="btn btn-secondary btn-small agents-target-btn"
            disabled={targetAgentCount <= 1}
            onClick={() => setTarget(targetAgentCount - 1)}
            aria-label="Decrease pool target"
          >
            −
          </button>
          <span className="agents-target-num">{targetAgentCount}</span>
          <button
            className="btn btn-secondary btn-small agents-target-btn"
            disabled={targetAgentCount >= 12}
            onClick={() => setTarget(targetAgentCount + 1)}
            aria-label="Increase pool target"
          >
            +
          </button>
        </div>

        <div className="agents-toolbar-spacer" />

        {slotsLeft > 0 && agents.length > 0 && (
          <span className="agents-slots-hint">{slotsLeft} free</span>
        )}
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
          const isClosing = !!closingAgentIds?.has(a.id);
          const deleteError = deleteErrors?.[a.id];

          return (
            <div
              key={a.id}
              className={
                "agent-slot filled" +
                (isMain ? " main" : "") +
                (isClosing ? " is-closing" : "")
              }
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
                {a.activity?.summary && (
                  <span
                    className="agent-activity"
                    title={
                      a.activity.tools?.length
                        ? `${a.activity.summary}\nTools: ${a.activity.tools.join(" → ")}`
                        : a.activity.summary
                    }
                  >
                    {a.activity.summary}
                  </span>
                )}
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
                {isClosing && (
                  <span className="agent-timing agent-closing">closing…</span>
                )}
                {deleteError && !isClosing && (
                  <span className="agent-timing agent-close-error" title={deleteError}>
                    {deleteError}
                  </span>
                )}
                {a.model && (
                  <span
                    className="agent-model"
                    title={a.model.replace(/[\u200b\u200c\u200d\ufeff]/g, "")}
                  >
                    {a.model.replace(/[\u200b\u200c\u200d\ufeff]/g, "").trim()}
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
                  type="button"
                  className={
                    "btn btn-secondary btn-small agent-keep-btn" +
                    (a.keepConnected ? " on" : "")
                  }
                  aria-pressed={!!a.keepConnected}
                  aria-label={
                    a.keepConnected ? "Keep connected on" : "Keep connected off"
                  }
                  title={
                    a.keepConnected
                      ? "Keep on — auto-reconnect when this tile drops"
                      : "Keep off — click to auto-reconnect when this tile drops"
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    post({
                      type: "setAgentKeepConnected",
                      agentId: a.id,
                      enabled: !a.keepConnected,
                    });
                  }}
                >
                  <svg
                    className="agent-keep-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    {a.keepConnected ? (
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
                    onClick={(e) => {
                      e.stopPropagation();
                      post({ type: "reconnectAgent", agentId: a.id });
                    }}
                    disabled={workflowRunning}
                    title="Re-prime this tile's MCP loop now"
                  >
                    ↻
                  </button>
                )}
                <button
                  className={
                    "btn btn-danger btn-small" + (isClosing ? " is-closing" : "")
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isClosing) return;
                    post({ type: "deleteAgent", agentId: a.id });
                  }}
                  disabled={isClosing}
                  title={
                    isClosing
                      ? "Closing tile…"
                      : "Remove from roster and close tile"
                  }
                  aria-busy={isClosing}
                >
                  {isClosing ? "…" : "×"}
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
