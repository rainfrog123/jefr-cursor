/**
 * General-purpose tab (formerly "Usage").
 *
 * Hosts the CDP **agent workflow** runner — which spawns a fresh Cursor agent
 * tile, sends a stand-by prompt, switches to Opus, types the invoke-mcp prompt,
 * and holds Enter past "Planning next moves" — and keeps the original Cursor
 * usage panel below it.
 */
import React, { useEffect, useRef, useState } from "react";
import { post } from "../vscode";
import type { UsageData } from "../types";

export interface WorkflowLine {
  stream: "stdout" | "stderr";
  line: string;
}

export function GeneralTab(props: {
  usage: UsageData | null;
  loading: boolean;
  tokenInjected: boolean;
  workflowRunning: boolean;
  workflowOutput: WorkflowLine[];
  onClearWorkflowOutput: () => void;
}): JSX.Element {
  const {
    usage,
    loading,
    tokenInjected,
    workflowRunning,
    workflowOutput,
    onClearWorkflowOutput,
  } = props;

  const [token, setToken] = useState("");
  const [autoPrompt, setAutoPrompt] = useState("");
  const [opusPrompt, setOpusPrompt] = useState("");
  const [maxSecs, setMaxSecs] = useState("");
  const [tile, setTile] = useState("");
  const outRef = useRef<HTMLPreElement | null>(null);

  // Keep the log scrolled to the newest line.
  useEffect(() => {
    if (outRef.current) {
      outRef.current.scrollTop = outRef.current.scrollHeight;
    }
  }, [workflowOutput]);

  const runWorkflow = () => {
    const maxSecsNum = maxSecs.trim() ? Number(maxSecs.trim()) : undefined;
    post({
      type: "runWorkflow",
      autoPrompt: autoPrompt.trim() || undefined,
      opusPrompt: opusPrompt.trim() || undefined,
      maxSecs:
        maxSecsNum != null && isFinite(maxSecsNum) ? maxSecsNum : undefined,
    });
  };

  const reconnectWorkflow = () => {
    const maxSecsNum = maxSecs.trim() ? Number(maxSecs.trim()) : undefined;
    const tileNum = tile.trim() ? Number(tile.trim()) : undefined;
    post({
      type: "reconnectWorkflow",
      tile:
        tileNum != null && Number.isInteger(tileNum) ? tileNum : undefined,
      opusPrompt: opusPrompt.trim() || undefined,
      maxSecs:
        maxSecsNum != null && isFinite(maxSecsNum) ? maxSecsNum : undefined,
    });
  };

  return (
    <div className="general-tab">
      {/* ── Agent workflow runner ── */}
      <div className="workflow-card">
        <div className="workflow-head">
          <span className="workflow-title">Agent workflow</span>
          <span
            className={
              "workflow-status" + (workflowRunning ? " on" : " off")
            }
          >
            {workflowRunning ? "Running" : "Idle"}
          </span>
        </div>

        <p className="workflow-desc">
          Spawns a fresh Cursor agent tile over CDP, sends a stand-by prompt,
          switches to Opus, types the invoke-mcp prompt, then holds Enter past
          “Planning next moves”. <strong>Reconnect</strong> instead re-primes a
          dropped (“Worked”) tile in place — auto-detecting it, or use the tile
          index — to rebuild the MCP loop on that same tile. Requires Cursor
          launched with <code>--remote-debugging-port=9222</code>.
        </p>

        <textarea
          className="workflow-input"
          placeholder="Auto / stand-by prompt (optional — defaults to a timestamped stand-by)"
          rows={2}
          value={autoPrompt}
          disabled={workflowRunning}
          onChange={(e) => setAutoPrompt(e.target.value)}
        />
        <textarea
          className="workflow-input"
          placeholder="Opus prompt (optional — defaults to an invoke-mcp instruction)"
          rows={2}
          value={opusPrompt}
          disabled={workflowRunning}
          onChange={(e) => setOpusPrompt(e.target.value)}
        />

        <div className="workflow-row">
          <input
            className="card-input workflow-secs"
            type="number"
            min={0}
            placeholder="Max secs (600)"
            value={maxSecs}
            disabled={workflowRunning}
            onChange={(e) => setMaxSecs(e.target.value)}
          />
          <input
            className="card-input workflow-secs"
            type="number"
            min={0}
            placeholder="Tile # (auto)"
            value={tile}
            disabled={workflowRunning}
            onChange={(e) => setTile(e.target.value)}
            title="Tile index to reconnect (leave blank to auto-detect the dropped tile)"
          />
          {workflowRunning ? (
            <button
              className="btn btn-danger btn-small"
              onClick={() => post({ type: "stopWorkflow" })}
            >
              Stop
            </button>
          ) : (
            <>
              <button
                className="btn btn-primary btn-small"
                onClick={runWorkflow}
              >
                Run workflow
              </button>
              <button
                className="btn btn-secondary btn-small"
                onClick={reconnectWorkflow}
                title="Re-prime a dropped tile in place to rebuild the MCP loop"
              >
                Reconnect
              </button>
            </>
          )}
        </div>

        {workflowOutput.length > 0 && (
          <>
            <pre className="workflow-output" ref={outRef}>
              {workflowOutput.map((l, i) => (
                <div
                  key={i}
                  className={
                    "workflow-line" +
                    (l.stream === "stderr" ? " err" : "")
                  }
                >
                  {l.line}
                </div>
              ))}
            </pre>
            <div className="workflow-row workflow-row-end">
              <button
                className="btn btn-secondary btn-small"
                onClick={onClearWorkflowOutput}
              >
                Clear output
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── Cursor usage (kept) ── */}
      <div className="inject-status">
        <span
          className={"inject-status-dot" + (tokenInjected ? " on" : " off")}
        />
        <span>{tokenInjected ? "Token injected" : "No token"}</span>
        {tokenInjected ? (
          <button
            className="btn btn-secondary btn-small"
            onClick={() => post({ type: "clearInjectedToken" })}
          >
            Clear
          </button>
        ) : (
          <>
            <input
              className="card-input"
              placeholder="Paste session token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            <button
              className="btn btn-primary btn-small"
              disabled={!token.trim()}
              onClick={() => post({ type: "injectToken", token: token.trim() })}
            >
              Inject
            </button>
          </>
        )}
        <button
          className="btn btn-secondary btn-small"
          onClick={() => post({ type: "fetchUsage" })}
        >
          Refresh
        </button>
      </div>

      {loading && (
        <div className="usage-loading">
          <div className="usage-spinner" />
          <span>Loading usage…</span>
        </div>
      )}

      {!loading && usage && !usage.success && (
        <div className="usage-error">
          <div className="usage-error-icon">!</div>
          <span>{usage.error || "Failed to load usage"}</span>
        </div>
      )}

      {!loading && usage && usage.success && (
        <div className="usage-header-card">
          <div className="usage-header-top">
            <div className="usage-header-info">
              {usage.email && (
                <div className="usage-email-row">
                  <span className="usage-email">{usage.email}</span>
                </div>
              )}
              {usage.membershipType && (
                <span className="usage-member-badge">{usage.membershipType}</span>
              )}
            </div>
          </div>

          {usage.isUnlimited ? (
            <span className="usage-unlimited-badge">Unlimited</span>
          ) : (
            <UsageProgress used={usage.used} limit={usage.limit} />
          )}
        </div>
      )}
    </div>
  );
}

function UsageProgress(props: { used?: number; limit?: number }): JSX.Element | null {
  const { used, limit } = props;
  if (used == null || !limit) return null;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className="usage-progress-card">
      <div className="usage-progress-header">
        <span className="usage-progress-label">
          {used} / {limit}
        </span>
        <span className="usage-progress-pct">{pct}%</span>
      </div>
    </div>
  );
}
