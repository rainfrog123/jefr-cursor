import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";
import { spawn, spawnSync, type ChildProcess } from "child_process";

import {
  setDataDir,
  migrateFromRootDir,
  setHistorySink,
  readQueue,
  getQueueCount,
  deleteQueueItem,
  clearQueue,
  updateQueueItem,
  sendText,
  sendImage,
  sendFile,
  appendSharedHistory,
  appendReplyToSharedHistory,
  makeId,
  readQuestion,
  writeAnswer,
  cancelQuestion,
  readReply,
  clearReply,
  listLiveAgents,
  scanAllAgents,
  forgetAgentDir,
  readQueueFor,
  getQueueCountFor,
  getAgentStatusFor,
  sendTextTo,
  sendImageTo,
  sendImagesTo,
  sendFileTo,
  deleteQueueItemFor,
  clearQueueFor,
  clearAllQueues,
  listAgentDirIds,
  updateQueueItemFor,
  readReplyFor,
  clearReplyFor,
  readQuestionFor,
  writeAnswerFor,
  cancelQuestionFor,
  readCardState,
  clearCardState,
  isCardValid,
  activateCard,
  readInjectedToken,
  writeInjectedToken,
  clearInjectedToken,
  fetchCursorUsage,
  setupGlobalMcpConfig,
  setupMcpConfig,
  removeMcpConfig,
  pollRemoteMessages,
  pushRemoteReply,
  pushRemoteQuestion,
  cancelRemoteQuestion,
  pollRemoteAnswer,
  sendWorkspaceHeartbeat,
  REMOTE_API_ENABLED,
  writeSelectedAgentId,
  readSelectedAgentId,
  type QuestionPayload,
} from "./messenger";
import {
  startLocalServer,
  stopLocalServer,
  setWorkspaceInfo,
  setSelectedAgentId,
  setSelectAgentHandler,
  getServerPort,
  getConnectedClients,
  setBridgeAgentModels,
} from "./local-server";
import {
  reconcile,
  pickReconnect,
  type AgentStat,
} from "./agentStats";
import { getCdpMonitor, stopCdpMonitor, type CdpStatus } from "./cdp-monitor";
import { TileStateManager, type AgentView } from "./tile-state";
import {
  clearTranscriptCache,
  getTranscriptActivity,
  setTranscriptWorkspaceRoots,
  stopTranscriptWatchers,
  syncTranscriptWatchers,
} from "./agentTranscript";
import type { TranscriptActivity } from "./agentTranscript";
import { composerAliveAt, isComposerStateAvailable } from "./composerState";

/**
 * How recently Cursor's own conversation record must have advanced for an agent
 * to count as alive despite a stale MCP heartbeat.
 *
 * Sized from measurement: across 20 agents, live ones checkpointed within
 * 29–131s while dead ones were 4,191s+ — a ~30x gap. Five minutes sits well
 * inside it, so it tolerates a slow checkpoint without ever rescuing a corpse.
 */
const COMPOSER_ALIVE_GRACE_MS = 5 * 60_000;

/** Prefer a fresh jefr reply/progress line when the transcript tail is still on
 *  GetMcpTools / Listening — so the Agents list shows what the agent said it's
 *  doing without watching the Cursor tile. */
function liveActivityFor(agentId: string): TranscriptActivity | undefined {
  const tr = getTranscriptActivity(agentId);
  const reply = readReplyFor(agentId);
  const content = reply?.content?.replace(/\s+/g, " ").trim();
  if (!content) return tr;
  const boring =
    !tr ||
    /^(Listening \(MCP\)|Checking MCP tools|No transcript activity yet)/i.test(
      tr.summary,
    );
  if (!boring) return tr;
  // Keep the transcript's own feed/step data — only the headline is replaced,
  // because what the agent *told* the panel beats a bookkeeping tool call.
  return {
    summary: content.slice(0, 140),
    tools: tr?.tools ?? [],
    steps: tr?.steps ?? [],
    stepCount: tr?.stepCount ?? 0,
    stepCountPartial: tr?.stepCountPartial ?? false,
    since: tr?.since,
    ended: tr?.ended ?? false,
    endStatus: tr?.endStatus,
    error: tr?.error,
    mtimeMs: tr?.mtimeMs,
  };
}

// ── Module state ────────────────────────────────────────────────────────────

let mainPanel: vscode.WebviewView | undefined;
let pollTimer2: ReturnType<typeof setInterval> | undefined;
let lastQuestionId: string | undefined;
let lastReplyTimestamp: string | undefined;
let lastQueueCount: number | undefined;
let lastAllQueuesJson: string | undefined;
let lastCardValid: boolean | undefined;
let chatTriggered = false;
let extensionVersion = "0.0.0";
let currentDataDir = "";
let remotePollTimer: ReturnType<typeof setInterval> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let lastReplyContent: string | undefined;
let lastRemoteQuestionId: string | undefined;
let idleTimer: ReturnType<typeof setInterval> | undefined;
let lastActivityTime = Date.now();

// ── Multi-agent routing ─────────────────────────────────────────────────────
// The panel can target a specific agent tile (by its Cursor agentId). When set,
// sends, replies, questions, and the queue are scoped to that agent's own dir.
// undefined = the shared root queue (legacy single-listener behavior).
let selectedAgentId: string | undefined;
let lastAgentListJson: string | undefined;

// Per-agent keep: when a dropped tile has keep enabled, the extension re-primes
// that tile in place. No global "Keep agents" — each tile opts in on its own.
const keepConnectedAgents = new Set<string>();
const KEEP_CONNECTED_KEY = "jefr.keepConnectedAgents";
const RECONNECT_DEBOUNCE_MS = 30_000;

function anyKeepConnected(): boolean {
  return keepConnectedAgents.size > 0;
}

function setAgentKeepConnected(agentId: string, enabled: boolean): void {
  const id = agentId.trim();
  if (!id) return;
  if (enabled) keepConnectedAgents.add(id);
  else keepConnectedAgents.delete(id);
  void extensionContext?.globalState.update(
    KEEP_CONNECTED_KEY,
    [...keepConnectedAgents],
  );
  lastAgentListJson = undefined;
  pushAgentList();
  if (enabled) void maintainPool();
}

function forgetKeepConnected(agentId: string): void {
  if (!keepConnectedAgents.delete(agentId)) return;
  void extensionContext?.globalState.update(
    KEEP_CONNECTED_KEY,
    [...keepConnectedAgents],
  );
}
/** How long a tile must stay continuously cut off before the self-healing pool
 *  closes it and spawns a replacement. A drop must be CONFIRMED for this long —
 *  not a momentary blip — so a healthy-but-bursty loop is never needlessly
 *  recycled. Drives `maintainPool` via `getDroppedAgents(CONFIRM_DROP_MS)`. */
const CONFIRM_DROP_MS = 10_000;
/** Forget disconnected agents after this long without a heartbeat — they're
 *  tombstones from closed tabs / past sessions and shouldn't linger or be
 *  reconnected. */
const AGENT_FORGET_MS = 5 * 60_000;
/** Give up auto-reconnecting an agent after this many failed attempts since its
 *  last successful landing. The manual Reconnect button still works anytime. */
const MAX_RECONNECT_ATTEMPTS = 3;
/** When true, also delete a forgotten agent's on-disk dir (queue/history/etc).
 *  Off by default — non-destructive: tombstones are only hidden from the roster. */
const GC_AGENT_DIRS: boolean = false;

const agentStats = new Map<string, AgentStat>();

// ── CDP-based tile state (replaces file heartbeats) ─────────────────────────
const tileStateManager = new TileStateManager();
let cdpEnabled = true; // Set false to fall back to file-based heartbeats
let lastCdpStatus: CdpStatus | null = null;

// ── CDP-based agent monitoring ──────────────────────────────────────────────

function startCdpMonitoring(): void {
  if (!cdpEnabled) return;

  const monitor = getCdpMonitor();

  // Listen for state changes
  monitor.on("status", (status: CdpStatus) => {
    const wasCdp = lastCdpStatus?.connected ?? false;
    lastCdpStatus = status;

    if (wasCdp !== status.connected) {
      dlog(
        `CDP ${status.connected ? "connected" : "disconnected"}${status.error ? " — " + status.error : ""}`,
        status.connected ? "info" : "warn",
      );
    }

    if (!status.connected) {
      // CDP not available — fall back to file-based heartbeats
      return;
    }

    // Build filesystem-derived state. CDP knows which tile is visible, while the
    // MCP heartbeat knows when an agent is actively working between tool calls.
    const queueCounts = new Map<string, number>();
    const heartbeatStates = new Map<string, "waiting" | "working">();
    for (const tile of status.tiles) {
      if (tile.agentId) {
        queueCounts.set(tile.agentId, getQueueCountFor(tile.agentId));
        const heartbeat = getAgentStatusFor(tile.agentId);
        if (heartbeat.alive) {
          heartbeatStates.set(tile.agentId, heartbeat.state);
        }
      }
    }

    // Update state machine (drops vanished tiles after the forget window)
    const transitions = tileStateManager.update(
      status.tiles,
      queueCounts,
      AGENT_FORGET_MS,
      heartbeatStates,
    );

    // Surface meaningful transitions in the debug log (skip noisy state flips).
    for (const t of transitions) {
      const who = t.agentId.slice(0, 8);
      if (t.type === "connected") dlog(`agent ${who} connected (${t.to})`);
      else if (t.type === "disconnected") {
        const held =
          typeof t.connectedMs === "number" && t.connectedMs > 0
            ? ` after ${fmtHeldDuration(t.connectedMs)} connected`
            : "";
        dlog(`agent ${who} dropped (${t.from} → ${t.to})${held}`, "warn");
      } else if (t.type === "new_agent") dlog(`agent ${who} appeared (${t.to})`);
    }

    // Always-on: the "Payment failed … Manage Billing" banner has no native
    // dismiss, so hide it on sight (the tile itself is left open). Re-applied on
    // every status change; the self-heal tick re-applies it on its poll too.
    if (status.tiles.some((t) => t.billingBlocked)) {
      hideBillingBannersNow();
    }

    // Self-healing pool: close cut-off tiles and top up to the target.
    if (anyKeepConnected() && !workflowProc && !healingTile) {
      void maintainPool();
    }

    // Reap dead agents' on-disk dirs (throttled) so ghosts don't pile up.
    gcDeadAgentDirs();

    // Push to webview
    pushAgentListFromCdp();
  });

  // Start monitoring (async, non-blocking)
  monitor.start().catch((e) => {
    console.error("CDP monitor failed to start:", e);
  });
}

/** Coarse human-friendly duration for log lines: `1h 4m` / `4m 12s` / `12s`. */
function fmtHeldDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function pushAgentListFromCdp(): void {
  if (!mainPanel) return;

  let agents = tileStateManager.toAgentViews();
  // CDP can connect (e.g. to "Cursor Agents") yet find zero tiles when selectors
  // drift — fall back to MCP heartbeats on disk so the roster stays populated.
  if (agents.length === 0) {
    pushAgentListFromHeartbeats(true);
    return;
  }

  resolveSpawnConnectingId(agents);
  recordConnectTime(agents);
  lastPushedAgentIds = new Set(agents.map((a) => a.id));
  // Push again as soon as Cursor flushes a transcript checkpoint, instead of
  // waiting up to a full poll. The poll below is still the floor.
  syncTranscriptWatchers(
    agents.map((a) => a.id),
    () => pushAgentList(),
  );

  const payload = {
    agents: agents.map((a) => ({
      ...a,
      activity: liveActivityFor(a.id),
      connectMs: agentConnectMs.get(a.id),
      keepConnected: keepConnectedAgents.has(a.id),
    })),
    selected: selectedAgentId || null,
    targetAgentCount,
    workflowModel: poolModel,
    skipAutoPhase,
    passAgentId: passAgentIdEnabled(),
    singleAgentMode,
    cdpConnected: lastCdpStatus?.connected ?? false,
    connectingAgentId: workflowProc ? activeWorkflowAgentId ?? null : null,
    connectingSince: workflowProc ? workflowStartedAt : 0,
  };

  // Write CDP status to file for external consumers (Obsidian plugin).
  writeCdpStatusFile(agents);

  setSelectedAgentId(selectedAgentId);

  // Dedupe to avoid spam
  const json = JSON.stringify(payload);
  if (json !== lastAgentListJson) {
    lastAgentListJson = json;
    mainPanel.webview.postMessage({ type: "agentList", ...payload });
  }
}

