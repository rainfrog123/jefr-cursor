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
  sendFileTo,
  deleteQueueItemFor,
  clearQueueFor,
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
  getServerPort,
  getConnectedClients,
} from "./local-server";
import {
  reconcile,
  pickReconnect,
  type AgentStat,
} from "./agentStats";
import { getCdpMonitor, stopCdpMonitor, type CdpStatus } from "./cdp-monitor";
import { TileStateManager, type AgentView } from "./tile-state";

// ── Module state ────────────────────────────────────────────────────────────

let mainPanel: vscode.WebviewView | undefined;
let pollTimer2: ReturnType<typeof setInterval> | undefined;
let lastQuestionId: string | undefined;
let lastReplyTimestamp: string | undefined;
let lastQueueCount: number | undefined;
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

// Auto-reconnect: when a previously-connected agent's heartbeat goes stale, the
// extension re-primes its tile via the CDP workflow. Off by default; togglable.
let autoReconnect = false;
const RECONNECT_DEBOUNCE_MS = 45_000;
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
    lastCdpStatus = status;

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

    // Auto-reconnect dropped agents
    if (autoReconnect && !workflowProc) {
      const dropped = tileStateManager.getDroppedAgents();
      for (const agent of dropped) {
        const debounceOk = Date.now() - agent.lastReconnectAt >= RECONNECT_DEBOUNCE_MS;
        const attemptsOk = agent.reconnectStreak < MAX_RECONNECT_ATTEMPTS;
        if (debounceOk && attemptsOk) {
          tileStateManager.markReconnectAttempt(agent.agentId);
          postWorkflow({
            type: "workflowOutput",
            stream: "stdout",
            line: `[jefr] auto-reconnect: agent ${agent.agentId.slice(0, 8)} dropped — re-priming its tile`,
          });
          runWorkflow({ reconnect: true, agentId: agent.agentId });
          break; // One at a time
        }
      }
    }

    // Push to webview
    pushAgentListFromCdp();
  });

  // Start monitoring (async, non-blocking)
  monitor.start().catch((e) => {
    console.error("CDP monitor failed to start:", e);
  });
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

  const payload = {
    agents,
    selected: selectedAgentId || null,
    autoReconnect,
    targetAgentCount: TARGET_AGENT_COUNT,
    cdpConnected: lastCdpStatus?.connected ?? false,
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

/** Resolve automation/workflow.py relative to this extension install (repo layout:
 *  jefr-cursor/extension/dist/extension.js → jefr-cursor/automation/workflow.py). */
function bundledWorkflowScript(): string {
  return path.join(__dirname, "..", "..", "automation", "workflow.py");
}

/** Cached workflow script path (recomputed when workspace folders change). */
let resolvedWorkflowScript: string | undefined;
let resolvedWorkflowScriptFor: string | undefined;

/**
 * Resolve workflow.py. Only these locations are considered:
 *   1. jefr-cursor/automation/ bundled next to this extension
 *   2. automation/workflow.py in each open workspace folder
 * Returns null when neither exists.
 */
function resolveWorkflowScript(): string | null {
  const wsKey = (vscode.workspace.workspaceFolders || [])
    .map((f) => f.uri.fsPath)
    .join("|");
  if (resolvedWorkflowScript !== undefined && resolvedWorkflowScriptFor === wsKey) {
    return resolvedWorkflowScript || null;
  }
  const candidates: string[] = [bundledWorkflowScript()];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    candidates.push(path.join(folder.uri.fsPath, "automation", "workflow.py"));
  }
  resolvedWorkflowScript = candidates.find((p) => fs.existsSync(p)) ?? "";
  resolvedWorkflowScriptFor = wsKey;
  return resolvedWorkflowScript || null;
}

