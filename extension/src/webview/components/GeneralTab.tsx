/**
 * General tab — Agent workflow (primary), then Usage, Token, Debug.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { post } from "../vscode";
import type { DebugEntry, UsageData } from "../types";
import {
  DEFAULT_WORKFLOW_MODEL,
  mergeWorkflowModels,
} from "../workflowModels";
import { formatWorkflowLog } from "../workflowLog";
import { BrandHeader } from "./Header";

export interface WorkflowLine {
  stream: "stdout" | "stderr";
  line: string;
}

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function GeneralTab(props: {
  usage: UsageData | null;
  loading: boolean;
  tokenInjected: boolean;
  /** Shared pool spawn model (also used by Add agent / Fill / keep-N). */
  workflowModel: string;
  onModelChange: (model: string) => void;
  /** Skip Auto stand-by phase on spawn (persisted host-side). */
  skipAutoPhase: boolean;
  onSkipAutoChange: (enabled: boolean) => void;
  /** Inject agent_id into the MCP prompt (persisted). Off = shared General queue. */
  passAgentId: boolean;
  onPassAgentIdChange: (enabled: boolean) => void;
  /** Live / persisted picker rows from the host (CDP refresh). */
  workflowModels: string[];
  workflowModelsRefreshing?: boolean;
  workflowModelsError?: string | null;
  onRefreshModels: () => void;
  workflowRunning: boolean;
  workflowOutput: WorkflowLine[];
  onClearWorkflowOutput: () => void;
  debugLog: DebugEntry[];
  onClearDebugLog: () => void;
  version: string;
  onOpenConsole: () => void;
}): JSX.Element {
  const {
    usage,
    loading,
    tokenInjected,
    workflowModel,
    onModelChange,
    skipAutoPhase,
    onSkipAutoChange,
    passAgentId,
    onPassAgentIdChange,
    workflowModels,
    workflowModelsRefreshing,
    workflowModelsError,
    onRefreshModels,
    workflowRunning,
    workflowOutput,
    onClearWorkflowOutput,
    debugLog,
    onClearDebugLog,
    version,
    onOpenConsole,
  } = props;

  const [token, setToken] = useState("");
  const model = workflowModel || DEFAULT_WORKFLOW_MODEL;
  const modelOptions = mergeWorkflowModels(workflowModels, model);
  const [showRawLog, setShowRawLog] = useState(false);
  const outRef = useRef<HTMLPreElement | null>(null);
  const dbgRef = useRef<HTMLPreElement | null>(null);

  const prettyLog = useMemo(
    () => formatWorkflowLog(workflowOutput),
    [workflowOutput],
  );

  useEffect(() => {
    if (dbgRef.current) {
      dbgRef.current.scrollTop = dbgRef.current.scrollHeight;
    }
  }, [debugLog]);

  useEffect(() => {
    if (outRef.current) {
      outRef.current.scrollTop = outRef.current.scrollHeight;
    }
  }, [workflowOutput, showRawLog, prettyLog]);

  const runWorkflow = () => {
    post({
      type: "runWorkflow",
      model: model.trim() || undefined,
      // Spawns always accumulate — reconnect/keep live on each dropped tile.
      keepTiles: true,
      // Shared queue (Pass agent_id off) implies Skip Auto.
      skipAuto: skipAutoPhase || !passAgentId,
      singleAgent: !passAgentId,
    });
  };

  return (
    <div className="general-tab">
      <BrandHeader version={version} onOpenConsole={onOpenConsole} />

      {/* 1. Agent workflow */}
      <section className="general-section workflow-card">
        <div className="workflow-head">
          <span className="workflow-title">Agent workflow</span>
          <span
            className={"workflow-status" + (workflowRunning ? " on" : " off")}
          >
            {workflowRunning ? "Running" : "Idle"}
          </span>
        </div>

        <div className="workflow-row workflow-row-model">
          <select
            className="workflow-model-select"
            value={modelOptions.includes(model) ? model : modelOptions[0]}
            disabled={workflowRunning || !!workflowModelsRefreshing}
            onChange={(e) => onModelChange(e.target.value)}
            title="Model the pool spawns with — Add agent, Fill, and per-tile reconnect use this."
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button
            className={
              "btn btn-secondary btn-small" +
              (workflowModelsRefreshing ? " is-refreshing" : "")
            }
            onClick={onRefreshModels}
            disabled={!!workflowModelsRefreshing || workflowRunning}
            title="Open Cursor's model picker via CDP and replace this list with every available row"
          >
            {workflowModelsRefreshing ? "Reading…" : "Refresh"}
          </button>
        </div>
        {workflowModelsError && (
          <div className="workflow-models-error" title={workflowModelsError}>
            {workflowModelsError}
          </div>
        )}

        <div className="workflow-row workflow-row-actions">
          {workflowRunning ? (
            <button
              className="btn btn-danger btn-small"
              onClick={() => post({ type: "stopWorkflow" })}
            >
              Stop
            </button>
          ) : (
            <button
              className="btn btn-primary btn-small"
              onClick={runWorkflow}
            >
              Run
            </button>
          )}
          <label
            className="workflow-opt"
            title="Skip phase 1 (select Auto + stand-by). Select the target model immediately, then MCP-prime. Implied when Pass agent_id is off."
          >
            <input
              type="checkbox"
              checked={skipAutoPhase || !passAgentId}
              disabled={workflowRunning || !passAgentId}
              onChange={(e) => onSkipAutoChange(e.target.checked)}
            />
            Skip Auto
          </label>
          <label
            className="workflow-opt"
            title="When on, spawn/reconnect appends: You are jefr agent <id>; pass agent_id:'<id>' on every jefr MCP call. Off = shared General queue (omit agent_id)."
          >
            <input
              type="checkbox"
              checked={passAgentId}
              disabled={workflowRunning}
              onChange={(e) => onPassAgentIdChange(e.target.checked)}
            />
            Pass agent_id
          </label>
        </div>

        {workflowOutput.length > 0 && (
          <>
            <pre className="workflow-output" ref={outRef}>
              {showRawLog
                ? workflowOutput.map((l, i) => (
                    <div
                      key={i}
                      className={
                        "workflow-line" + (l.stream === "stderr" ? " err" : "")
                      }
                    >
                      {l.line}
                    </div>
                  ))
                : prettyLog.map((l, i) => (
                    <div
                      key={i}
                      className={
                        "workflow-line wf-" +
                        l.kind +
                        (l.stream === "stderr" ? " err" : "")
                      }
                    >
                      {l.text}
                    </div>
                  ))}
            </pre>
            <div className="workflow-row workflow-row-end">
              <button
                className={
                  "btn btn-secondary btn-small" + (showRawLog ? " is-active" : "")
                }
                onClick={() => setShowRawLog((v) => !v)}
                title={
                  showRawLog
                    ? "Show the cleaned stage summary"
                    : "Show the full Python / CDP log"
                }
              >
                {showRawLog ? "Pretty" : "Raw"}
              </button>
              <button
                className="btn btn-secondary btn-small"
                onClick={onClearWorkflowOutput}
              >
                Clear
              </button>
            </div>
          </>
        )}
      </section>

      {/* 2. Usage */}
      <section className="general-section usage-section">
        <div className="general-section-head">
          <span className="general-section-title">Usage</span>
          <button
            className="btn btn-secondary btn-small"
            onClick={() => post({ type: "fetchUsage" })}
            title="Refresh Cursor usage"
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
                  <span className="usage-member-badge">
                    {usage.membershipType}
                  </span>
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

        {!loading && !usage && (
          <div className="general-section-empty">
            No usage loaded yet — hit Refresh.
          </div>
        )}
      </section>

      {/* 3. Token */}
      <section className="general-section token-section">
        <div className="general-section-head">
          <span className="general-section-title">Session token</span>
          <span
            className={
              "inject-status-dot" + (tokenInjected ? " on" : " off")
            }
            title={tokenInjected ? "Token injected" : "No token"}
          />
        </div>
        <div className="inject-status">
          <span className="token-status-label">
            {tokenInjected ? "Token injected" : "No token"}
          </span>
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
                onClick={() =>
                  post({ type: "injectToken", token: token.trim() })
                }
              >
                Inject
              </button>
            </>
          )}
        </div>
      </section>

      {/* 4. Debug */}
      <section className="general-section debug-card">
        <div className="debug-head">
          <span className="debug-title">Debug log</span>
          <span className="debug-count">{debugLog.length}</span>
          <div className="debug-actions">
            <button
              className="btn btn-secondary btn-small"
              disabled={debugLog.length === 0}
              onClick={() => {
                const text = debugLog
                  .map((e) => `${fmtClock(e.ts)} [${e.level}] ${e.line}`)
                  .join("\n");
                navigator.clipboard?.writeText(text).catch(() => {});
              }}
              title="Copy the whole debug log"
            >
              Copy
            </button>
            <button
              className="btn btn-secondary btn-small"
              disabled={debugLog.length === 0}
              onClick={onClearDebugLog}
              title="Clear the debug log"
            >
              Clear
            </button>
          </div>
        </div>
        {debugLog.length === 0 ? (
          <div className="debug-empty">
            No events yet — agent connects, drops, self-heals, spawns and reaps
            will show up here.
          </div>
        ) : (
          <pre className="debug-output" ref={dbgRef}>
            {debugLog.map((e, i) => (
              <div key={i} className={"debug-line " + e.level}>
                <span className="debug-time">{fmtClock(e.ts)}</span>
                <span className="debug-msg">{e.line}</span>
              </div>
            ))}
          </pre>
        )}
      </section>
    </div>
  );
}

function UsageProgress(props: {
  used?: number;
  limit?: number;
}): JSX.Element | null {
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