/** Write CDP-derived agent status to a file for external consumers (Obsidian plugin). */
function writeCdpStatusFile(agents: AgentView[]): void {
  setBridgeAgentModels(agents);
  try {
    const statusFile = path.join(os.homedir(), ".moyu-message", "cdp-status.json");
    const status = {
      ts: Date.now(),
      cdpConnected: lastCdpStatus?.connected ?? false,
      pageTitle: lastCdpStatus?.pageTitle ?? null,
      agents: agents.map((a) => ({
        id: a.id,
        state: a.state,
        connected: a.connected,
        model: a.model,
        tileIndex: a.tileIndex,
        connectedSince: a.connectedSince,
        queueCount: a.queueCount,
      })),
    };
    fs.writeFileSync(statusFile, JSON.stringify(status, null, 2), "utf-8");
  } catch {
    // best-effort — don't crash on file errors
  }
}

// ── Agent workflow automation (CDP) ─────────────────────────────────────────
// All workflow routes resolve to jefr-cursor/automation/workflow.py — never a
// legacy copy elsewhere on disk.

let workflowProc: ChildProcess | undefined;
/** The agent a running workflow is re-priming (reconnect target) or spawning.
 *  For a reconnect it's known up front; for a fresh spawn it's resolved once the
 *  new tile appears (see resolveSpawnConnectingId). Lets the UI show that one
 *  tile as "connecting" — and only that tile — until the workflow finishes. */
let activeWorkflowAgentId: string | undefined;
/** Agent ids that already existed when the current fresh-spawn workflow started.
 *  The first tile to appear outside this set is the one the spawn is creating. */
let spawnBaselineAgentIds: Set<string> | undefined;
/** Ids in the most recently pushed roster, so a spawn can snapshot the baseline. */
let lastPushedAgentIds = new Set<string>();
/** Epoch ms the current workflow started — the clock for "time to connect". */
let workflowStartedAt = 0;
/** Per-agent time (ms) the spawn/reconnect workflow took to bring it online. */
const agentConnectMs = new Map<string, number>();

/** For a running fresh spawn (no known target yet), claim the first newly-seen
 *  tile as the "connecting" agent so its label stays stable while it's primed. */
function resolveSpawnConnectingId(agents: ReadonlyArray<{ id: string }>): void {
  if (!workflowProc || activeWorkflowAgentId || !spawnBaselineAgentIds) return;
  // Wait for the new tile's REAL agentId before latching — a synthetic slot id
  // would go stale once the fiber agentId resolves, breaking the connecting
  // highlight and the time-to-connect measurement.
  const fresh = agents.find(
    (a) => !a.id.startsWith("tile:") && !spawnBaselineAgentIds!.has(a.id),
  );
  if (fresh) activeWorkflowAgentId = fresh.id;
}

/** True when `aid` is the tile a running workflow is currently spawning / re-
 *  priming — i.e. the one the UI shows as "Connecting…". Closing that tile must
 *  also stop the workflow, otherwise the script keeps driving a tile that's gone
 *  (re-typing / re-targeting), which looks like the spawn "won't stop". Handles
 *  the fresh-spawn case where the target id hasn't latched yet: any tile outside
 *  the pre-spawn baseline is the one being created. */
function isConnectingTarget(aid: string): boolean {
  if (!workflowProc) return false;
  if (activeWorkflowAgentId) return aid === activeWorkflowAgentId;
  // Fresh spawn, target not yet latched: the new tile is whatever wasn't in the
  // roster when the spawn started (a real id outside the baseline, or a freshly
  // synthesized slot id that only exists because the spawn opened it).
  if (spawnBaselineAgentIds) {
    return aid.startsWith("tile:") || !spawnBaselineAgentIds.has(aid);
  }
  return false;
}

/** Once the active workflow's agent reaches the real MCP loop, record how long it
 *  took (from workflow start) and log it. Recorded exactly once per workflow run.
 *  Only the MCP-loop states count — NOT the Auto stand-by phase's generating/
 *  planning — so the time-to-connect reflects the actual connection. */
function recordConnectTime(
  agents: ReadonlyArray<{ id: string; state: string }>,
): void {
  if (!workflowProc || !activeWorkflowAgentId || !workflowStartedAt) return;
  if (agentConnectMs.has(activeWorkflowAgentId)) return;
  const a = agents.find((x) => x.id === activeWorkflowAgentId);
  const mcpLoop =
    a?.state === "mcp_connected" ||
    a?.state === "waiting" ||
    a?.state === "working";
  if (!mcpLoop) return;
  const ms = Date.now() - workflowStartedAt;
  agentConnectMs.set(activeWorkflowAgentId, ms);
  postWorkflow({
    type: "workflowOutput",
    stream: "stdout",
    line: `[jefr] agent ${activeWorkflowAgentId.slice(0, 8)} connected in ${(ms / 1000).toFixed(1)}s`,
  });
}

/** workflow.py prints its own authoritative time-to-connect right before it
 *  exits, e.g.:
 *    "workflow: MCP connected in 42.3s (agent <uuid>)"
 *    "workflow: reconnected MCP in 8.1s (agent <uuid>)"
 *  That's the workflow's wall-clock from process start to a CONFIRMED MCP loop —
 *  the source of truth for "how long the workflow took to connect". Parse it and
 *  record it (overriding the coarser CDP heuristic) so the agent-detail
 *  "connected in" stat shows exactly what the workflow reported. */
const WORKFLOW_CONNECT_RE =
  /workflow:\s+(?:MCP connected|reconnected MCP)\s+in\s+([\d.]+)s\s+\(agent\s+([^)]+)\)/i;
function maybeRecordWorkflowConnect(line: string): void {
  const m = WORKFLOW_CONNECT_RE.exec(line);
  if (!m) return;
  const secs = parseFloat(m[1]);
  const id = m[2].trim();
  if (!isFinite(secs) || !id || id === "None") return;
  agentConnectMs.set(id, Math.round(secs * 1000));
  lastAgentListJson = undefined; // force a re-push so the detail stat updates now
  pushAgentList();
}

/**
 * Candidate locations for automation scripts.
 *   1. VSIX / installed layout: extension/dist → extension/automation/
 *   2. Repo / F5 layout:       extension/dist → jefr-cursor/automation/
 */
function bundledAutomationCandidates(filename: string): string[] {
  return [
    path.join(__dirname, "..", "automation", filename),
    path.join(__dirname, "..", "..", "automation", filename),
  ];
}

/** Cached workflow script path (recomputed when workspace folders change). */
let resolvedWorkflowScript: string | undefined;
let resolvedWorkflowScriptFor: string | undefined;

/**
 * Resolve workflow.py. Locations considered (first hit wins):
 *   1. automation/ bundled inside the extension (VSIX)
 *   2. jefr-cursor/automation/ next to the extension (repo checkout)
 *   3. automation/workflow.py in each open workspace folder
 * Returns null when none exist.
 * Spawn and reconnect both use this script (--reconnect implies skip-auto).
 */
function resolveWorkflowScript(): string | null {
  const wsKey = (vscode.workspace.workspaceFolders || [])
    .map((f) => f.uri.fsPath)
    .join("|");
  if (resolvedWorkflowScript !== undefined && resolvedWorkflowScriptFor === wsKey) {
    return resolvedWorkflowScript || null;
  }
  const candidates: string[] = [...bundledAutomationCandidates("workflow.py")];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    candidates.push(path.join(folder.uri.fsPath, "automation", "workflow.py"));
  }
  resolvedWorkflowScript = candidates.find((p) => fs.existsSync(p)) ?? "";
  resolvedWorkflowScriptFor = wsKey;
  return resolvedWorkflowScript || null;
}

/** Resolve cdp.py — same search order as workflow.py. */
function resolveCdpScript(): string | null {
  const candidates: string[] = [...bundledAutomationCandidates("cdp.py")];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    candidates.push(path.join(folder.uri.fsPath, "automation", "cdp.py"));
  }
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

/** Default model for workflow spawn (--model when the UI omits one). */
const WORKFLOW_DEFAULT_MODEL = "Opus 4.8 1M Extra High Fast";
/** Static fallback when CDP hasn't refreshed the live picker yet. */
const FALLBACK_WORKFLOW_MODELS: string[] = [
  "Auto",
  "Composer 2.5 Fast",
  "Opus 4.8 1M Extra High Fast",
  "GPT-5.5 Extra High Fast",
  "Fable 5 1M High",
  "GLM 5.2 High",
];
/** The model the whole pool spawns with — Add agent, Fill, AND keep-N respawns
 *  all use it. Set from the workflow dropdown, persisted, surfaced to the UI so
 *  both tabs stay in sync. Falls back to WORKFLOW_DEFAULT_MODEL. */
let poolModel: string = WORKFLOW_DEFAULT_MODEL;
const WORKFLOW_MODEL_KEY = "jefr.workflowModel";
/** Live picker rows from the last successful CDP refresh (persisted). */
let workflowModels: string[] = [...FALLBACK_WORKFLOW_MODELS];
const WORKFLOW_MODELS_KEY = "jefr.workflowModels";
let workflowModelsRefreshing = false;
/** Skip Auto stand-by phase on spawn (persisted). Off by default. */
let skipAutoPhase = false;
const SKIP_AUTO_KEY = "jefr.skipAutoPhase";
/** Single-agent / shared-queue mode (persisted). On by default — Pass agent_id
 *  is off until the user opts in; shared queue omits agent_id from the MCP prompt.
 *  When false, spawn injects agent_id for per-agent routing. */
let singleAgentMode = true;
const SINGLE_AGENT_KEY = "jefr.singleAgentMode";
const PASS_AGENT_ID_KEY = "jefr.passAgentId";

function passAgentIdEnabled(): boolean {
  return !singleAgentMode;
}

function setPassAgentId(enabled: boolean): void {
  setSingleAgentMode(!enabled);
}

/** Migrate legacy persisted labels (e.g. Opus 4.5) to a live picker row. */
function normalizePoolModel(model: string | undefined): string {
  const m = (model || "").trim();
  if (/^Opus 4\.5/i.test(m)) return WORKFLOW_DEFAULT_MODEL;
  return m || WORKFLOW_DEFAULT_MODEL;
}

function setSkipAutoPhase(enabled: boolean): void {
  if (skipAutoPhase === enabled) return;
  skipAutoPhase = enabled;
  void extensionContext?.globalState.update(SKIP_AUTO_KEY, enabled);
  lastAgentListJson = undefined;
  pushAgentList();
}

function setSingleAgentMode(enabled: boolean): void {
  if (singleAgentMode === enabled) return;
  singleAgentMode = enabled;
  void extensionContext?.globalState.update(SINGLE_AGENT_KEY, enabled);
  void extensionContext?.globalState.update(PASS_AGENT_ID_KEY, !enabled);
  lastAgentListJson = undefined;
  pushAgentList();
}

function pushWorkflowModels(extra?: { error?: string; refreshing?: boolean }): void {
  mainPanel?.webview.postMessage({
    type: "workflowModels",
    models: workflowModels,
    selected: poolModel,
    refreshing: extra?.refreshing ?? workflowModelsRefreshing,
    error: extra?.error,
  });
}