/** Default model for workflow spawn (--model when the UI omits one). */
const WORKFLOW_DEFAULT_MODEL = "Opus 4.8 1M Extra High Fast";
/** Target number of agents to keep online (UI slot count). */
const TARGET_AGENT_COUNT = 5;
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
  /** Model to switch the spawned tile to (passed as --model; spawn path only). */
  model?: string;
  /** Keep existing tiles (don't collapse) so spawns accumulate agents. Spawn
   *  path only; reconnect never collapses. */
  keepTiles?: boolean;
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
        "[jefr] Workflow script not found. Open the jefr-cursor workspace " +
        "(automation/workflow.py) or install the extension from that repo.",
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
  if (opts.reconnect) {
    args.push("--reconnect");
    if (typeof opts.tile === "number" && Number.isInteger(opts.tile)) {
      args.push("--tile", String(opts.tile));
    }
    if (opts.agentId && opts.agentId.trim()) {
      args.push("--agent-id", opts.agentId.trim());
    }
  } else if (opts.autoPrompt && opts.autoPrompt.trim()) {
    args.push(opts.autoPrompt);
  }
  if (!opts.reconnect) {
    args.push("--model", (opts.model && opts.model.trim()) || WORKFLOW_DEFAULT_MODEL);
    // Accumulate agents by default: keep already-open tiles instead of collapsing
    // them, so the roster can hold several agents online at once.
    if (opts.keepTiles !== false) {
      args.push("--keep-tiles");
    }
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

  const pump = (buf: Buffer, stream: "stdout" | "stderr") => {
    const text = buf.toString();
    for (const line of text.split(/\r?\n/)) {
      if (line.length > 0) {
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
  });
}

/** Terminate a running workflow (and its child CDP process tree on Windows). */
function stopWorkflow(): void {
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

// Idle keep-alive: after this long with no activity, re-prime the chat loop.
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function resetIdleTimer(): void {
  lastActivityTime = Date.now();
}

function startIdleTimer(): void {
  if (idleTimer) {
    clearInterval(idleTimer);
  }
  idleTimer = setInterval(() => {
    if (!isCardValid()) {
      return;
    }
    if (Date.now() - lastActivityTime >= IDLE_TIMEOUT_MS) {
      sendText(
        "Hello. IMPORTANT: STAND BY. Take NO action of any kind right now — do not run any tools, edit files, or make any changes. Just hold, keep the connection open, and wait for my next instruction."
      );
      triggerCursorChat();
      resetIdleTimer();
    }
  }, 60000);
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
        name: item.path ? path.basename(item.path) : undefined,
        dataUrl: item.dataUrl,
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
  startIdleTimer();
  autoSetupMcp();
  startCdpMonitoring(); // CDP-based tile state monitoring
  setWorkspaceInfo(getWorkspaceName(), getWorkspacePath() || "");

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
  stopWorkflow();
  stopLocalServer();
  stopCdpMonitor(); // Stop CDP monitoring
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

  if (autoReconnect && !workflowProc) {
    const target = pickReconnect(dropped, agentStats, now, RECONNECT_DEBOUNCE_MS);
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
        line: `[jefr] auto-reconnect: agent ${target.slice(0, 8)} dropped — re-priming its tile`,
      });
      runWorkflow({ reconnect: true, agentId: target });
    }
  }

  writeCdpStatusFile(agents);

  const payload = {
    agents,
    selected: selectedAgentId || null,
    autoReconnect,
    targetAgentCount: TARGET_AGENT_COUNT,
    cdpConnected: cdpFallback ? (lastCdpStatus?.connected ?? false) : false,
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
  // Focus the agent's tile in Cursor so MCP routing lands on the right pane.
  if (selectedAgentId && cdpEnabled) {
    getCdpMonitor()
      .focusAgent(selectedAgentId)
      .catch(() => {});
  }
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
  pushAgentList();
}

function getWorkspaceName(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].name;
  }
  return "default";
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
          pushAgentList();
          break;
        case "selectAgent":
          selectAgent(msg.agentId);
          break;
        case "setAutoReconnect":
          autoReconnect = !!msg.enabled;
          lastAgentListJson = undefined; // force a re-push with the new flag
          pushAgentList();
          break;
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
            runWorkflow({ reconnect: true, agentId: aid });
          }
          break;
        }
        case "addAgent": {
          const current = tileStateManager.toAgentViews().length;
          if (current >= TARGET_AGENT_COUNT) {
            postWorkflow({
              type: "workflowOutput",
              stream: "stderr",
              line: `[jefr] Already at ${TARGET_AGENT_COUNT} agents — delete one first.`,
            });
            break;
          }
          runWorkflow({
            model: (typeof msg.model === "string" && msg.model.trim()) || WORKFLOW_DEFAULT_MODEL,
            keepTiles: true,
          });
          break;
        }
        case "deleteAgent": {
          const aid = typeof msg.agentId === "string" ? msg.agentId.trim() : "";
          if (!aid) break;
          const wasVisible = (tileStateManager.getAgent(aid)?.tileIndex ?? -1) >= 0;
          let closed = true;
          if (cdpEnabled && wasVisible) {
            closed = await getCdpMonitor()
              .closeAgentTile(aid)
              .catch(() => false);
          }
          if (!closed) {
            postWorkflow({
              type: "workflowOutput",
              stream: "stderr",
              line: `[jefr] Failed to close tile for agent ${aid.slice(0, 8)}; keeping it in the roster.`,
            });
            lastAgentListJson = undefined;
            pushAgentList();
            break;
          }
          tileStateManager.forgetAgent(aid);
          agentStats.delete(aid);
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
          deleteQueueItemFor(msg.id, selectedAgentId);
          this.pushQueueData();
          break;
        case "clearQueue":
          clearQueueFor(selectedAgentId);
          this.pushQueueData();
          break;
        case "updateQueueItem":
          updateQueueItemFor(msg.id, { content: msg.content }, selectedAgentId);
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
              opusPrompt: msg.opusPrompt,
              maxSecs: msg.maxSecs,
              enterInterval: msg.enterInterval,
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
      const item = sendImageTo(selectedAgentId, tmpPath, caption);
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
