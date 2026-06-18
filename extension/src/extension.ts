import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as crypto from "crypto";

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
  makeId,
  readQuestion,
  writeAnswer,
  cancelQuestion,
  readReply,
  clearReply,
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
  type QuestionPayload,
} from "./messenger";
import {
  startLocalServer,
  stopLocalServer,
  setWorkspaceInfo,
  getServerPort,
  getConnectedClients,
} from "./local-server";

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

// Idle keep-alive: after this long with no activity, re-prime the chat loop.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

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

// ── Activation ──────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  extensionVersion = context.extension.packageJSON?.version || "0.0.0";
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  currentDataDir = computeDataDir(workspaceFolders);
  setDataDir(currentDataDir);
  migrateFromRootDir();

  setHistorySink((item) => {
    mainPanel?.webview.postMessage({ type: "historyAppend", item });
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
  setWorkspaceInfo(getWorkspaceName(), getWorkspacePath() || "");

  startLocalServer()
    .then((port) => {
      console.log(`jefr console started: http://127.0.0.1:${port}`);
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
  stopLocalServer();
}

// ── Local polling: mirror file state into the webview ───────────────────────

function startPolling(): void {
  const poll = () => {
    if (!mainPanel) {
      return;
    }
    const question = readQuestion();
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

    const reply = readReply();
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

    const count = getQueueCount();
    if (count !== lastQueueCount) {
      mainPanel.webview.postMessage({ type: "queueCount", count });
      mainPanel.webview.postMessage({ type: "queueData", data: readQueue() });
      lastQueueCount = count;
    }
  };
  poll();
  pollTimer2 = setInterval(poll, 500);
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
          break;
        case "sendText":
          if (!this.checkCard()) {
            return;
          }
          sendText(msg.text);
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
            sendFile(msg.path);
            resetIdleTimer();
            triggerCursorChat();
          }
          break;
        case "submitAnswer":
          writeAnswer(msg.data);
          break;
        case "cancelQuestion":
          cancelQuestion();
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
          deleteQueueItem(msg.id);
          this.pushQueueData();
          break;
        case "clearQueue":
          clearQueue();
          this.pushQueueData();
          break;
        case "updateQueueItem":
          updateQueueItem(msg.id, { content: msg.content });
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
      sendImage(tmpPath, caption);
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
      sendImage(uris[0].fsPath, caption);
    }
  }

  private async handleSendFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false });
    if (uris?.[0]) {
      sendFile(uris[0].fsPath);
    }
  }

  private pushCurrentState(): void {
    if (!mainPanel) {
      return;
    }
    const question = readQuestion();
    if (question) {
      mainPanel.webview.postMessage({ type: "showQuestion", data: question });
      lastQuestionId = question.id;
    } else {
      mainPanel.webview.postMessage({ type: "clearQuestion" });
      lastQuestionId = undefined;
    }
    const reply = readReply();
    if (reply) {
      mainPanel.webview.postMessage({ type: "showReply", data: reply });
      lastReplyTimestamp = reply.timestamp;
    } else {
      lastReplyTimestamp = undefined;
    }
    const count = getQueueCount();
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
    mainPanel.webview.postMessage({ type: "queueData", data: readQueue() });
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
    const reply = readReply();
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
      clearReply();
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