function cleanModelLabel(m: string): string {
  return m
    .replace(/[\u200b\u200c\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function setWorkflowModelsList(models: string[]): void {
  const cleaned = models.map(cleanModelLabel).filter(Boolean);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const m of cleaned) {
    if (seen.has(m)) continue;
    seen.add(m);
    next.push(m);
  }
  if (next.length === 0) return;
  workflowModels = next;
  void extensionContext?.globalState.update(WORKFLOW_MODELS_KEY, next);
}

function setPoolModel(next: string): void {
  const m = normalizePoolModel(next);
  if (m === poolModel) return;
  poolModel = m;
  void extensionContext?.globalState.update(WORKFLOW_MODEL_KEY, m);
  dlog(`pool model set to ${m}`);
  lastAgentListJson = undefined; // force a re-push so both tabs reflect it
  pushAgentList();
  pushWorkflowModels();
}

/** Open Cursor's model picker via CDP and replace the workflow dropdown options. */
function refreshWorkflowModelsFromPicker(): void {
  if (workflowModelsRefreshing) return;
  const py = resolvePython();
  const script = resolveCdpScript();
  if (!py) {
    pushWorkflowModels({
      error: "Python not found on PATH (tried python / py / python3).",
    });
    dlog("refresh models: python not found", "error");
    return;
  }
  if (!script) {
    pushWorkflowModels({
      error: "cdp.py not found — reinstall the extension (package includes automation/) or open the jefr-cursor workspace.",
    });
    dlog("refresh models: cdp.py not found", "error");
    return;
  }

  workflowModelsRefreshing = true;
  pushWorkflowModels({ refreshing: true });
  dlog("refresh models: reading live Cursor picker via CDP…");

  let proc: ChildProcess;
  try {
    proc = spawn(py, [script, "--models", "--tile", "-1"], {
      cwd: path.dirname(script),
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    });
  } catch (e) {
    workflowModelsRefreshing = false;
    const msg = (e as Error).message;
    pushWorkflowModels({ error: `Failed to start CDP: ${msg}` });
    dlog(`refresh models: spawn failed — ${msg}`, "error");
    return;
  }

  let stdout = "";
  let stderr = "";
  proc.stdout?.on("data", (buf: Buffer) => {
    stdout += buf.toString("utf-8");
  });
  proc.stderr?.on("data", (buf: Buffer) => {
    stderr += buf.toString("utf-8");
  });
  proc.on("error", (err) => {
    workflowModelsRefreshing = false;
    pushWorkflowModels({ error: err.message });
    dlog(`refresh models: ${err.message}`, "error");
  });
  proc.on("close", (code) => {
    workflowModelsRefreshing = false;
    const combined = `${stdout}\n${stderr}`;
    // cdp.py prints: RESULT {"tile":…,"models":[…],…} (single-line JSON)
    const resultIdx = combined.lastIndexOf("RESULT");
    const after = resultIdx >= 0 ? combined.slice(resultIdx + "RESULT".length).trim() : "";
    const jsonStart = after.indexOf("{");
    const jsonEnd = after.lastIndexOf("}");
    const rawJson =
      jsonStart >= 0 && jsonEnd > jsonStart
        ? after.slice(jsonStart, jsonEnd + 1)
        : "";
    if (!rawJson) {
      const hint =
        /cannot reach|remote-debugging-port/i.test(combined)
          ? "CDP unreachable — is Cursor on --remote-debugging-port=9222?"
          : /no workbench|no tile|no model picker/i.test(combined)
            ? "No agent tile / model picker found — open an agent chat first."
            : `cdp.py --models failed (exit ${code}).`;
      pushWorkflowModels({ error: hint });
      dlog(`refresh models failed: ${hint}`, "error");
      if (combined.trim()) {
        dlog(`refresh models raw: ${combined.trim().slice(0, 400)}`, "warn");
      }
      return;
    }
    try {
      const parsed = JSON.parse(rawJson) as {
        models?: unknown;
        error?: string;
        current?: string;
      };
      if (parsed.error) {
        pushWorkflowModels({ error: String(parsed.error) });
        dlog(`refresh models: picker error — ${parsed.error}`, "error");
        return;
      }
      const models = Array.isArray(parsed.models)
        ? parsed.models.filter((x): x is string => typeof x === "string" && !!x.trim())
        : [];
      if (models.length === 0) {
        pushWorkflowModels({ error: "Picker returned no models." });
        dlog("refresh models: empty list", "warn");
        return;
      }
      setWorkflowModelsList(models);
      // Keep the current selection if still present; otherwise leave it (UI
      // mergeWorkflowModels will still show it as an extra option).
      dlog(`refresh models: ${models.length} from live picker` +
        (parsed.current ? ` (tile shows ${parsed.current})` : ""));
      pushWorkflowModels();
      postWorkflow({
        type: "workflowOutput",
        stream: "stdout",
        line: `[jefr] refreshed ${models.length} models from Cursor picker`,
      });
    } catch (e) {
      pushWorkflowModels({ error: `Bad CDP JSON: ${(e as Error).message}` });
      dlog(`refresh models: parse error — ${(e as Error).message}`, "error");
    }
  });
}
/** Target number of agents to keep online — the slot count AND the "Keep N
 *  connected" baseline (one knob drives both). Default 5, user-adjustable from
 *  the Agents tab and persisted in globalState. Clamped to a sane range. */
const DEFAULT_TARGET_AGENT_COUNT = 5;
const MIN_TARGET_AGENT_COUNT = 1;
const MAX_TARGET_AGENT_COUNT = 12;
let targetAgentCount = DEFAULT_TARGET_AGENT_COUNT;
/** Set once in activate() so the target can be persisted across sessions. */
let extensionContext: vscode.ExtensionContext | undefined;
const TARGET_AGENT_COUNT_KEY = "jefr.targetAgentCount";

/** Apply a new target (clamped), persist it, and re-push the roster so the UI
 *  (slots + Fill button) updates immediately. Target is separate from keep-N,
 *  which tracks agents already in the pool. */
function setTargetAgentCount(next: number): void {
  const clamped = Math.max(
    MIN_TARGET_AGENT_COUNT,
    Math.min(MAX_TARGET_AGENT_COUNT, Math.floor(next)),
  );
  if (clamped === targetAgentCount) return;
  targetAgentCount = clamped;
  void extensionContext?.globalState.update(TARGET_AGENT_COUNT_KEY, clamped);
  dlog(`target agent count set to ${clamped}`);
  lastAgentListJson = undefined; // force a re-push with the new target
  pushAgentList();
}

// "Fill pool" queue: only one workflow can run at a time, so the one-button
// "add up to 5 agents" feature schedules spawns sequentially. pendingAgentAdds
// is the number of spawn runs still to fire; each completed workflow triggers
// the next one until the roster reaches targetAgentCount.
let pendingAgentAdds = 0;
let pendingAgentModel = WORKFLOW_DEFAULT_MODEL;

/** Queue N agent spawns (clamped so the roster never exceeds the target). */
function queueAgentAdds(count: number, model: string): void {
  pendingAgentModel = (model && model.trim()) || WORKFLOW_DEFAULT_MODEL;
  const current = tileStateManager.toAgentViews().length;
  // Cap the queue so current + in-flight/queued spawns never exceed the target.
  const room = Math.max(0, targetAgentCount - current - pendingAgentAdds);
  const toAdd = Math.max(0, Math.min(count, room));
  if (toAdd <= 0) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: `[jefr] Pool already full or filling (target ${targetAgentCount}).`,
    });
    return;
  }
  pendingAgentAdds += toAdd;
  postWorkflow({
    type: "workflowOutput",
    stream: "stdout",
    line: `[jefr] Filling pool: queued ${toAdd} agent${toAdd !== 1 ? "s" : ""} (target ${targetAgentCount}).`,
  });
  processAgentAddQueue();
}

/** Fire the next queued spawn if nothing is running and we're below target. */
function processAgentAddQueue(): void {
  if (pendingAgentAdds <= 0) {
    return;
  }
  if (workflowProc) {
    // A workflow is mid-flight; the proc close handler will re-enter here.
    return;
  }
  const current = tileStateManager.toAgentViews().length;
  if (current >= targetAgentCount) {
    pendingAgentAdds = 0;
    return;
  }
  pendingAgentAdds--;
  runWorkflow({
    model: pendingAgentModel,
    keepTiles: true,
    skipAuto: skipAutoPhase || singleAgentMode,
    singleAgent: singleAgentMode,
  });
}

// ── Self-healing pool ("Keep N connected") ──────────────────────────────────
// When enabled, N = agents already in the pool (not the Target knob). The pool
// re-primes dropped tiles in place; it does NOT auto-spawn up to Target — use
// Fill / + Add for that. Never-connected idle tiles may still be closed/replaced.
let healingTile = false;
/** Hide (not close) the "Payment failed … Manage Billing" banner. It has no native
 *  dismiss, so we set display:none on it. The tile stays open — only the banner is
 *  removed from view. Poll-driven: re-applied on every status change and on the
 *  self-heal tick (no in-page observer), so a React re-render that brings the banner
 *  back is undone on the next poll. Idempotent and cheap. */
function hideBillingBannersNow(): void {
  if (!cdpEnabled) return;
  void getCdpMonitor()
    .hideBillingBanners()
    .then((n) => {
      if (n > 0) dlog(`hid ${n} payment-failed banner(s)`);
    })
    .catch(() => {});
}

/** Periodic self-heal tick. The CDP monitor only emits a status event when the
 *  tile state CHANGES, so a tile that quietly sits cut off would never re-trigger
 *  maintainPool — meaning the CONFIRM window could never elapse on its own.
 *  This interval re-runs the pool check on a fixed cadence while "Keep N
 *  connected" is on, so a confirmed drop is acted on ~10s after it happened and
 *  any shortfall below the target is topped up even when nothing else changes. */
let poolTickTimer: ReturnType<typeof setInterval> | undefined;
const POOL_TICK_MS = 5_000;

function startPoolTick(): void {
  if (poolTickTimer) return;
  poolTickTimer = setInterval(() => {
    if (!cdpEnabled || !(lastCdpStatus?.connected ?? false)) return;
    // Always-on: re-assert the billing-banner hide on each tick (cheap, idempotent;
    // this poll is what keeps it hidden now that there's no in-page observer).
    if ((lastCdpStatus?.tiles || []).some((t) => t.billingBlocked)) {
      hideBillingBannersNow();
    }
    if (workflowProc || healingTile) return;
    if (!anyKeepConnected() || pendingAgentAdds > 0) return;
    void maintainPool();
  }, POOL_TICK_MS);
}

/** Spawn fresh agents until the roster reaches the target (one at a time). */
function topUpPool(): void {
  if (workflowProc || pendingAgentAdds > 0 || healingTile) return;
  const tiles = tileStateManager.toAgentViews().length;
  if (tiles < targetAgentCount) {
    queueAgentAdds(targetAgentCount - tiles, poolModel);
  }
}

// Periodic backend GC: an agent that's no longer a live tile and whose heartbeat
// has gone stale is dead — delete its on-disk dir (queue/reply/question/heartbeat)
// so closed/cut-off agents don't pile up as ghost queues.
let lastDirGcAt = 0;
const DIR_GC_INTERVAL_MS = 30_000;

function gcDeadAgentDirs(): void {
  const now = Date.now();
  if (now - lastDirGcAt < DIR_GC_INTERVAL_MS) return;
  if (workflowProc || healingTile) return; // don't GC mid-spawn/heal
  lastDirGcAt = now;

  const live = new Set<string>();
  for (const v of tileStateManager.toAgentViews()) live.add(v.id);
  if (selectedAgentId) live.add(selectedAgentId);

  const cdpViews = tileStateManager.toAgentViews();
  const cdpIds =
    cdpEnabled && (lastCdpStatus?.connected ?? false) && cdpViews.length > 0
      ? new Set(cdpViews.map((v) => v.id))
      : null;

  for (const id of listAgentDirIds()) {
    if (live.has(id)) continue;
    // Tile gone from CDP but MCP ticker still refreshes heartbeat — reap now.
    if (cdpIds && !cdpIds.has(id) && getAgentStatusFor(id).alive) {
      tileStateManager.forgetAgent(id);
      agentStats.delete(id);
      forgetAgentDir(id);
      dlog(`reaped ghost agent ${id.slice(0, 8)} (no CDP tile)`);
      continue;
    }
    if (getAgentStatusFor(id).alive) continue; // still heartbeating — keep
    // Dead: no tile, stale heartbeat. Drop roster bookkeeping + the on-disk dir.
    tileStateManager.forgetAgent(id);
    agentStats.delete(id);
    forgetAgentDir(id);
    dlog(`reaped dead agent ${id.slice(0, 8)} (no tile, stale heartbeat)`);
  }
}

/** One self-heal pass: re-prime dropped tiles that opted into per-agent Keep. */
async function maintainPool(): Promise<void> {
  if (!anyKeepConnected() || workflowProc || healingTile || pendingAgentAdds > 0) {
    return;
  }

  // Reap a dead synthetic tile (no resolvable agentId, idle for a while) by
  // index — these can't be reconnected and just clutter the pool.
  const now = Date.now();
  const synth = tileStateManager
    .getAgents()
    .find(
      (a) =>
        a.agentId.startsWith("tile:") &&
        a.tileIndex >= 0 &&
        a.state === "idle" &&
        now - a.firstSeen > 15_000,
    );
  if (synth && cdpEnabled) {
    healingTile = true;
    dlog(`keep-connected: closing dead tile at index ${synth.tileIndex} (no agentId)`, "warn");
    try {
      const closed = await getCdpMonitor()
        .closeTileByIndex(synth.tileIndex)
        .catch(() => false);
      if (closed) tileStateManager.forgetAgent(synth.agentId);
    } finally {
      healingTile = false;
    }
    lastAgentListJson = undefined;
    pushAgentList();
    return;
  }

  // Only heal tiles the user opted to Keep. Confirm window: non-live ≥10s.
  const dropped = tileStateManager
    .getAgentsNeedingHeal(CONFIRM_DROP_MS)
    .filter((a) => keepConnectedAgents.has(a.agentId));
  if (dropped.length === 0) return;

  const victim = dropped[0];
  dlog(
    `keep-connected: re-priming kept agent ${victim.agentId.slice(0, 8)} in place` +
      (victim.queueCount > 0 ? ` (${victim.queueCount} queued)` : ""),
    "warn",
  );
  postWorkflow({
    type: "workflowOutput",
    stream: "stdout",
    line:
      `[jefr] keep: agent ${victim.agentId.slice(0, 8)} dropped` +
      (victim.queueCount > 0 ? ` with ${victim.queueCount} queued` : "") +
      " — re-priming in place",
  });
  tileStateManager.markReconnectAttempt(victim.agentId);
  runWorkflow({
    reconnect: true,
    agentId: victim.agentId,
    model: poolModel,
    singleAgent: singleAgentMode,
  });
}

/** Close every cut-off (dropped) tile on demand — no replacement is spawned.
 *  Backs the "Close dropped" button. Closes by agentId (not index) so the tile
 *  indices shifting between successive closes never target the wrong tile, and
 *  guards with `healingTile` so a concurrent keep-N pass doesn't double-act.
 *  Returns how many tiles were actually closed. */
async function closeDroppedTiles(): Promise<number> {
  if (healingTile) return 0;
  const dropped = tileStateManager.getDroppedAgents();
  if (dropped.length === 0) return 0;
  let closedCount = 0;
  healingTile = true;
  try {
    for (const victim of dropped) {
      const ok = cdpEnabled
        ? await (async () => {
            const fast = await getCdpMonitor().closeAgentTileFast(victim.agentId).catch(() => false);
            if (fast) return true;
            return getCdpMonitor().closeAgentTile(victim.agentId).catch(() => false);
          })()
        : false;
      if (ok) {
        tileStateManager.forgetAgent(victim.agentId);
        agentStats.delete(victim.agentId);
        forgetAgentDir(victim.agentId);
        if (victim.agentId === selectedAgentId) selectAgent(undefined);
        closedCount++;
        dlog(`close-dropped: closed ${victim.agentId.slice(0, 8)}`);
      } else {
        dlog(`close-dropped: failed to close ${victim.agentId.slice(0, 8)}`, "error");
      }
    }
  } finally {
    healingTile = false;
  }
  lastAgentListJson = undefined;
  pushAgentList();
  return closedCount;
}

/** undefined = not probed yet, null = no python found, string = the command. */
let resolvedPython: string | null | undefined;

/** Find a usable Python interpreter once and cache the result. */
function resolvePython(): string | null {
  if (resolvedPython !== undefined) {
    return resolvedPython;
  }
  const candidates =
    process.platform === "win32"
      ? ["python", "py", "python3"]
      : ["python3", "python"];
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ["--version"], {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 5000,
      });
      const out = `${r.stdout || ""}${r.stderr || ""}`;
      if (!r.error && (r.status === 0 || /python/i.test(out))) {
        resolvedPython = cmd;
        return cmd;
      }
    } catch {
      // try next candidate
    }
  }
  resolvedPython = null;
  return null;
}

function postWorkflow(message: Record<string, unknown>): void {
  mainPanel?.webview.postMessage(message);
}

// ── Debug log (General tab) ─────────────────────────────────────────────────
// A small ring buffer of host-side runtime events for troubleshooting. Streamed
// live to the panel and replayable as a snapshot when the General tab opens.
type DebugLevel = "info" | "warn" | "error";
interface DebugEntry {
  ts: number;
  level: DebugLevel;
  line: string;
}
const DEBUG_LOG_MAX = 500;
const debugLogBuf: DebugEntry[] = [];

function dlog(line: string, level: DebugLevel = "info"): void {
  const entry: DebugEntry = { ts: Date.now(), level, line };
  debugLogBuf.push(entry);
  if (debugLogBuf.length > DEBUG_LOG_MAX) debugLogBuf.shift();
  mainPanel?.webview.postMessage({ type: "debugLog", entry });
}

function sendDebugLogSnapshot(): void {
  mainPanel?.webview.postMessage({
    type: "debugLogSnapshot",
    entries: debugLogBuf,
  });
}

interface WorkflowOptions {
  autoPrompt?: string;
  opusPrompt?: string;
  maxSecs?: number;
  enterInterval?: number;
  scriptPath?: string;
  /** Reconnect mode: re-prime a dropped ("worked") tile in place. */
  reconnect?: boolean;
  /** Target tile index for reconnect (omit to auto-detect the dropped tile). */
  tile?: number;
  /** Target agent id for reconnect (the workflow maps it to the right tile). */
  agentId?: string;
  /** Model to select (passed as --model). Spawn and reconnect both use it. */
  model?: string;
  /** Keep existing tiles (don't collapse) so spawns accumulate agents. Spawn
   *  path only; reconnect never collapses. */
  keepTiles?: boolean;
  /** Skip phase 1 (Auto stand-by turn) and select --model immediately.
   *  Spawn only as a flag — reconnect always implies skip-auto in workflow.py. */
  skipAuto?: boolean;
  /** Omit agent_id from the MCP prompt so the agent uses the shared General
   *  queue. Applies to spawn and reconnect. */
  singleAgent?: boolean;
}

/** Spawn the CDP workflow and stream its output back to the webview. */
function runWorkflow(opts: WorkflowOptions): void {
  if (workflowProc) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: "[jefr] A workflow is already running — stop it first.",
    });
    return;
  }

  const py = resolvePython();
  if (!py) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: "[jefr] Python not found on PATH (tried python / py / python3).",
    });
    postWorkflow({ type: "workflowExit", code: null });
    return;
  }

  const script = opts.scriptPath || resolveWorkflowScript();
  if (!script) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line:
        "[jefr] Workflow script not found. Reinstall the extension " +
        "(package includes automation/workflow.py) or open the jefr-cursor workspace.",
      });
      postWorkflow({ type: "workflowExit", code: null });
      return;
    }
  if (!fs.existsSync(script)) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: `[jefr] Workflow script not found: ${script}`,
    });
    postWorkflow({ type: "workflowExit", code: null });
    return;
  }

  const args: string[] = [script];
  const model =
    (opts.model && opts.model.trim()) || poolModel || WORKFLOW_DEFAULT_MODEL;
  if (opts.reconnect) {
    // Always workflow.py --reconnect (implies skip-auto: agent id known).
    args.push("--reconnect", "--model", model);
    if (typeof opts.tile === "number" && Number.isInteger(opts.tile)) {
      args.push("--tile", String(opts.tile));
    }
    if (opts.agentId && opts.agentId.trim()) {
      args.push("--agent-id", opts.agentId.trim());
    }
  } else {
    if (opts.autoPrompt && opts.autoPrompt.trim()) {
      args.push(opts.autoPrompt);
    }
    // Accumulate agents by default: keep already-open tiles instead of collapsing
    // them, so the roster can hold several agents online at once.
    if (opts.keepTiles !== false) {
      args.push("--keep-tiles");
    }
    args.push("--model", model);
    // Single-agent implies skip-auto (workflow.py also forces this).
    if (opts.skipAuto || opts.singleAgent) {
      args.push("--skip-auto");
    }
  }
  if (opts.singleAgent) {
    args.push("--single-agent");
  }
  if (opts.opusPrompt && opts.opusPrompt.trim()) {
    args.push("--type-text", opts.opusPrompt);
  }
  if (typeof opts.maxSecs === "number" && isFinite(opts.maxSecs)) {
    args.push("--max-secs", String(opts.maxSecs));
  }
  if (typeof opts.enterInterval === "number" && isFinite(opts.enterInterval)) {
    args.push("--enter-interval", String(opts.enterInterval));
  }

  postWorkflow({ type: "workflowState", running: true });
  postWorkflow({
    type: "workflowOutput",
    stream: "stdout",
    line: `[jefr] workflow script: ${script}`,
  });
  const shown = args
    .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
    .join(" ");
  postWorkflow({
    type: "workflowOutput",
    stream: "stdout",
    line: `[jefr] $ ${py} ${shown}`,
  });

  let proc: ChildProcess;
  try {
    // Nudge the correct tile to the foreground before the Python workflow's CDP
    // session connects — especially important for keep-N reconnects with several
    // tiled agents, where keyboard focus often sits on the wrong pane.
    if (opts.reconnect && opts.agentId?.trim() && cdpEnabled) {
      void getCdpMonitor().focusAgent(opts.agentId.trim()).catch(() => {});
    }
    proc = spawn(py, args, {
      cwd: path.dirname(script),
      windowsHide: true,
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
    });
  } catch (e) {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: `[jefr] Failed to start: ${(e as Error).message}`,
    });
    postWorkflow({ type: "workflowState", running: false });
    postWorkflow({ type: "workflowExit", code: null });
    return;
  }
  workflowProc = proc;
  dlog(
    opts.reconnect
      ? `workflow: reconnecting agent ${(opts.agentId || "?").slice(0, 8)}`
      : `workflow: spawning a new agent (model ${(opts.model || WORKFLOW_DEFAULT_MODEL)})`,
  );
  // Remember the reconnect target (if any) so the UI can mark that tile as
  // "connecting" while we re-prime it. Fresh spawns have no id yet — snapshot the
  // current roster so resolveSpawnConnectingId() can claim the new tile when it
  // appears, keeping exactly one tile "connecting" for the whole spawn.
  activeWorkflowAgentId = opts.agentId && opts.agentId.trim() ? opts.agentId.trim() : undefined;
  spawnBaselineAgentIds =
    opts.reconnect || activeWorkflowAgentId ? undefined : new Set(lastPushedAgentIds);
  // Start the "time to connect" clock; re-measure on reconnect of a known agent.
  workflowStartedAt = Date.now();
  if (activeWorkflowAgentId) agentConnectMs.delete(activeWorkflowAgentId);
  lastAgentListJson = undefined;
  pushAgentList();

  const pump = (buf: Buffer, stream: "stdout" | "stderr") => {
    const text = buf.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) {
        maybeRecordWorkflowConnect(line);
        postWorkflow({ type: "workflowOutput", stream, line });
      }
    }
  };
  proc.stdout?.on("data", (d: Buffer) => pump(d, "stdout"));
  proc.stderr?.on("data", (d: Buffer) => pump(d, "stderr"));
  proc.on("error", (e: Error) => {
    postWorkflow({
      type: "workflowOutput",
      stream: "stderr",
      line: `[jefr] Process error: ${e.message}`,
    });
  });
  proc.on("close", (code: number | null) => {
    dlog(`workflow exited with code ${code}`, code === 0 ? "info" : "warn");
    postWorkflow({
      type: "workflowOutput",
      stream: "stdout",
      line: `[jefr] workflow exited with code ${code}`,
    });
    postWorkflow({ type: "workflowState", running: false });
    postWorkflow({ type: "workflowExit", code });
    if (workflowProc === proc) {
      workflowProc = undefined;
    }
    activeWorkflowAgentId = undefined;
    spawnBaselineAgentIds = undefined;
    // Single-agent mode listens on the shared root queue — point the panel at
    // General so sends land where check_messages (no agent_id) is waiting.
    if (code === 0 && singleAgentMode && !opts.reconnect) {
      selectAgent(undefined);
    }
    lastAgentListJson = undefined;
    pushAgentList();
    // A fresh spawn nests a new pane via Ctrl+D, which leaves the tiling tree
    // lopsided (50/25/12.5/…). Re-balance so every tile ends up equal width.
    // Skipped for reconnects (no new tile) and only when no further spawn is
    // queued, so we don't equalize a layout that's about to change again.
    if (cdpEnabled && !opts.reconnect && pendingAgentAdds <= 0) {
      setTimeout(() => {
        void getCdpMonitor().equalizeTiles().catch(() => false);
      }, 600);
    }
    // Chain the next queued "fill pool" spawn, if any.
    processAgentAddQueue();
  });
}

/** Terminate a running workflow (and its child CDP process tree on Windows). */
function stopWorkflow(): void {
  // An explicit stop cancels any queued "fill pool" spawns.
  pendingAgentAdds = 0;
  const proc = workflowProc;
  if (!proc) {
    postWorkflow({ type: "workflowState", running: false });
    return;
  }
  workflowProc = undefined;
  postWorkflow({ type: "workflowState", running: false });
  try {
    if (process.platform === "win32" && proc.pid) {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/t", "/f"], {
        windowsHide: true,
      });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    // best-effort
  }
}

// Idle keep-alive: after this long with no activity, broadcast a STAND BY nudge
// to every online + idle + queue-empty agent (never the shared/General queue).
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

const STANDBY_MESSAGE =
  "Hello. IMPORTANT: STAND BY. Take NO action of any kind right now — do not run any tools, edit files, or make any changes. Just hold, keep the connection open, and wait for my next instruction.";

function resetIdleTimer(): void {
  lastActivityTime = Date.now();
}

function startIdleTimer(): void {
  // Disabled: do not auto-send STAND BY nudges after idle timeout.
  // (Re-enable the interval below to restore keep-alive nudges.)
  /*
  if (idleTimer) {
    clearInterval(idleTimer);
  }
  idleTimer = setInterval(() => {
    if (!isCardValid()) {
      return;
    }
    // Only after a real idle stretch with no activity anywhere.
    if (Date.now() - lastActivityTime < IDLE_TIMEOUT_MS) {
      return;
    }
    // Nudge EVERY agent that's online and idle — not just the focused one — so the
    // whole pool holds steady. NEVER the shared/General queue (we only target real
    // agent ids), and skip any agent that's busy or already has queued work.
    const targets = tileStateManager.getAgents().filter(
      (a) =>
        !a.agentId.startsWith("tile:") &&
        a.tileIndex >= 0 &&
        a.connectCount > 0 &&
        // Online + idle = parked in the MCP loop (not generating/planning/working).
        (a.state === "mcp_connected" || a.state === "waiting") &&
        a.queueCount === 0,
    );
    if (targets.length === 0) {
      return;
    }
    dlog(
      `idle ${IDLE_TIMEOUT_MS / 60000}m: stand-by nudge → ${targets.length} agent(s): ${targets
        .map((a) => a.agentId.slice(0, 8))
        .join(", ")}`,
    );
    for (const a of targets) {
      const item = sendTextTo(a.agentId, STANDBY_MESSAGE);
      // Mirror the auto-send into THIS agent's chat thread. sendTextTo only
      // queues + writes the agent-less shared history, so without this the nudge
      // never shows in the per-agent conversation. Target the real agentId (not
      // the selected one) so it lands in the right bucket even when unfocused.
      mainPanel?.webview.postMessage({
        type: "historyAppend",
        agentId: a.agentId,
        item: {
          id: item.id,
          kind: "text",
          text: STANDBY_MESSAGE,
          time: new Date(item.timestamp || Date.now()).toLocaleTimeString(),
        },
      });
    }
    resetIdleTimer();
  }, 60000);
  */
}

function computeDataDir(workspaceFolders: readonly vscode.WorkspaceFolder[]): string {
  const rootDir = path.join(os.homedir(), ".moyu-message");
  if (workspaceFolders.length === 0) {
    return rootDir;
  }
  const primary = workspaceFolders[0].uri.fsPath;
  const hash = crypto.createHash("md5").update(primary).digest("hex").slice(0, 12);
  return path.join(rootDir, hash);
}

/** Prefer MESSENGER_DATA_DIR from jefr MCP config so the panel, Obsidian bridge,
 *  and MCP server process always share one folder (avoids split-brain routing). */
function readMcpDataDir(
  workspaceFolders: readonly vscode.WorkspaceFolder[] = [],
): string | undefined {
  const candidates = [
    path.join(os.homedir(), ".cursor", "mcp.json"),
    ...workspaceFolders.map((f) => path.join(f.uri.fsPath, ".cursor", "mcp.json")),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) {
        continue;
      }
      const config = JSON.parse(fs.readFileSync(p, "utf-8"));
      const dir = config?.mcpServers?.jefr?.env?.MESSENGER_DATA_DIR;
      if (typeof dir === "string" && dir.trim()) {
        return dir.trim();
      }
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  extensionVersion = context.extension.packageJSON?.version || "0.0.0";
  extensionContext = context;
  syncTranscriptWorkspaceRoots();
  // Say once whether the strongest liveness signal is usable on this host, so a
  // silent fallback to the old heartbeat-only behaviour is visible in the log
  // rather than being mistaken for the fix not working.
  dlog(
    isComposerStateAvailable()
      ? "liveness: reading Cursor composer state (node:sqlite OK)"
      : "liveness: Cursor composer state unavailable — falling back to heartbeat/CDP only",
    isComposerStateAvailable() ? "info" : "warn",
  );
  // Restore the persisted pool target (slot count + keep-N baseline).
  targetAgentCount = Math.max(
    MIN_TARGET_AGENT_COUNT,
    Math.min(
      MAX_TARGET_AGENT_COUNT,
      Math.floor(
        context.globalState.get<number>(
          TARGET_AGENT_COUNT_KEY,
          DEFAULT_TARGET_AGENT_COUNT,
        ),
      ),
    ),
  );
  // Restore the persisted pool spawn model (used by Add / Fill / keep-N).
  poolModel = normalizePoolModel(
    context.globalState.get<string>(WORKFLOW_MODEL_KEY, WORKFLOW_DEFAULT_MODEL),
  );
  if (poolModel !== context.globalState.get<string>(WORKFLOW_MODEL_KEY)) {
    void context.globalState.update(WORKFLOW_MODEL_KEY, poolModel);
  }
  skipAutoPhase = context.globalState.get<boolean>(SKIP_AUTO_KEY, false) === true;
  // Prefer jefr.passAgentId when present. Else migrate from jefr.singleAgentMode.
  // Neither key → Pass agent_id OFF (shared queue / singleAgentMode true).
  {
    const storedPass = context.globalState.get<boolean | undefined>(PASS_AGENT_ID_KEY);
    if (typeof storedPass === "boolean") {
      singleAgentMode = !storedPass;
    } else {
      const storedSingle = context.globalState.get<boolean | undefined>(SINGLE_AGENT_KEY);
      singleAgentMode = typeof storedSingle === "boolean" ? storedSingle === true : true;
    }
  }
  {
    const saved = context.globalState.get<string[]>(KEEP_CONNECTED_KEY);
    keepConnectedAgents.clear();
    if (Array.isArray(saved)) {
      for (const id of saved) {
        if (typeof id === "string" && id.trim()) keepConnectedAgents.add(id.trim());
      }
    }
  }
  // Restore last live picker snapshot (from Refresh Models); fall back to static.
  {
    const saved = context.globalState.get<string[]>(WORKFLOW_MODELS_KEY);
    if (Array.isArray(saved) && saved.length > 0) {
      workflowModels = saved
        .filter((m): m is string => typeof m === "string" && !!m.trim())
        .map((m) => m.trim());
    }
    if (workflowModels.length === 0) {
      workflowModels = [...FALLBACK_WORKFLOW_MODELS];
    }
  }
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  currentDataDir = readMcpDataDir(workspaceFolders) ?? computeDataDir(workspaceFolders);
  setDataDir(currentDataDir);
  migrateFromRootDir();

  setHistorySink((item) => {
    // Map the messenger's queue-shaped item into the webview's HistoryItem
    // shape so externally-originated sends (e.g. from the Obsidian plugin or
    // the remote console) render as proper chat bubbles in the panel.
    mainPanel?.webview.postMessage({
      type: "historyAppend",
      item: {
        id: item.id,
        kind: item.type,
        text: item.content,
        caption: item.caption,
        path: item.path,
        name: item.name || (item.path ? path.basename(item.path) : undefined),
        dataUrl: item.dataUrl,
        images: item.images,
        time: new Date(item.timestamp || Date.now()).toLocaleTimeString(),
      },
    });
  });

  const provider = new MessengerViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("mcpMessenger.mainView", provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mcpMessenger.setupMcp", () => {
      const workspaceFolders2 = vscode.workspace.workspaceFolders;
      if (!workspaceFolders2?.length) {
        vscode.window.showErrorMessage("Please open a workspace first");
        return;
      }
      const changedCount = setupMcpForFolders(workspaceFolders2);
      if (changedCount >= 0) {
        vscode.window.showInformationMessage(
          changedCount > 0
            ? `MCP config installed to ${changedCount} workspace(s). Restart Cursor to apply.`
            : "MCP config already exists; no need to install again"
        );
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mcpMessenger.removeMcp", () => {
      const workspaceFolders2 = vscode.workspace.workspaceFolders;
      if (!workspaceFolders2?.length) {
        return;
      }
      let removedCount = 0;
      for (const folder of workspaceFolders2) {
        if (removeMcpConfig(folder.uri.fsPath)) {
          removedCount++;
        }
      }
      vscode.window.showInformationMessage(
        removedCount > 0
          ? `MCP config removed from ${removedCount} workspace(s)`
          : "No MCP config found to remove"
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("mcpMessenger.sendFile", (uri?: vscode.Uri) => {
      if (uri) {
        sendFile(uri.fsPath);
        vscode.window.showInformationMessage("File added to message queue");
      }
    })
  );

  startPolling();
  startRemotePolling();
  startHeartbeat();
  // Idle keep-alive disabled — do not auto-send STAND BY after idle timeout.
  // startIdleTimer();
  autoSetupMcp();
  startCdpMonitoring(); // CDP-based tile state monitoring
  startPoolTick(); // periodic self-heal re-check (drives the 10s drop-confirm)
  setWorkspaceInfo(getWorkspaceName(), getWorkspacePath() || "");
  // Let a remote client (Obsidian) pick the routed agent via the same flow the
  // panel uses, so the selection + webview stay consistent everywhere.
  setSelectAgentHandler((id) => selectAgent(id));

  startLocalServer()
    .then((port) => {
      console.log(`jefr console started: http://127.0.0.1:${port}`);
      const restored = readSelectedAgentId();
      if (restored) {
        selectAgent(restored);
      }
    })
    .catch((e) => {
      console.error("Failed to start console server:", e);
    });

  context.subscriptions.push(
    vscode.commands.registerCommand("mcpMessenger.openConsole", () => {
      const port = getServerPort();
      if (!port) {
        vscode.window.showWarningMessage("Console server is not running yet");
        return;
      }
      const url = `http://127.0.0.1:${port}`;
      vscode.env.openExternal(vscode.Uri.parse(url));
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      syncTranscriptWorkspaceRoots();
      if (event.added.length > 0) {
        autoSetupMcp(event.added);
      }
    })
  );

  context.subscriptions.push({
    dispose: () => {
      if (pollTimer2) {
        clearInterval(pollTimer2);
      }
    },
  });
}

export function deactivate(): void {
  if (pollTimer2) {
    clearInterval(pollTimer2);
  }
  if (remotePollTimer) {
    clearInterval(remotePollTimer);
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  if (idleTimer) {
    clearInterval(idleTimer);
  }
  if (poolTickTimer) {
    clearInterval(poolTickTimer);
    poolTickTimer = undefined;
  }
  stopWorkflow();
  stopLocalServer();
  stopCdpMonitor(); // Stop CDP monitoring
  stopTranscriptWatchers();
}

// ── Local polling: mirror file state into the webview ───────────────────────

function startPolling(): void {
  const poll = () => {
    if (!mainPanel) {
      return;
    }

    // Broadcast the live-agent list so the panel's picker stays current.
    pushAgentList();

    const question = readQuestionFor(selectedAgentId);
    if (question) {
      if (question.id !== lastQuestionId) {
        mainPanel.webview.postMessage({ type: "showQuestion", data: question });
        lastQuestionId = question.id;
        pushQuestionToRemoteNow(question);
      }
    } else if (lastQuestionId) {
      mainPanel.webview.postMessage({ type: "clearQuestion" });
      lastQuestionId = undefined;
    }

    const reply = readReplyFor(selectedAgentId);
    if (reply && reply.timestamp !== lastReplyTimestamp) {
      mainPanel.webview.postMessage({ type: "showReply", data: reply });
      lastReplyTimestamp = reply.timestamp;
    } else if (!reply) {
      lastReplyTimestamp = undefined;
    }

    const cardValid = isCardValid();
    if (cardValid !== lastCardValid) {
      mainPanel.webview.postMessage({ type: "cardState", data: { active: true } });
      lastCardValid = cardValid;
    }

    const count = getQueueCountFor(selectedAgentId);
    if (count !== lastQueueCount) {
      mainPanel.webview.postMessage({ type: "queueCount", count });
      mainPanel.webview.postMessage({ type: "queueData", data: readQueueFor(selectedAgentId) });
      lastQueueCount = count;
    }
    // Refresh the all-queues view too (any agent's queue may have changed).
    pushAllQueues();
  };
  poll();
  pollTimer2 = setInterval(poll, 500);
}

/** Scan file heartbeats, reconcile stats, auto-reconnect, and push the roster.
 *  When `cdpFallback` is true, CDP is connected but saw no tiles — annotate payload. */
function pushAgentListFromHeartbeats(cdpFallback = false): void {
  if (!mainPanel) {
    return;
  }

  const now = Date.now();
  const roster = scanAllAgents();
  const { views: agents, dropped, prune } = reconcile(roster, agentStats, now, {
    forgetMs: AGENT_FORGET_MS,
    maxReconnects: MAX_RECONNECT_ATTEMPTS,
    // This is the path used when CDP can't see any tiles (Agents window closed),
    // so it has no DOM signal at all — heartbeat only. Cursor's own conversation
    // record is what keeps a quietly-working agent from being called dropped and
    // having its tile re-primed mid-task.
    externalAliveAt: composerAliveAt,
    externalAliveGraceMs: COMPOSER_ALIVE_GRACE_MS,
  });

  for (const id of prune) {
    agentStats.delete(id);
    if (id === selectedAgentId) {
      selectedAgentId = undefined;
      writeSelectedAgentId(undefined);
      setSelectedAgentId(undefined);
      mainPanel.webview.postMessage({ type: "agentSelected", agentId: null });
    }
    if (GC_AGENT_DIRS) {
      forgetAgentDir(id);
    }
  }

  if (anyKeepConnected() && !workflowProc) {
    const keptDropped = dropped.filter((id) => keepConnectedAgents.has(id));
    const target = pickReconnect(keptDropped, agentStats, now, RECONNECT_DEBOUNCE_MS);
    if (target) {
      const s = agentStats.get(target);
      if (s) {
        s.reconnectCount++;
        s.reconnectsSinceConnect++;
        s.lastReconnectAt = now;
      }
      postWorkflow({
        type: "workflowOutput",
        stream: "stdout",
        line: `[jefr] keep: agent ${target.slice(0, 8)} dropped — re-priming its tile`,
      });
      runWorkflow({
        reconnect: true,
        agentId: target,
        model: poolModel,
        singleAgent: singleAgentMode,
      });
    }
  }

  const droppedSet = new Set(dropped);
  const agentsWithDropped = agents.map((a) => ({
    ...a,
    dropped: !a.connected && droppedSet.has(a.id),
    keepConnected: keepConnectedAgents.has(a.id),
    activity: liveActivityFor(a.id),
  }));

  writeCdpStatusFile(agents);

  resolveSpawnConnectingId(agentsWithDropped);
  recordConnectTime(agentsWithDropped);
  lastPushedAgentIds = new Set(agentsWithDropped.map((a) => a.id));

  const payload = {
    agents: agentsWithDropped.map((a) => ({
      ...a,
      connectMs: agentConnectMs.get(a.id),
    })),
    selected: selectedAgentId || null,
    targetAgentCount,
    workflowModel: poolModel,
    skipAutoPhase,
    passAgentId: passAgentIdEnabled(),
    singleAgentMode,
    cdpConnected: cdpFallback ? (lastCdpStatus?.connected ?? false) : false,
    connectingAgentId: workflowProc ? activeWorkflowAgentId ?? null : null,
    connectingSince: workflowProc ? workflowStartedAt : 0,
  };
  setSelectedAgentId(selectedAgentId);
  const json = JSON.stringify(payload);
  if (json !== lastAgentListJson) {
    lastAgentListJson = json;
    mainPanel.webview.postMessage({ type: "agentList", ...payload });
  }
}

/** Scan the agent roster, update connect/reconnect stats, drive auto-reconnect,
 *  and push the merged list to the panel (deduped on stable fields).
 *
 *  When CDP is connected, this delegates to pushAgentListFromCdp().
 *  Falls back to file-based heartbeats when CDP is unavailable. */
function pushAgentList(): void {
  if (!mainPanel) {
    return;
  }

  // Use CDP-based state when it can actually see tiles.
  if (cdpEnabled && lastCdpStatus?.connected && tileStateManager.toAgentViews().length > 0) {
    pushAgentListFromCdp();
    return;
  }

  pushAgentListFromHeartbeats(cdpEnabled && (lastCdpStatus?.connected ?? false));
}

/** Switch the panel's target agent and immediately re-push that agent's state. */
function selectAgent(agentId?: string): void {
  selectedAgentId = agentId && agentId.trim() ? agentId.trim() : undefined;
  writeSelectedAgentId(selectedAgentId);
  setSelectedAgentId(selectedAgentId);
  // Force the next poll to re-emit question/reply/queue for the new target.
  lastQuestionId = undefined;
  lastReplyTimestamp = undefined;
  lastQueueCount = undefined;
  lastAgentListJson = undefined;
  mainPanel?.webview.postMessage({
    type: "agentSelected",
    agentId: selectedAgentId || null,
  });
  // NOTE: selection is routing-only. MCP delivery is keyed by each agent's own
  // agent_id (and the panel routes user messages to selectedAgentId), so it does
  // NOT depend on which Cursor tile has focus. We deliberately do NOT focus the
  // tile here — stealing focus on a plain card click yanks the cursor away from
  // whatever the user is doing and interrupts an in-flight spawn / workflow.
  // Explicit focus is still available on demand via the "focusAgent" message.
  // Push the freshly-selected agent's current state right away.
  const reply = readReplyFor(selectedAgentId);
  if (reply) {
    mainPanel?.webview.postMessage({ type: "showReply", data: reply });
    lastReplyTimestamp = reply.timestamp;
  }
  const question = readQuestionFor(selectedAgentId);
  mainPanel?.webview.postMessage(
    question ? { type: "showQuestion", data: question } : { type: "clearQuestion" }
  );
  lastQuestionId = question?.id;
  mainPanel?.webview.postMessage({ type: "queueData", data: readQueueFor(selectedAgentId) });
  mainPanel?.webview.postMessage({ type: "queueCount", count: getQueueCountFor(selectedAgentId) });
  // Routing target changed — force the Queue tab's all-queues view to re-render.
  lastAllQueuesJson = undefined;
  pushAllQueues();
  pushAgentList();
}

/** One agent's pending queue, as shown in the Queue tab's all-queues view. */
interface QueueGroupPayload {
  /** Agent id ("" for the shared root queue). */
  agentId: string;
  /** Short display label for the agent (or "General · shared"). */
  label: string;
  items: ReturnType<typeof readQueueFor>;
  /** True when the agent's heartbeat is fresh. */
  connected: boolean;
  /** True for the agent the MCP currently delivers queued messages to. */
  routing: boolean;
}

/** Resolve which queue a mutation (delete/clear/update) targets. The Queue tab
 *  now edits any agent's queue, so it passes the owning agentId ("" for the
 *  shared root). When absent (legacy callers), fall back to the routing target. */
function queueTarget(agentId?: string): string | undefined {
  return agentId === undefined ? selectedAgentId : agentId;
}

/** Gather every agent's queue — connected or not — plus the shared root queue,
 *  flagging the one the panel currently routes to. Powers the Queue tab's view
 *  of all queues at once. */
function buildQueueGroups(): QueueGroupPayload[] {
  const groups: QueueGroupPayload[] = [];
  const selected = selectedAgentId;

  // Shared root ("General · shared"): always show when it's the routing target,
  // otherwise only when it actually holds queued items.
  const rootItems = readQueueFor(undefined);
  if (rootItems.length > 0 || !selected) {
    groups.push({
      agentId: "",
      label: "General · shared",
      items: rootItems,
      connected: false,
      routing: !selected,
    });
  }

  let sawSelected = false;
  for (const a of scanAllAgents()) {
    if (a.id === selected) sawSelected = true;
    groups.push({
      agentId: a.id,
      label: a.id.slice(0, 8),
      items: readQueueFor(a.id),
      connected: a.connected,
      routing: selected === a.id,
    });
  }

  // The routing target should always appear, even if its dir hasn't been scanned
  // yet (e.g. freshly selected agent with no files on disk).
  if (selected && !sawSelected) {
    groups.push({
      agentId: selected,
      label: selected.slice(0, 8),
      items: readQueueFor(selected),
      connected: false,
      routing: true,
    });
  }

  return groups;
}

/** Push the all-queues snapshot to the panel, deduped so it only sends on change. */
function pushAllQueues(): void {
  if (!mainPanel) {
    return;
  }
  const data = buildQueueGroups();
  const json = JSON.stringify(data);
  if (json === lastAllQueuesJson) {
    return;
  }
  lastAllQueuesJson = json;
  mainPanel.webview.postMessage({ type: "allQueues", data });
}

function getWorkspaceName(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].name;
  }
  return "default";
}

/** Prefer the open workspace(s) when resolving Cursor agent transcripts. */
function syncTranscriptWorkspaceRoots(): void {
  const roots = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  setTranscriptWorkspaceRoots(roots);
  clearTranscriptCache();
}

function getWorkspacePath(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return undefined;
}

// ── Remote sync (disabled in this build) ────────────────────────────────────

function pushQuestionToRemoteNow(question: QuestionPayload): void {
  if (!REMOTE_API_ENABLED) {
    return;
  }
  const card = readCardState();
  if (!card || !isCardValid()) {
    return;
  }
  const wsName = getWorkspaceName();
  if (question.id === lastRemoteQuestionId) {
    return;
  }
  lastRemoteQuestionId = question.id;
  pushRemoteQuestion(card.code, question.id, question.questions, wsName).catch(() => {
    // ignore
  });
}

function startRemotePolling(): void {
  // Remote sync is disabled in this build.
  return;

  // eslint-disable-next-line no-unreachable
  if (remotePollTimer) {
    return;
  }
  const wsName = getWorkspaceName();
  const remotePoll = async () => {
    const card = readCardState();
    if (!card || !isCardValid()) {
      return;
    }
    try {
      const messages = await pollRemoteMessages(card.code, wsName);
      for (const msg of messages) {
        sendText(msg.content as string);
        resetIdleTimer();
        if (!chatTriggered) {
          triggerCursorChat();
        }
      }
    } catch {
      // ignore
    }
    const reply = readReply();
    if (reply && reply.content) {
      const replyKey = (reply.timestamp || "") + reply.content.slice(0, 50);
      if (replyKey !== lastReplyContent) {
        lastReplyContent = replyKey;
        resetIdleTimer();
        try {
          await pushRemoteReply(card.code, reply.content, wsName);
        } catch {
          // ignore
        }
      }
    } else {
      lastReplyContent = undefined;
    }
    const question = readQuestion();
    if (question && question.id !== lastRemoteQuestionId) {
      lastRemoteQuestionId = question.id;
      try {
        await pushRemoteQuestion(card.code, question.id, question.questions, wsName);
      } catch {
        // ignore
      }
    } else if (!question && lastRemoteQuestionId) {
      try {
        await cancelRemoteQuestion(card.code, lastRemoteQuestionId);
      } catch {
        // ignore
      }
      lastRemoteQuestionId = undefined;
    }
    if (question && lastRemoteQuestionId) {
      try {
        const result = await pollRemoteAnswer(card.code, lastRemoteQuestionId);
        if (result?.answered && result.answer) {
          writeAnswer(result.answer);
        }
      } catch {
        // ignore
      }
    }
  };
  remotePollTimer = setInterval(remotePoll, 3000);
}

function startHeartbeat(): void {
  // Heartbeat is disabled in this build.
  return;

  // eslint-disable-next-line no-unreachable
  if (heartbeatTimer) {
    return;
  }
  const beat = async () => {
    const card = readCardState();
    if (!card || !isCardValid()) {
      return;
    }
    await sendWorkspaceHeartbeat(card.code, getWorkspaceName(), getWorkspacePath());
  };
  beat();
  heartbeatTimer = setInterval(beat, 15000);
}

// ── MCP auto-install ────────────────────────────────────────────────────────

function autoSetupMcp(
  workspaceFolders: readonly vscode.WorkspaceFolder[] = vscode.workspace.workspaceFolders || []
): void {
  const globalChanged = setupGlobalMcpConfig(currentDataDir);
  if (workspaceFolders.length === 0) {
    if (globalChanged) {
      vscode.window.showInformationMessage(
        "jefr MCP installed to global config. Restart Cursor to apply."
      );
    }
    return;
  }
  const changedCount = setupMcpForFolders(workspaceFolders);
  if (changedCount > 0 || globalChanged) {
    vscode.window.showInformationMessage(
      `jefr auto-installed config to ${changedCount} workspace(s). Restart Cursor to apply.`
    );
  }
}

async function triggerCursorChat(): Promise<void> {
  // Disabled for now: do not auto-open/focus the Cursor chat.
  return;
  // if (chatTriggered) return;
  // chatTriggered = true;
  // try {
  //   await vscode.commands.executeCommand("workbench.action.chat.newChat");
  //   await new Promise((r) => setTimeout(r, 500));
  //   await vscode.commands.executeCommand("workbench.action.chat.open", {
  //     query: "Hello, please handle my message",
  //   });
  // } catch {
  //   try {
  //     await vscode.commands.executeCommand("workbench.action.chat.open");
  //   } catch {}
  // }
}

function setupMcpForFolders(workspaceFolders: readonly vscode.WorkspaceFolder[]): number {
  let changedCount = 0;
  for (const folder of workspaceFolders) {
    try {
      if (setupMcpConfig(folder.uri.fsPath, currentDataDir)) {
        changedCount++;
      }
    } catch (e) {
      vscode.window.showErrorMessage(
        `Failed to install MCP config: ${folder.name} - ${(e as Error).message}`
      );
    }
  }
  return changedCount;
}

// ── Webview provider ────────────────────────────────────────────────────────

class MessengerViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    mainPanel = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          this.pushCurrentState();
          this.pushCardState();
          mainPanel?.webview.postMessage({ type: "version", version: extensionVersion });
          mainPanel?.webview.postMessage({
            type: "injectedTokenState",
            injected: !!readInjectedToken(),
          });
          this.pushQueueData();
          lastAgentListJson = undefined; // force a fresh roster on open
          pushAgentList();
          pushWorkflowModels();
          // The panel can open BEFORE CDP's first successful poll (or a poll that
          // transiently saw 0 tiles), which would leave the roster on the file-
          // heartbeat fallback (only currently-looping agents). Since CDP only
          // re-pushes on a tile-state CHANGE, the full roster otherwise wouldn't
          // appear until the next spawn/"keep N connected". Kick a fresh poll and
          // re-push so every already-open tile shows up immediately.
          if (cdpEnabled) {
            getCdpMonitor()
              .pollNow()
              .then(() => {
                lastAgentListJson = undefined;
                pushAgentList();
              })
              .catch(() => {});
          }
          break;
        case "refreshAgents": {
          // Manual hard refresh. A plain poll is usually a no-op because the
          // 500ms loop already keeps the roster current — and it can't recover a
          // drifted/stale CDP session. So we tear the session down and reconnect
          // from scratch (forceReconnect), clearing both dedupe caches (the
          // monitor's lastStatus and our lastAgentListJson) so the roster is
          // rebuilt and re-pushed even when the result is byte-identical.
          lastAgentListJson = undefined;
          // Tell the panel the refresh finished so it can clear its spinner even
          // when the agent list itself didn't change.
          const ackRefresh = () => {
            lastAgentListJson = undefined;
            pushAgentList();
            mainPanel?.webview.postMessage({ type: "agentsRefreshed" });
          };
          if (cdpEnabled) {
            getCdpMonitor().forceReconnect().then(ackRefresh, ackRefresh);
          } else {
            ackRefresh();
          }
          break;
        }
        case "closeDropped": {
          const n = await closeDroppedTiles();
          postWorkflow({
            type: "workflowOutput",
            stream: "stdout",
            line:
              n > 0
                ? `[jefr] closed ${n} dropped tile${n !== 1 ? "s" : ""}`
                : "[jefr] no dropped tiles to close",
          });
          break;
        }
        case "selectAgent":
          selectAgent(msg.agentId);
          break;
        case "setAgentKeepConnected":
          if (typeof msg.agentId === "string" && msg.agentId.trim()) {
            setAgentKeepConnected(msg.agentId.trim(), !!msg.enabled);
          }
          break;
        case "setTargetAgentCount":
          if (typeof msg.count === "number" && Number.isFinite(msg.count)) {
            setTargetAgentCount(msg.count);
          }
          break;
        case "setWorkflowModel":
          if (typeof msg.model === "string") {
            setPoolModel(msg.model);
          }
          break;
        case "setSkipAutoPhase":
          setSkipAutoPhase(!!msg.enabled);
          break;
        case "setPassAgentId":
          setPassAgentId(!!msg.enabled);
          break;
        case "setSingleAgentMode":
          setSingleAgentMode(!!msg.enabled);
          break;
        case "getWorkflowModels":
          pushWorkflowModels();
          break;
        case "refreshWorkflowModels":
          refreshWorkflowModelsFromPicker();
          break;
        case "equalizeTiles": {
          if (cdpEnabled) {
            const ok = await getCdpMonitor().equalizeTiles().catch(() => false);
            postWorkflow({
              type: "workflowOutput",
              stream: ok ? "stdout" : "stderr",
              line: ok
                ? "[jefr] equalized tile sizes"
                : "[jefr] could not equalize tiles (no tiling layout?)",
            });
          }
          break;
        }
        case "reconnectAgent": {
          const aid = typeof msg.agentId === "string" ? msg.agentId : undefined;
          if (aid) {
            // Unify bookkeeping: update whichever store is the active source.
            // The CDP store (tile-state) drives debounce/streak + the displayed
            // counts when CDP is connected; the heartbeat store backs the
            // file-based fallback. Marking both keeps them consistent and stops a
            // manual reconnect from being ignored or double-fired.
            tileStateManager.markReconnectAttempt(aid); // no-op if unknown there
            const s = agentStats.get(aid);
            if (s) {
              s.reconnectCount++;
              s.reconnectsSinceConnect++;
              s.lastReconnectAt = Date.now();
            }
            runWorkflow({
              reconnect: true,
              agentId: aid,
              model: poolModel,
              singleAgent: singleAgentMode,
            });
          }
          break;
        }
        case "addAgent": {
          // Manual add has NO cap — the user can grow the pool to as many agents
          // as they want. targetAgentCount is only the auto-fill / keep-N
          // baseline, not a hard ceiling on manual spawns. Model defaults to the
          // pool's selected model (the workflow dropdown).
          runWorkflow({
            model: (typeof msg.model === "string" && msg.model.trim()) || poolModel,
            keepTiles: true,
            skipAuto: skipAutoPhase || singleAgentMode,
            singleAgent: singleAgentMode,
          });
          break;
        }
        case "addAgents": {
          const model =
            (typeof msg.model === "string" && msg.model.trim()) || poolModel;
          // Default: fill the pool to the target. An explicit count caps it.
          const count =
            typeof msg.count === "number" && Number.isFinite(msg.count) && msg.count > 0
              ? Math.floor(msg.count)
              : targetAgentCount;
          queueAgentAdds(count, model);
          break;
        }
        case "deleteAgent": {
          const aid = typeof msg.agentId === "string" ? msg.agentId.trim() : "";
          if (!aid) break;
          const notifyDelete = (
            status: "closing" | "closed" | "failed",
            error?: string,
          ) => {
            mainPanel?.webview.postMessage({
              type: "agentDeleteStatus",
              agentId: aid,
              status,
              ...(error ? { error } : {}),
            });
          };
          notifyDelete("closing");
          // Closing the tile a workflow is actively spawning/re-priming has to
          // stop that workflow too — otherwise the script keeps driving a tile
          // that's about to vanish and the spawn appears to "not stop".
          if (isConnectingTarget(aid)) {
            dlog(`delete: ${aid.slice(0, 8)} is the connecting tile — stopping its workflow first`, "warn");
            postWorkflow({
              type: "workflowOutput",
              stream: "stdout",
              line: `[jefr] closing the connecting tile ${aid.slice(0, 8)} — stopping its spawn workflow`,
            });
            stopWorkflow();
          }
          const tracked = tileStateManager.getAgent(aid);
          const tileIdx = tracked?.tileIndex ?? -1;
          const wasVisible = tileIdx >= 0;
          let closed = true;
          if (cdpEnabled && wasVisible) {
            if (aid.startsWith("tile:")) {
              // Synthetic ids (no fiber agentId) can't be matched by agentId —
              // close them by their tile index instead.
              closed = await getCdpMonitor()
                .closeTileByIndex(tileIdx)
                .catch(() => false);
            } else {
              // Fast path: focus the tile + Ctrl+W (Cursor's close-tile shortcut).
              // Fall back to the slower menu-driven close only if it didn't take.
              closed = await getCdpMonitor()
                .closeAgentTileFast(aid)
                .catch(() => false);
              if (!closed) {
                closed = await getCdpMonitor()
                  .closeAgentTile(aid)
                  .catch(() => false);
              }
            }
          }
          if (!closed) {
            dlog(`delete: failed to close tile for ${aid.slice(0, 8)}`, "error");
            postWorkflow({
              type: "workflowOutput",
              stream: "stderr",
              line: `[jefr] Failed to close tile for agent ${aid.slice(0, 8)}; keeping it in the roster.`,
            });
            notifyDelete("failed", "Could not close tile — try again or close it in Cursor");
            lastAgentListJson = undefined;
            pushAgentList();
            break;
          }
          dlog(`deleted agent ${aid.slice(0, 8)} (tile closed)`);
          tileStateManager.forgetAgent(aid);
          agentStats.delete(aid);
          forgetKeepConnected(aid);
          forgetAgentDir(aid);
          notifyDelete("closed");
          if (aid === selectedAgentId) {
            selectAgent(undefined);
          } else {
            lastAgentListJson = undefined;
            pushAgentList();
          }
          break;
        }
        case "focusAgent": {
          const aid = typeof msg.agentId === "string" ? msg.agentId.trim() : "";
          if (aid && cdpEnabled) {
            getCdpMonitor().focusAgent(aid).catch(() => {});
          }
          break;
        }
        case "sendText":
          if (!this.checkCard()) {
            return;
          }
          sendTextTo(selectedAgentId, msg.text);
          resetIdleTimer();
          triggerCursorChat();
          break;
        case "pickAttachment":
          if (!this.checkCard()) {
            return;
          }
          this.handlePickAttachment();
          break;
        case "sendImage":
          if (!this.checkCard()) {
            return;
          }
          this.handleSendImage(msg.caption);
          resetIdleTimer();
          break;
        case "sendPastedImage":
          if (!this.checkCard()) {
            return;
          }
          this.handlePastedImage(msg.dataUrl, msg.caption);
          resetIdleTimer();
          triggerCursorChat();
          break;
        case "sendPastedImages":
          if (!this.checkCard()) {
            return;
          }
          this.handlePastedImages(msg.images, msg.caption);
          resetIdleTimer();
          triggerCursorChat();
          break;
        case "sendFile":
          if (!this.checkCard()) {
            return;
          }
          this.handleSendFile();
          resetIdleTimer();
          break;
        case "resendFile":
          if (!this.checkCard()) {
            return;
          }
          if (msg.path) {
            sendFileTo(selectedAgentId, msg.path);
            resetIdleTimer();
            triggerCursorChat();
          }
          break;
        case "submitAnswer":
          writeAnswerFor(msg.data, selectedAgentId);
          break;
        case "cancelQuestion":
          cancelQuestionFor(selectedAgentId);
          break;
        case "ackReply":
          this.ackReply(msg.timestamp);
          break;
        case "activateCard":
          this.handleActivateCard(msg.code);
          break;
        case "logoutCard":
          clearCardState();
          this.pushCardState();
          break;
        case "getQueue":
          this.pushQueueData();
          break;
        case "deleteQueueItem":
          deleteQueueItemFor(msg.id, queueTarget(msg.agentId));
          this.pushQueueData();
          break;
        case "clearQueue":
          clearQueueFor(queueTarget(msg.agentId));
          this.pushQueueData();
          break;
        case "clearAllQueues":
          clearAllQueues();
          this.pushQueueData();
          break;
        case "updateQueueItem":
          updateQueueItemFor(msg.id, { content: msg.content }, queueTarget(msg.agentId));
          this.pushQueueData();
          break;
        case "fetchUsage":
          this.handleFetchUsage();
          break;
        case "injectToken":
          this.handleInjectToken(msg.token);
          break;
        case "clearInjectedToken":
          this.handleClearInjectedToken();
          break;
        case "openConsole":
          vscode.commands.executeCommand("mcpMessenger.openConsole");
          break;
        case "getServerInfo":
          mainPanel?.webview.postMessage({
            type: "serverInfo",
            data: { port: getServerPort(), clients: getConnectedClients() },
          });
          break;
        case "runWorkflow":
          try {
            runWorkflow({
              autoPrompt: msg.autoPrompt,
              opusPrompt: msg.opusPrompt,
              maxSecs: msg.maxSecs,
              enterInterval: msg.enterInterval,
              model: msg.model,
              // Default to keeping existing tiles so spawns accumulate agents;
              // the UI can pass keepTiles:false to force the clean-collapse spawn.
              keepTiles: msg.keepTiles !== false,
              skipAuto:
                typeof msg.skipAuto === "boolean"
                  ? msg.skipAuto
                  : skipAutoPhase || singleAgentMode,
              singleAgent:
                typeof msg.singleAgent === "boolean"
                  ? msg.singleAgent
                  : singleAgentMode,
            });
          } catch (e) {
            postWorkflow({
              type: "workflowOutput",
              stream: "stderr",
              line: `[jefr] runWorkflow failed: ${(e as Error).message}`,
            });
            postWorkflow({ type: "workflowState", running: false });
            postWorkflow({ type: "workflowExit", code: null });
          }
          break;
        case "reconnectWorkflow":
          try {
            runWorkflow({
              reconnect: true,
              tile:
                typeof msg.tile === "number" && Number.isInteger(msg.tile)
                  ? msg.tile
                  : undefined,
              model: poolModel,
              opusPrompt: msg.opusPrompt,
              maxSecs: msg.maxSecs,
              enterInterval: msg.enterInterval,
              singleAgent: singleAgentMode,
            });
          } catch (e) {
            postWorkflow({
              type: "workflowOutput",
              stream: "stderr",
              line: `[jefr] reconnectWorkflow failed: ${(e as Error).message}`,
            });
            postWorkflow({ type: "workflowState", running: false });
            postWorkflow({ type: "workflowExit", code: null });
          }
          break;
        case "stopWorkflow":
          stopWorkflow();
          break;
        case "getWorkflowState":
          postWorkflow({ type: "workflowState", running: !!workflowProc });
          break;
        case "getDebugLog":
          sendDebugLogSnapshot();
          break;
        case "clearDebugLog":
          debugLogBuf.length = 0;
          sendDebugLogSnapshot();
          break;
      }
    });
    webviewView.onDidDispose(() => {
      if (mainPanel === webviewView) {
        mainPanel = undefined;
        lastQuestionId = undefined;
        lastReplyTimestamp = undefined;
        lastQueueCount = undefined;
      }
    });
  }

  private handlePastedImage(dataUrl: string, caption?: string): void {
    try {
      const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (!match) {
        return;
      }
      const ext = match[1] === "jpeg" ? "jpg" : match[1];
      const buf = Buffer.from(match[2], "base64");
      const tmpPath = path.join(os.tmpdir(), "mcp_" + Date.now() + "." + ext);
      fs.writeFileSync(tmpPath, buf);
      const item = sendImageTo(selectedAgentId, tmpPath, caption, dataUrl);
      appendSharedHistory({
        id: item.id,
        kind: "image",
        dataUrl,
        caption,
        name: path.basename(tmpPath),
        path: tmpPath,
        timestamp: item.timestamp,
      });
    } catch {
      // ignore
    }
  }

  /** Queue text + multiple pasted images as ONE message. Each data: URL is
   *  written to a temp file, then all are bundled into a single queue item. */
  private handlePastedImages(
    images: Array<{ dataUrl: string; name?: string }>,
    caption?: string,
  ): void {
    try {
      const list = Array.isArray(images) ? images : [];
      const decoded: Array<{ path: string; dataUrl: string; name?: string }> = [];
      for (const img of list) {
        const match =
          typeof img?.dataUrl === "string"
            ? img.dataUrl.match(/^data:image\/(\w+);base64,(.+)$/)
            : null;
        if (!match) {
          continue;
        }
        const ext = match[1] === "jpeg" ? "jpg" : match[1];
        const buf = Buffer.from(match[2], "base64");
        const tmpPath = path.join(
          os.tmpdir(),
          "mcp_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8) + "." + ext,
        );
        fs.writeFileSync(tmpPath, buf);
        decoded.push({
          path: tmpPath,
          dataUrl: img.dataUrl,
          name: img.name || path.basename(tmpPath),
        });
      }
      if (decoded.length === 0) {
        return;
      }
      // A single image goes down the plain image path so nothing changes for it.
      if (decoded.length === 1) {
        this.handlePastedImage(decoded[0].dataUrl, caption);
        return;
      }
      const item = sendImagesTo(selectedAgentId, decoded, caption);
      appendSharedHistory({
        id: item.id,
        kind: "image",
        dataUrl: decoded[0].dataUrl,
        caption,
        name: decoded[0].name,
        path: decoded[0].path,
        images: decoded.map((d) => ({ path: d.path, dataUrl: d.dataUrl, name: d.name })),
        timestamp: item.timestamp,
      });
    } catch {
      // ignore
    }
  }

  private async handlePickAttachment(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
      filters: {
        Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"],
        Files: ["*"],
      },
    });
    if (!uris?.length) {
      return;
    }
    for (const uri of uris) {
      const name = path.basename(uri.fsPath);
      const isImage = /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(uri.fsPath);
      if (isImage) {
        let dataUrl: string | undefined = undefined;
        try {
          const buf = fs.readFileSync(uri.fsPath);
          const ext = path.extname(uri.fsPath).slice(1).toLowerCase() || "png";
          const mime = ext === "svg" ? "svg+xml" : ext === "jpg" ? "jpeg" : ext;
          dataUrl = `data:image/${mime};base64,${buf.toString("base64")}`;
        } catch {
          // ignore
        }
        mainPanel?.webview.postMessage({
          type: "attachmentAdded",
          item: { id: makeId(), type: "image", path: uri.fsPath, name, dataUrl },
        });
      } else {
        mainPanel?.webview.postMessage({
          type: "attachmentAdded",
          item: { id: makeId(), type: "file", path: uri.fsPath, name },
        });
      }
    }
  }

  private async handleSendImage(caption?: string): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] },
    });
    if (uris?.[0]) {
      sendImageTo(selectedAgentId, uris[0].fsPath, caption);
    }
  }

  private async handleSendFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
    if (uris?.[0]) {
      sendFileTo(selectedAgentId, uris[0].fsPath);
    }
  }

  private pushCurrentState(): void {
    if (!mainPanel) {
      return;
    }
    const question = readQuestionFor(selectedAgentId);
    if (question) {
      mainPanel.webview.postMessage({ type: "showQuestion", data: question });
      lastQuestionId = question.id;
    } else {
      mainPanel.webview.postMessage({ type: "clearQuestion" });
      lastQuestionId = undefined;
    }
    const reply = readReplyFor(selectedAgentId);
    if (reply) {
      mainPanel.webview.postMessage({ type: "showReply", data: reply });
      lastReplyTimestamp = reply.timestamp;
    } else {
      lastReplyTimestamp = undefined;
    }
    const count = getQueueCountFor(selectedAgentId);
    mainPanel.webview.postMessage({ type: "queueCount", count });
    lastQueueCount = count;
  }

  private checkCard(): boolean {
    return true;
  }

  private pushQueueData(): void {
    if (!mainPanel) {
      return;
    }
    mainPanel.webview.postMessage({ type: "queueData", data: readQueueFor(selectedAgentId) });
    pushAllQueues();
  }

  private pushCardState(): void {
    if (!mainPanel) {
      return;
    }
    mainPanel.webview.postMessage({ type: "cardState", data: { active: true } });
  }

  private async handleActivateCard(code?: string): Promise<void> {
    if (!mainPanel || !code) {
      return;
    }
    try {
      const result = await activateCard(code);
      if (result.success) {
        mainPanel.webview.postMessage({ type: "cardActivated", data: result.data });
        vscode.window.showInformationMessage(
          `License activated successfully. Valid for ${result.data?.duration_hours} hours`
        );
      } else {
        mainPanel.webview.postMessage({
          type: "cardError",
          error: result.error || "Activation failed",
        });
      }
    } catch (e) {
      mainPanel.webview.postMessage({
        type: "cardError",
        error: (e as Error).message || "Network error",
      });
    }
  }

  private async handleFetchUsage(): Promise<void> {
    if (!mainPanel) {
      return;
    }
    mainPanel.webview.postMessage({ type: "usageLoading" });
    try {
      const result = await fetchCursorUsage();
      mainPanel.webview.postMessage({ type: "usageData", data: result });
    } catch (e) {
      mainPanel.webview.postMessage({
        type: "usageData",
        data: { success: false, error: (e as Error).message || "Query failed" },
      });
    }
  }

  private async handleInjectToken(token?: string): Promise<void> {
    if (!mainPanel || !token) {
      return;
    }
    writeInjectedToken(token.trim());
    mainPanel.webview.postMessage({ type: "injectedTokenState", injected: true });
    this.handleFetchUsage();
  }

  private handleClearInjectedToken(): void {
    if (!mainPanel) {
      return;
    }
    clearInjectedToken();
    mainPanel.webview.postMessage({ type: "injectedTokenState", injected: false });
    this.handleFetchUsage();
  }

  private async ackReply(timestamp?: string): Promise<void> {
    const reply = readReplyFor(selectedAgentId);
    if (!reply) {
      lastReplyTimestamp = undefined;
      return;
    }
    if (!timestamp || reply.timestamp === timestamp) {
      if (REMOTE_API_ENABLED) {
        const card = readCardState();
        if (card && isCardValid() && reply.content) {
          const replyKey = (reply.timestamp || "") + reply.content.slice(0, 50);
          if (replyKey !== lastReplyContent) {
            lastReplyContent = replyKey;
            try {
              await pushRemoteReply(card.code, reply.content, getWorkspaceName());
            } catch {
              // ignore
            }
          }
        }
      }
      appendReplyToSharedHistory(reply);
      clearReplyFor(selectedAgentId);
      lastReplyTimestamp = undefined;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css")
    );
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta
		http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
	>
	<link rel="stylesheet" href="${styleUri}">
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
	<script nonce="${nonce}">
	(function(){
		const vscode = acquireVsCodeApi();

		/* ── Drag & Drop ── */
		var dragRetry = 0;
		function setupDragDrop(){
			var area = document.querySelector('.input-area');
			if(!area){ if(dragRetry++<30) setTimeout(setupDragDrop,500); return; }
			var dragCount = 0;
			area.addEventListener('dragenter', function(e){ e.preventDefault(); e.stopPropagation(); dragCount++; area.classList.add('drag-over'); });
			area.addEventListener('dragleave', function(e){ e.preventDefault(); e.stopPropagation(); dragCount--; if(dragCount<=0){dragCount=0;area.classList.remove('drag-over');} });
			area.addEventListener('dragover', function(e){ e.preventDefault(); e.stopPropagation(); });
			area.addEventListener('drop', function(e){
				e.preventDefault(); e.stopPropagation(); dragCount=0; area.classList.remove('drag-over');
				var files = e.dataTransfer && e.dataTransfer.files;
				if(!files||!files.length) return;
				Array.from(files).forEach(function(file){
					if(file.type && file.type.startsWith('image/')){
						var r = new FileReader(); r.onload=function(ev){ vscode.postMessage({type:'sendPastedImage',dataUrl:ev.target.result,caption:''}); }; r.readAsDataURL(file);
					} else {
						var r2 = new FileReader(); r2.onload=function(ev){ var c=ev.target.result; var p=c.length>500?c.slice(0,500)+'...':c; vscode.postMessage({type:'sendText',text:'[File: '+file.name+']\\n'+p}); }; r2.readAsText(file);
					}
				});
			});
		}


		/* ── Font zoom (Ctrl/Cmd +/-/0 and Ctrl+wheel) ── */
		var ZOOM_KEY = 'jefr.zoom';
		var ZOOM_MIN = 0.5, ZOOM_MAX = 3, ZOOM_STEP = 0.1;
		function getZoom(){
			var z = parseFloat(localStorage.getItem(ZOOM_KEY));
			return (isFinite(z) && z > 0) ? z : 1;
		}
		function applyZoom(z){
			z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z*100)/100));
			document.body.style.zoom = z;
			try { localStorage.setItem(ZOOM_KEY, String(z)); } catch(e){}
			return z;
		}
		function setupZoom(){
			applyZoom(getZoom());
			window.addEventListener('keydown', function(e){
				if(!(e.ctrlKey || e.metaKey)) return;
				var k = e.key;
				if(k === '+' || k === '=' ){ e.preventDefault(); applyZoom(getZoom()+ZOOM_STEP); }
				else if(k === '-' || k === '_'){ e.preventDefault(); applyZoom(getZoom()-ZOOM_STEP); }
				else if(k === '0'){ e.preventDefault(); applyZoom(1); }
			}, true);
			window.addEventListener('wheel', function(e){
				if(!(e.ctrlKey || e.metaKey)) return;
				e.preventDefault();
				applyZoom(getZoom() + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
			}, { passive: false, capture: true });
		}

		/* ── Enhanced history (placeholder) ── */
		function enhanceHistory(){}

		/* ── Tutorial ── */
		var tRetry = 0;
		function setupTutorial(){
			var app = document.querySelector('.app');
			if(!app){ if(tRetry++<30) setTimeout(setupTutorial,500); return; }
			if(app.querySelector('.tutorial-section')) return;
			var section = document.createElement('div');
			section.className = 'tutorial-section';
			var btn = document.createElement('button');
			btn.className = 'tutorial-btn';
			btn.innerHTML = '\\u{1F4D6} Tutorial';
			var body = document.createElement('div');
			body.className = 'tutorial-body';
			var steps = [
				['Install','Install jefr from VSIX, then restart Cursor'],
				['Check MCP','Cursor Settings \\u2192 Tools & MCP \\u2192 enable jefr'],
				['Start chat','Send a message in the bottom panel; AI replies in the loop']
			];
			var html='';
			for(var i=0;i<steps.length;i++){
				html+='<div class="tutorial-step"><span class="step-num">'+(i+1)+'</span><div class="step-content"><div class="step-title">'+steps[i][0]+'</div><div class="step-desc">'+steps[i][1]+'</div></div></div>';
			}
			body.innerHTML=html;
			section.appendChild(btn);
			section.appendChild(body);
			app.appendChild(section);
			btn.addEventListener('click',function(){ body.classList.toggle('show'); });
		}

		/* ── Init ── */
		function init(){ setupZoom(); setupDragDrop(); enhanceHistory(); setupTutorial(); }
		if(document.readyState==='loading'){ document.addEventListener('DOMContentLoaded', init); }
		else { init(); }
	})();
	</script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
