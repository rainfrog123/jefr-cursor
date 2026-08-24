"use strict";

/**
 * jefr — Obsidian chat plugin.
 *
 * A faithful port of the jefr Cursor side-panel input area, living inside
 * Obsidian. It connects to the jefr VS Code extension's local WebSocket server
 * (default ws://127.0.0.1:39517) and speaks the exact same protocol the
 * built-in Remote Console uses, so everything you send here flows through the
 * SAME message queue your Cursor agent reads — and shows up in the jefr panel
 * inside Cursor as well.
 *
 * Protocol (server -> client):
 *   { type: "init" | "stateUpdate", queue, queueCount, reply, question, workspace, wsClients, port, ... }
 *   { type: "queueUpdate", count }
 *   { type: "responseLog", markdown, timestamp?, agentId? }
 *   { type: "pong" }
 * Protocol (client -> server):
 *   { type: "sendText", text }
 *   { type: "submitAnswer", data: { id, answers: [{ questionId, selected, other }] } }
 *   { type: "cancelQuestion" }
 *   { type: "ackReply" }
 *   { type: "ping" }
 *
 * Phase 2: this local Obsidian plugin can open multiple WebSockets at once
 * (e.g. local Cursor :39517 + Remote-SSH forwarded VPS :39518) and route
 * chat/agents by endpoint. multi-agent-ssh stays the VPS install track.
 */

const { Plugin, ItemView, PluginSettingTab, Setting, MarkdownRenderer, Notice, setIcon, Modal } = require("obsidian");

const VIEW_TYPE_JEFR = "jefr-chat-view";

const DEFAULT_ENDPOINTS = [
  { id: "local", label: "Local", host: "127.0.0.1", port: 39517, enabled: true },
  { id: "ali_sg", label: "VPS", host: "127.0.0.1", port: 39518, enabled: true },
];

const DEFAULT_SETTINGS = {
  // Legacy single-host fields (migrated into endpoints on load).
  host: "127.0.0.1",
  port: 39517,
  endpoints: DEFAULT_ENDPOINTS.map((e) => Object.assign({}, e)),
  activeEndpointId: "local",
  autoReconnect: true,
  maxHistory: 400,
  minimized: false,
  // Compact-mode pasted/uploaded image thumbnail edge length (px).
  attachThumbSize: 26,
  // Fire a native OS (Windows) notification whenever the MCP Response Log is
  // rewritten by the agent. Path is vault-relative (forward slashes).
  notifyOnLogRewrite: true,
  logNotifyPath: "_Vault/MCP Response Log.md",
};

/** Ensure settings have an endpoints[] list; map legacy host/port if needed. */
function migrateSettings(raw) {
  const s = Object.assign({}, DEFAULT_SETTINGS, raw || {});
  if (!Array.isArray(s.endpoints) || s.endpoints.length === 0) {
    const port = Number(s.port) || 39517;
    s.endpoints = [
      {
        id: "local",
        label: port === 39518 ? "VPS" : "Local",
        host: (s.host || "127.0.0.1").trim() || "127.0.0.1",
        port,
        enabled: true,
      },
    ];
    // If they were only on 39517, still offer the VPS forward slot.
    if (port !== 39518) {
      s.endpoints.push({
        id: "ali_sg",
        label: "VPS",
        host: "127.0.0.1",
        port: 39518,
        enabled: true,
      });
    }
  }
  s.endpoints = s.endpoints.map((e, i) => ({
    id: String((e && e.id) || "ep" + i).trim() || "ep" + i,
    label: String((e && e.label) || e.id || "Endpoint").trim() || "Endpoint",
    host: String((e && e.host) || "127.0.0.1").trim() || "127.0.0.1",
    port: Number(e && e.port) > 0 ? Number(e.port) : 39517,
    enabled: e && e.enabled === false ? false : true,
  }));
  if (!s.activeEndpointId || !s.endpoints.some((e) => e.id === s.activeEndpointId)) {
    const firstOn = s.endpoints.find((e) => e.enabled) || s.endpoints[0];
    s.activeEndpointId = firstOn ? firstOn.id : "local";
  }
  // Keep legacy fields in sync with the active endpoint (older code / display).
  const active = s.endpoints.find((e) => e.id === s.activeEndpointId) || s.endpoints[0];
  if (active) {
    s.host = active.host;
    s.port = active.port;
  }
  const thumb = parseInt(s.attachThumbSize, 10);
  s.attachThumbSize = Number.isFinite(thumb) ? Math.min(240, Math.max(16, thumb)) : 26;
  return s;
}

function endpointKey(endpointId, agentId) {
  return String(endpointId || "") + "::" + (agentId ? String(agentId) : "");
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

class JefrPlugin extends Plugin {
  async onload() {
    this.settings = migrateSettings(await this.loadData());
    await this.saveData(this.settings);

    this.registerView(VIEW_TYPE_JEFR, (leaf) => new JefrView(leaf, this));

    this.addRibbonIcon("messages-square", "Open JEFR Chat", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-jefr-chat",
      name: "Open JEFR Chat",
      callback: () => this.activateView(),
    });

    // Focus-independent way to attach the clipboard image (bind a hotkey to it,
    // e.g. Ctrl+Shift+V). Works even when a note has focus.
    this.addCommand({
      id: "attach-clipboard-image",
      name: "Attach image from clipboard",
      callback: async () => {
        try {
          let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_JEFR)[0];
          if (!leaf) {
            await this.activateView();
            leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_JEFR)[0];
          }
          const view = leaf && leaf.view;
          if (view && typeof view.tryClipboardImage === "function") {
            this.app.workspace.revealLeaf(leaf);
            const ok = await view.tryClipboardImage();
            if (!ok) new Notice("jefr: no image found in clipboard");
          } else {
            new Notice("jefr: open the jefr panel first, then retry");
          }
        } catch {
          /* ignore */
        }
      },
    });

    this.addCommand({
      id: "toggle-compact-mode",
      name: "Toggle compact mode",
      callback: async () => {
        this.settings.minimized = !this.settings.minimized;
        await this.saveData(this.settings);
        this.app.workspace.getLeavesOfType(VIEW_TYPE_JEFR).forEach((leaf) => {
          if (leaf.view instanceof JefrView) leaf.view.applyMinimized();
        });
      },
    });

    this.addSettingTab(new JefrSettingTab(this.app, this));

    // Watch the vault for the MCP Response Log being rewritten and raise a
    // native OS notification. Obsidian fires "modify" for external writes too,
    // so this catches the agent overwriting the file from outside Obsidian.
    this._lastLogNotifyAt = 0;
    void ensureNotificationPermission();
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onVaultModify(file)),
    );
  }

  onunload() {
    // Views detach themselves and close their sockets via onClose().
  }

  /** Vault "modify" handler — fire an OS notification when the configured
   *  MCP Response Log file changes. Debounced so one rewrite = one toast. */
  onVaultModify(file) {
    if (!this.settings.notifyOnLogRewrite || !file || !file.path) return;
    const target = (this.settings.logNotifyPath || "").trim();
    if (!target) return;

    const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
    const fp = norm(file.path);
    const tp = norm(target);
    // Match the configured vault-relative path, or fall back to basename so a
    // mis-set folder still works as long as the filename matches.
    const baseOf = (p) => p.slice(p.lastIndexOf("/") + 1);
    const matches = fp === tp || fp.endsWith("/" + tp) || baseOf(fp) === baseOf(tp);
    if (!matches) return;

    const now = Date.now();
    if (now - (this._lastLogNotifyAt || 0) < 800) return; // debounce double-fires
    this._lastLogNotifyAt = now;

    showOsNotification("MCP Response Log updated", {
      body: (file.basename || baseOf(file.path)) + " was just rewritten by the agent.",
      onClick: () => {
        try {
          this.app.workspace.openLinkText(file.path, "", false);
        } catch {
          /* ignore */
        }
      },
    });
  }

    async saveSettings() {
    this.settings = migrateSettings(this.settings);
    await this.saveData(this.settings);
    // Let any open view react to host/port changes.
    this.app.workspace.getLeavesOfType(VIEW_TYPE_JEFR).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof JefrView) view.onSettingsChanged();
    });
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_JEFR)[0];
    if (!leaf) {
      // Open in the main editor area as a new tab (not the right sidebar).
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_JEFR, active: true });
    }
    workspace.revealLeaf(leaf);
  }
}

/* ------------------------------------------------------------------ */
/* Question modal (compact mode — escapes the narrow side pane)        */
/* ------------------------------------------------------------------ */

class JefrQuestionModal extends Modal {
  /**
   * @param {import("obsidian").App} app
   * @param {JefrView} view
   * @param {*} q
   */
  constructor(app, view, q) {
    super(app);
    this.jefrView = view;
    this.q = q;
  }

  onOpen() {
    this.modalEl.addClass("jefr-qmodal");
    this.titleEl.setText("Agent question");
    this.jefrView.mountQuestionCard(this.contentEl, this.q, { inModal: true });
    this.jefrView.bindQuestionKeys(this.q);
    window.setTimeout(() => {
      const first = this.contentEl.querySelector(".jefr-qopt, .jefr-qother");
      if (first && typeof first.focus === "function") first.focus();
    }, 20);
  }

  onClose() {
    const view = this.jefrView;
    view.removeQuestionKeyHandler();
    // Programmatic clear sets questionModal = null before close(); user dismiss
    // (Esc / X) still has the ref — keep the dock chip so they can reopen.
    if (view.questionModal === this) {
      view.questionModal = null;
      view.questionMount = null;
      if (view.currentQuestionId === this.q.id && view.pendingQuestion) {
        view.renderQuestionChip(view.pendingQuestion);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* The chat view                                                       */
/* ------------------------------------------------------------------ */

class JefrView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;

    // Multi-host: one connection record per endpoint id.
    // { ep, ws, status, reconnectAttempts, reconnectTimer, pingTimer, awaitingPong,
    //   agent, agents, selectedAgentId, queue, queueCount, workspace, question }
    this.conns = {};
    this.activeEndpointId = (plugin.settings && plugin.settings.activeEndpointId) || "local";

    // De-dupe / render bookkeeping.
    this.lastReplyTs = null;
    this.currentQuestionId = null;
    this.currentQuestionEndpointId = null;
    this.pendingQuestion = null;
    this.questionModal = null;
    this.questionMount = null;
    // After submit/cancel we clear the UI immediately, but question.json can
    // linger until the agent reads the answer — ignore rebroadcasts of that id
    // so the card/modal does not flicker open again.
    this._dismissedQuestionId = null;
    this.selected = {}; // questionId -> string[]
    this.connStatus = "offline";
    this.attachments = []; // staged images: { id, name, dataUrl }
    this._progressHideTimer = null;
    this.lastQueue = [];
    this.queueOpen = false;
    this.renderedIds = new Set(); // shared-history item ids already shown
    this.manualClose = false;
    // Merged route selection: endpointId + agentId (null agent = shared on that host)
    this.selectedAgentId = null;
    this.liveAgents = []; // merged list with hostId / hostLabel
  }

  /** WebSocket for the currently active (routing) endpoint. */
  activeWs() {
    const c = this.conns[this.activeEndpointId];
    return c && c.ws ? c.ws : null;
  }

  enabledEndpoints() {
    const list = (this.plugin.settings && this.plugin.settings.endpoints) || [];
    return list.filter((e) => e && e.enabled !== false);
  }

  getViewType() {
    return VIEW_TYPE_JEFR;
  }

  getDisplayText() {
    return "JEFR Chat";
  }

  getIcon() {
    return "messages-square";
  }

  async onOpen() {
    this.buildUI();
    this.connectAll();
  }

  async onClose() {
    this.manualClose = true;
    this.teardownAll();
  }

  onSettingsChanged() {
    this.applyAttachThumbSize();
    this.teardownAll();
    this.activeEndpointId =
      (this.plugin.settings && this.plugin.settings.activeEndpointId) || "local";
    this.connectAll();
  }

  /* ----------------------------- UI ------------------------------ */

  buildUI() {
    const root = this.contentEl;
    root.empty();
    root.addClass("jefr-root");

    // Scrollable region: header + status + messages all scroll together, so the
    // header scrolls away as you scroll down. The composer stays pinned below.
    const scroll = root.createDiv({ cls: "jefr-scroll" });
    this.scrollEl = scroll;

    // Header
    const header = scroll.createDiv({ cls: "jefr-header" });
    this.headerEl = header;
    const brand = header.createDiv({ cls: "jefr-brand" });
    brand.createSpan({ cls: "jefr-logo", text: "JEFR Chat" });
    // The agent route picker now lives down with the composer (see below) so it's
    // always next to where you type. These just hold the picker state.
    this.liveAgents = [];
    this.selectedAgentId = null;
    this.statusPill = brand.createSpan({ cls: "jefr-status jefr-status-offline", text: "Offline" });
    // Distinct from the connection pill: this reflects whether a Cursor agent is
    // actually running the perpetual loop (heartbeat), not just that the socket
    // is open. "Listening" = will pick up your message now; "Busy" = mid-task,
    // messages queue; "No agent" = nothing is draining the queue.
    this.agentPill = brand.createSpan({ cls: "jefr-agent jefr-agent-idle", text: "No agent" });
    this.agentPill.setAttr("title", "Whether a Cursor agent is actively listening");

    const headerRight = header.createDiv({ cls: "jefr-header-right" });
    this.queueBadge = headerRight.createSpan({ cls: "jefr-queue-badge", text: "" });
    this.queueBadge.onclick = () => this.toggleQueuePanel();
    this.reconnectBtn = headerRight.createEl("button", { cls: "jefr-icon-btn jefr-reconnect-btn", attr: { "aria-label": "Reconnect" } });
    setIcon(this.reconnectBtn, "refresh-cw");
    this.reconnectBtn.onclick = () => {
      this.teardownAll();
      this.connectAll();
    };

    // Collapsible panel listing the queued (pending) messages. Toggled by
    // clicking the queue badge. Smoothly expands/collapses.
    this.queuePanel = scroll.createDiv({ cls: "jefr-queue-panel" });
    this.queueOpen = false;

    // Progress bar (driven by send_progress percent).
    this.progressWrap = scroll.createDiv({ cls: "jefr-progress" });
    this.progressWrap.style.display = "none";
    const progressTrack = this.progressWrap.createDiv({ cls: "jefr-progress-track" });
    this.progressFill = progressTrack.createDiv({ cls: "jefr-progress-fill" });
    this.progressLabel = this.progressWrap.createDiv({ cls: "jefr-progress-label" });

    this.workspaceLine = scroll.createDiv({ cls: "jefr-workspace" });
    this.workspaceLine.setText("");

    // Messages
    this.messagesEl = scroll.createDiv({ cls: "jefr-messages" });
    this.renderEmptyState();

    // Question card mount point (above the composer)
    this.questionEl = scroll.createDiv({ cls: "jefr-question-host" });

    // Composer (inside the scroll region so the header can scroll away above it)
    const composer = scroll.createDiv({ cls: "jefr-composer" });
    this.composerEl = composer;
    // Agent route picker pinned with the composer: see/switch which agent your
    // message routes to right where you type. Click it (or use Ctrl/Cmd+PageUp/
    // PageDown while focused in the box) to change the target.
    const routeBar = composer.createDiv({ cls: "jefr-composer-route" });
    this.routeLabel = routeBar.createSpan({
      cls: "jefr-route jefr-route-idle",
      attr: { role: "button", tabindex: "0" },
    });
    this.routeLabel.setAttr("title", "Choose which agent this message routes to");
    this.routeNameEl = this.routeLabel.createSpan({ cls: "jefr-route-name", text: "" });
    this.routeModelEl = this.routeLabel.createSpan({ cls: "jefr-route-model", text: "" });
    this.routeLabel.createSpan({ cls: "jefr-route-caret", text: "▾" });
    this.routeLabel.onclick = (e) => {
      e.stopPropagation();
      this.toggleAgentMenu();
    };
    this.routeLabel.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.toggleAgentMenu();
      }
    });
    // Dropdown of live agents, opening upward from the composer.
    this.agentMenu = routeBar.createDiv({ cls: "jefr-agent-menu" });
    // Expand/compact toggle sits on this row (right side), so the redundant "jefr"
    // header can be hidden in compact mode — Obsidian already labels the pane.
    this.minimizeBtn = routeBar.createEl("button", { cls: "jefr-icon-btn jefr-minimize-btn", attr: { "aria-label": "Toggle compact mode" } });
    this.minimizeBtn.onclick = () => this.toggleMinimized();
    this.updateRouteLabel();
    this.attachBar = composer.createDiv({ cls: "jefr-attachbar" });
    this.input = composer.createEl("textarea", {
      cls: "jefr-input",
      attr: {
        placeholder: "Message your Cursor agent…  (Enter to send, Shift+Enter newline, paste an image)",
        rows: "3",
        spellcheck: "false",
        autocorrect: "off",
        autocapitalize: "off",
        autocomplete: "off",
      },
    });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.doSend();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.doSend();
      } else if (e.key === "ArrowUp" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Shell-style history recall: Up brings back the previous sent message.
        // Only hijacks Up when the caret is at the very start (or input empty),
        // or once we're already navigating history, so multi-line editing works.
        const hist = this.sentHistory || [];
        const inHistory = this.historyIndex != null && this.historyIndex !== -1;
        const caretAtStart = this.input.selectionStart === 0 && this.input.selectionEnd === 0;
        if (hist.length && (this.input.value === "" || caretAtStart || inHistory)) {
          e.preventDefault();
          this.recallHistory(-1);
        }
      } else if (e.key === "ArrowDown" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (this.historyIndex != null && this.historyIndex !== -1) {
          e.preventDefault();
          this.recallHistory(1);
        }
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) {
        // Try every clipboard method; if none yields an image, fall back to
        // absorbing any ![[..]] embed Obsidian may insert.
        this.tryClipboardImage().then((ok) => {
          if (!ok) window.setTimeout(() => this.absorbEmbeds(), 60);
        });
      }
    });
    this.input.addEventListener("input", () => {
      // Real typing leaves history-navigation mode (programmatic value sets in
      // recallHistory don't fire 'input', so they won't reset this).
      this.historyIndex = -1;
      this.updateSendState();
    });
    // Capture phase so we see the paste before Obsidian's global handler can
    // swallow it; bubble phase as a backup.
    this.input.addEventListener("paste", (e) => this.onPaste(e), true);
    this.input.addEventListener("paste", (e) => this.onPaste(e));

    // Drag & drop images/files onto the composer.
    composer.addEventListener("dragover", (e) => {
      e.preventDefault();
      composer.addClass("jefr-dragover");
    });
    composer.addEventListener("dragleave", () => composer.removeClass("jefr-dragover"));
    composer.addEventListener("drop", (e) => {
      e.preventDefault();
      composer.removeClass("jefr-dragover");
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) this.ingestFiles(Array.from(files));
    });

    const toolbar = composer.createDiv({ cls: "jefr-toolbar" });
    const leftActions = toolbar.createDiv({ cls: "jefr-actions-left" });
    this.attachBtn = leftActions.createEl("button", { cls: "jefr-icon-btn", attr: { "aria-label": "Attach / paste image" } });
    setIcon(this.attachBtn, "image-plus");
    this.attachBtn.onclick = () => this.onAttachClick();
    this.hint = leftActions.createSpan({ cls: "jefr-hint", text: "Enter to send" });

    // Hidden file input for the attach button. Use a visually-hidden style
    // (not display:none) so the programmatic click reliably opens the dialog.
    this.fileInput = composer.createEl("input", { cls: "jefr-fileinput", attr: { type: "file", accept: "image/*", multiple: "true" } });
    this.fileInput.addEventListener("change", () => {
      const files = this.fileInput.files ? Array.from(this.fileInput.files) : [];
      if (files.length) this.ingestFiles(files);
      this.fileInput.value = "";
    });

    const actions = toolbar.createDiv({ cls: "jefr-actions" });
    this.clearBtn = actions.createEl("button", { cls: "jefr-btn jefr-btn-ghost", text: "Clear" });
    this.clearBtn.onclick = () => this.clearHistory();
    this.sendBtn = actions.createEl("button", { cls: "jefr-btn jefr-btn-send", text: "Send" });
    this.sendBtn.onclick = () => this.doSend();

    // Document-level capture paste: Obsidian's global handler otherwise routes a
    // pasted image into the active note. When our input is focused, grab it first.
    this.registerDomEvent(
      document,
      "paste",
      (e) => {
        if (this.isComposerFocused()) this.onPaste(e);
      },
      true
    );

    // Ctrl/Cmd + PageUp / PageDown switches the active ("talking-to") agent while
    // the composer is focused. A window capture-phase keydown (fires before any
    // document/element listener, so it can beat Obsidian's default tab hotkey),
    // gated to when the composer has focus. It does NOT push a keymap scope, so it
    // can't affect textarea focus (which the earlier scope approach did).
    this.registerDomEvent(
      window,
      "keydown",
      (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
        if (e.key !== "PageUp" && e.key !== "PageDown") return;
        if (!this.isComposerFocused()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.cycleAgent(e.key === "PageDown" ? 1 : -1);
      },
      true
    );

    // Dock the header together with the composer at the bottom, below the
    // scrollable conversation, so the brand/status/controls and the input read as
    // one integrated block. (The elements were built inside `scroll`; move them.)
    const dock = root.createDiv({ cls: "jefr-dock" });
    dock.appendChild(this.headerEl);
    // Keep the Q&A card in the dock (above the composer) so ask_question is still
    // shown in compact mode, where the scrollable conversation is hidden.
    dock.appendChild(this.questionEl);
    dock.appendChild(this.composerEl);

    this.applyMinimized();
    this.updateSendState();
  }

  isComposerFocused() {
    const active = document.activeElement;
    return active === this.input || (this.input && this.input.contains(active));
  }

  onAttachClick() {
    // Open the picker synchronously to preserve the user gesture (an await here
    // would make Electron block the file dialog).
    if (this.fileInput) this.fileInput.click();
  }

  applyMinimized() {
    const on = !!this.plugin.settings.minimized;
    if (this.contentEl) this.contentEl.toggleClass("jefr-minimized", on);
    this.applyAttachThumbSize();
    if (this.minimizeBtn) {
      this.minimizeBtn.empty();
      setIcon(this.minimizeBtn, on ? "maximize-2" : "minimize-2");
      this.minimizeBtn.setAttr("aria-label", on ? "Expand" : "Compact mode");
    }
    if (on) {
      // Compact: default-scroll past the header so only the text area shows;
      // scrolling up reveals the header.
      window.setTimeout(() => this.scrollPastHeader(), 30);
    } else {
      this.scrollToBottom();
    }
    // Re-present an open question in the layout that matches the new mode
    // (wide modal in compact, in-pane card when expanded).
    if (this.pendingQuestion && this.currentQuestionId) {
      const q = this.pendingQuestion;
      this.currentQuestionId = null;
      this.renderQuestion(q);
    }
  }

  /** Apply compact-mode attachment thumbnail size from settings (CSS var). */
  applyAttachThumbSize() {
    if (!this.contentEl) return;
    const n = Number(this.plugin.settings && this.plugin.settings.attachThumbSize);
    const px = Number.isFinite(n) ? Math.min(240, Math.max(16, Math.round(n))) : 26;
    this.contentEl.style.setProperty("--jefr-attach-thumb-size", px + "px");
  }

  scrollPastHeader() {
    if (this.scrollEl && this.headerEl) {
      this.scrollEl.scrollTop = this.headerEl.offsetHeight;
    }
  }

  async toggleMinimized() {
    this.plugin.settings.minimized = !this.plugin.settings.minimized;
    await this.plugin.saveData(this.plugin.settings);
    this.applyMinimized();
  }

  /* ------------------------- Agent picker ------------------------ */

  /** Update the compact route label text/title from the current selection. */
  updateRouteLabel() {
    if (!this.routeNameEl) return;
    const eps = this.enabledEndpoints();
    const ep = eps.find((e) => e.id === this.activeEndpointId) || eps[0];
    const hostLabel = ep ? ep.label : "Host";
    const sid = this.selectedAgentId ? String(this.selectedAgentId) : "";
    const shortId = sid ? sid.slice(0, 8) : "";
    this.routeNameEl.setText(
      shortId ? hostLabel + " · " + shortId : hostLabel + " · All",
    );
    const agent = sid
      ? (Array.isArray(this.liveAgents) ? this.liveAgents : []).find(
          (a) => a && a.hostId === this.activeEndpointId && String(a.id) === sid,
        )
      : null;
    if (this.routeModelEl) {
      const model = agent && agent.model ? String(agent.model) : "";
      this.routeModelEl.setText(model);
      this.routeModelEl.style.display = model ? "" : "none";
    }
    if (this.routeLabel) {
      const modelHint = agent && agent.model ? ` · ${agent.model}` : "";
      this.routeLabel.setAttr(
        "title",
        sid
          ? `Routes to ${hostLabel} agent ${sid}${modelHint} — click to change`
          : `Routes to ${hostLabel} shared queue — click to change`,
      );
    }
  }

  toggleAgentMenu() {
    if (!this.agentMenu) return;
    if (this.agentMenu.hasClass("jefr-open")) this.closeAgentMenu();
    else this.openAgentMenu();
  }

  /** Stable signature of what the menu shows (ids + states + selection). */
  agentMenuSignature() {
    const parts = (Array.isArray(this.liveAgents) ? this.liveAgents : [])
      .map((a) => `${a.hostId}/${a.id}:${a.state}:${a.model || ""}`)
      .sort();
    const connBits = Object.keys(this.conns)
      .sort()
      .map((id) => id + ":" + ((this.conns[id] && this.conns[id].status) || "off"))
      .join(",");
    return `${this.activeEndpointId}|${this.selectedAgentId || ""}|${parts.join(",")}|${connBits}`;
  }

  openAgentMenu() {
    if (!this.agentMenu) return;
    this._agentMenuSig = this.agentMenuSignature();
    this.renderAgentMenu();
    this.agentMenu.addClass("jefr-open");
    this._agentMenuOutside = (e) => {
      const t = e.target;
      if (
        this.agentMenu &&
        !this.agentMenu.contains(t) &&
        this.routeLabel &&
        !this.routeLabel.contains(t)
      ) {
        this.closeAgentMenu();
      }
    };
    window.setTimeout(
      () => document.addEventListener("mousedown", this._agentMenuOutside, true),
      0,
    );
  }

  closeAgentMenu() {
    if (this.agentMenu) this.agentMenu.removeClass("jefr-open");
    if (this._agentMenuOutside) {
      document.removeEventListener("mousedown", this._agentMenuOutside, true);
      this._agentMenuOutside = null;
    }
  }

  renderAgentMenu() {
    if (!this.agentMenu) return;
    this.agentMenu.empty();
    const eps = this.enabledEndpoints();
    const agents = Array.isArray(this.liveAgents) ? this.liveAgents : [];

    for (const ep of eps) {
      const conn = this.conns[ep.id];
      const st = (conn && conn.status) || "offline";
      const head = this.agentMenu.createDiv({ cls: "jefr-agent-host" });
      head.createSpan({
        cls: "jefr-agent-host-name",
        text: ep.label + " · :" + ep.port,
      });
      head.createSpan({
        cls: "jefr-agent-host-st jefr-agent-host-st-" + st,
        text: st === "online" ? "online" : st === "connecting" ? "…" : "off",
      });

      const allRow = this.agentMenu.createDiv({
        cls:
          "jefr-agent-opt" +
          (this.activeEndpointId === ep.id && !this.selectedAgentId
            ? " jefr-agent-opt-active"
            : ""),
      });
      allRow.createSpan({ cls: "jefr-agent-opt-dot" });
      allRow.createSpan({
        cls: "jefr-agent-opt-name",
        text: "All on " + ep.label + " (shared)",
      });
      allRow.onclick = () => this.selectRoute(ep.id, null);

      const hostAgents = agents
        .filter((a) => a && a.hostId === ep.id)
        .slice()
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
      if (!hostAgents.length) {
        this.agentMenu.createDiv({
          cls: "jefr-agent-empty",
          text: st === "online" ? "No live agents" : "Not connected",
        });
      }
      for (const a of hostAgents) {
        const id = a && a.id ? String(a.id) : "";
        if (!id) continue;
        const active =
          this.activeEndpointId === ep.id && String(this.selectedAgentId || "") === id;
        const row = this.agentMenu.createDiv({
          cls: "jefr-agent-opt" + (active ? " jefr-agent-opt-active" : ""),
        });
        const busy = a.state === "working";
        row.createSpan({
          cls: "jefr-agent-opt-dot " + (busy ? "is-busy" : "is-listening"),
        });
        row.createSpan({
          cls: "jefr-agent-opt-name jefr-agent-opt-id",
          text: id.slice(0, 8),
        });
        const meta = [busy ? "busy" : "listening"];
        if (a.model) meta.push(a.model);
        if (typeof a.queueCount === "number" && a.queueCount > 0) {
          meta.push(`${a.queueCount} queued`);
        }
        row.createSpan({ cls: "jefr-agent-opt-meta", text: meta.join(" · ") });
        row.setAttr("title", a.model ? `${ep.label} · ${id} · ${a.model}` : `${ep.label} · ${id}`);
        row.onclick = () => this.selectRoute(ep.id, id);
      }
    }
  }

  /** Switch active host + agent; notify that host's bridge. */
  selectRoute(endpointId, agentId) {
    this.activeEndpointId = endpointId;
    this.selectedAgentId = agentId || null;
    if (this.plugin.settings) {
      this.plugin.settings.activeEndpointId = endpointId;
      const ep = this.enabledEndpoints().find((e) => e.id === endpointId);
      if (ep) {
        this.plugin.settings.host = ep.host;
        this.plugin.settings.port = ep.port;
      }
      void this.plugin.saveData(this.plugin.settings);
    }
    const ws = this.activeWs();
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "selectAgent", agentId: agentId || null }));
    }
    this.refreshAggregateStatus();
    this.updateRouteLabel();
    this.closeAgentMenu();
  }

  selectAgentRemote(id) {
    this.selectRoute(this.activeEndpointId, id);
  }

  /** Cycle routed agent across all hosts (flat order). */
  cycleAgent(dir) {
    const order = [];
    for (const ep of this.enabledEndpoints()) {
      order.push({ endpointId: ep.id, agentId: null });
      const ids = (Array.isArray(this.liveAgents) ? this.liveAgents : [])
        .filter((a) => a && a.hostId === ep.id && a.id)
        .map((a) => String(a.id))
        .sort((a, b) => a.localeCompare(b));
      for (const id of ids) order.push({ endpointId: ep.id, agentId: id });
    }
    if (order.length <= 1) return;
    const curEp = this.activeEndpointId;
    const curAg = this.selectedAgentId ? String(this.selectedAgentId) : null;
    let idx = order.findIndex(
      (o) => o.endpointId === curEp && (o.agentId || null) === curAg,
    );
    if (idx < 0) idx = 0;
    const next = order[(idx + dir + order.length) % order.length];
    this.selectRoute(next.endpointId, next.agentId);
  }

  renderEmptyState() {
    this.messagesEl.empty();
    const empty = this.messagesEl.createDiv({ cls: "jefr-empty" });
    empty.createDiv({ cls: "jefr-empty-icon", text: "✦" });
    empty.createDiv({ cls: "jefr-empty-title", text: "JEFR Chat" });
    empty.createDiv({
      cls: "jefr-empty-sub",
      text: "Send a message to your Cursor agent. Everything here syncs with the jefr panel in Cursor.",
    });
  }

  updateSendState() {
    const hasText = this.input && this.input.value.trim().length > 0;
    const hasAttach = this.attachments.length > 0;
    const ws = this.activeWs();
    const online = !!(ws && ws.readyState === WebSocket.OPEN);
    this.connStatus = online ? "online" : this.connStatus;
    if (this.sendBtn) this.sendBtn.disabled = (!hasText && !hasAttach) || !online;
    if (this.hint) {
      const agent = this.agentStatus;
      let hint;
      if (!online) {
        hint = "Offline — pick a connected host or start Cursor…";
      } else if (agent && agent.alive && agent.state === "working") {
        hint = "Agent busy — message will queue";
      } else if (agent && agent.alive) {
        hint = "Enter to send";
      } else {
        hint = "No agent listening — message will queue";
      }
      this.hint.setText(hint);
    }
  }

  /* --------------------------- Attachments ----------------------- */

  onPaste(e) {
    const dt = e.clipboardData;
    const files = [];
    if (dt) {
      if (dt.files && dt.files.length) {
        files.push(...Array.from(dt.files));
      } else if (dt.items) {
        for (const it of Array.from(dt.items)) {
          if (it.kind === "file") {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
      }
    }
    const imgs = files.filter((f) => f.type && f.type.startsWith("image/"));
    if (imgs.length) {
      e.preventDefault();
      e.stopPropagation();
      this.ingestFiles(imgs);
      return;
    }
    if (files.length) {
      e.preventDefault();
      this.ingestFiles(files);
      return;
    }
    // No file in the payload. Try the native clipboard synchronously so we can
    // block Obsidian before it writes an embed.
    const du = readClipboardImage();
    if (du) {
      e.preventDefault();
      e.stopPropagation();
      this.stageImage(du, "pasted-image.png");
      return;
    }
    // Last resort: let Obsidian save the image + insert an ![[..]] embed, then
    // absorb that embed back into an attachment and strip the text.
    window.setTimeout(() => this.absorbEmbeds(), 40);
  }

  /** Detect ![[file.png]] / ![](file.png) embeds Obsidian inserted on paste,
   *  load those files from the vault, stage them as image attachments, and
   *  remove the embed text from the input. */
  async absorbEmbeds() {
    let val = this.input.value;
    if (!val || val.indexOf("![") === -1) return false;
    const found = [];
    const reWiki = /!\[\[([^\]|]+?\.(?:png|jpe?g|gif|webp|bmp|svg))(?:\|[^\]]*)?\]\]/gi;
    const reMd = /!\[[^\]]*\]\(([^)]+?\.(?:png|jpe?g|gif|webp|bmp|svg))\)/gi;
    let m;
    while ((m = reWiki.exec(val)) !== null) found.push({ full: m[0], link: m[1].trim() });
    while ((m = reMd.exec(val)) !== null) found.push({ full: m[0], link: decodeURIComponent(m[1].trim()) });
    if (!found.length) return false;

    for (const f of found) {
      const file =
        this.app.metadataCache.getFirstLinkpathDest(f.link, "") ||
        this.app.vault.getAbstractFileByPath(f.link);
      if (!file || !("extension" in file)) {
        // Couldn't resolve — still strip the embed text so it isn't sent as junk.
        val = val.split(f.full).join("");
        continue;
      }
      try {
        const buf = await this.app.vault.readBinary(file);
        const ext = (file.extension || "png").toLowerCase();
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : "image/" + ext;
        const dataUrl = "data:" + mime + ";base64," + arrayBufferToBase64(buf);
        this.stageImage(dataUrl, file.name);
      } catch {
        /* ignore */
      }
      val = val.split(f.full).join("");
    }
    this.input.value = val;
    this.updateSendState();
    return true;
  }

  async tryClipboardImage() {
    // 1) Async Clipboard API (works in Chromium/Electron, needs a user gesture).
    try {
      if (navigator.clipboard && navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = (item.types || []).find((t) => t.startsWith("image/"));
          if (type) {
            const blob = await item.getType(type);
            const dataUrl = await blobToDataUrl(blob);
            if (dataUrl) {
              this.stageImage(dataUrl, "pasted-image.png");
              return true;
            }
          }
        }
      }
    } catch {
      /* fall through */
    }
    // 2) Native Electron clipboard bitmap (screenshots / copied image data).
    const du = readClipboardImage();
    if (du) {
      this.stageImage(du, "pasted-image.png");
      return true;
    }
    // 3) Copied image FILE(s) — clipboard holds file paths (text/uri-list).
    const fileImgs = readClipboardFileImages();
    if (fileImgs.length) {
      for (const fi of fileImgs) this.stageImage(fi.dataUrl, fi.name);
      return true;
    }
    return false;
  }

  stageImage(dataUrl, name) {
    if (!dataUrl) return;
    // De-dupe: paste event + keydown + clipboard read can fire for one paste.
    if (this.attachments.some((a) => a.dataUrl === dataUrl)) return;
    this.attachments.push({ id: makeId(), name: name || "pasted-image", dataUrl });
    this.renderAttachments();
    this.updateSendState();
  }

  ingestFiles(files) {
    for (const file of files) {
      if (file.type && file.type.startsWith("image/")) {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = String(ev.target && ev.target.result ? ev.target.result : "");
          this.stageImage(dataUrl, file.name || "pasted-image");
        };
        reader.readAsDataURL(file);
      } else {
        // Non-image: inline a text preview into the composer (no binary upload).
        const reader = new FileReader();
        reader.onload = (ev) => {
          const content = String(ev.target && ev.target.result ? ev.target.result : "");
          const preview = content.length > 4000 ? content.slice(0, 4000) + "\n…(truncated)" : content;
          const snippet = `[File: ${file.name}]\n${preview}`;
          this.input.value = this.input.value ? this.input.value + "\n" + snippet : snippet;
          this.updateSendState();
        };
        reader.readAsText(file);
      }
    }
  }

  renderAttachments() {
    if (!this.attachBar) return;
    this.attachBar.empty();
    for (const a of this.attachments) {
      const chip = this.attachBar.createDiv({ cls: "jefr-attach-chip" });
      const img = chip.createEl("img", { cls: "jefr-attach-thumb", attr: { src: a.dataUrl, alt: a.name } });
      void img;
      const rm = chip.createEl("button", { cls: "jefr-attach-remove", text: "×", attr: { "aria-label": "Remove" } });
      rm.onclick = () => {
        this.attachments = this.attachments.filter((x) => x.id !== a.id);
        this.renderAttachments();
        this.updateSendState();
      };
    }
  }

  setStatus(status) {
    this.connStatus = status;
    this.refreshAggregateStatus();
  }

  /** Roll up per-endpoint socket status into the header pill. */
  refreshAggregateStatus() {
    if (!this.statusPill) return;
    const eps = this.enabledEndpoints();
    let online = 0;
    let connecting = 0;
    const bits = [];
    for (const ep of eps) {
      const st = (this.conns[ep.id] && this.conns[ep.id].status) || "offline";
      if (st === "online") online++;
      else if (st === "connecting") connecting++;
      bits.push(ep.label + ":" + st);
    }
    this.statusPill.removeClass(
      "jefr-status-online",
      "jefr-status-offline",
      "jefr-status-connecting",
    );
    if (online > 0) {
      this.connStatus = "online";
      this.statusPill.addClass("jefr-status-online");
      this.statusPill.setText(
        eps.length > 1 ? `Online ${online}/${eps.length}` : "Online",
      );
    } else if (connecting > 0) {
      this.connStatus = "connecting";
      this.statusPill.addClass("jefr-status-connecting");
      this.statusPill.setText("Connecting…");
    } else {
      this.connStatus = "offline";
      this.statusPill.addClass("jefr-status-offline");
      this.statusPill.setText("Offline");
    }
    this.statusPill.setAttr("title", bits.join(" · ") || "No endpoints");
    // Agent pill is updated from handleState for the active host only
    // (avoids the other host's pushes flipping Listening/Busy).
    const active = this.conns[this.activeEndpointId];
    if (this.workspaceLine) {
      const ep = eps.find((e) => e.id === this.activeEndpointId);
      const wsInfo = active && active.workspace;
      const name = (wsInfo && wsInfo.name) || (ep && ep.label) || "";
      const path = (wsInfo && wsInfo.path) || "";
      this.workspaceLine.setText(name ? `${ep ? ep.label + " · " : ""}${name}` : ep ? ep.label : "");
      this.workspaceLine.setAttr("title", path || (ep ? ep.host + ":" + ep.port : ""));
    }
    // Queue badge = active host queue
    this.lastQueue = (active && active.queue) || [];
    const count =
      active && typeof active.queueCount === "number"
        ? active.queueCount
        : this.lastQueue.length;
    if (this.queueBadge) {
      this.queueBadge.setText(count > 0 ? `${count} queued` : "");
      this.queueBadge.toggleClass("jefr-has-queue", count > 0);
    }
    this.updateSendState();
  }

  setAgentStatus(agent) {
    this.agentStatus = agent || null;
    // Debounce pill updates — multi-host state pushes + check_messages
    // waiting↔working chatter was making Listening/Busy flicker constantly.
    const alive = !!(agent && agent.alive);
    const busy = alive && agent.state === "working";
    const nextKey = !alive ? "idle" : busy ? "busy" : "ready";
    if (nextKey === this._agentPillKey) return;
    if (this._agentPillTimer) {
      clearTimeout(this._agentPillTimer);
      this._agentPillTimer = null;
    }
    const apply = () => {
      this._agentPillTimer = null;
      this._agentPillKey = nextKey;
      if (!this.agentPill) return;
      this.agentPill.removeClass("jefr-agent-ready", "jefr-agent-busy", "jefr-agent-idle");
      if (nextKey === "busy") {
        this.agentPill.addClass("jefr-agent-busy");
        this.agentPill.setText("Agent busy");
        this.agentPill.setAttr(
          "title",
          "An agent is alive but mid-task — messages will queue until it listens again",
        );
      } else if (nextKey === "ready") {
        this.agentPill.addClass("jefr-agent-ready");
        this.agentPill.setText("Agent listening");
        this.agentPill.setAttr(
          "title",
          "An agent is actively waiting — your message is picked up immediately",
        );
      } else {
        this.agentPill.addClass("jefr-agent-idle");
        this.agentPill.setText("No agent");
        this.agentPill.setAttr(
          "title",
          "No agent is running the loop — messages queue until one calls check_messages",
        );
      }
      if (this.routeLabel) {
        this.routeLabel.removeClass("jefr-route-ready", "jefr-route-busy", "jefr-route-idle");
        if (nextKey === "busy") this.routeLabel.addClass("jefr-route-busy");
        else if (nextKey === "ready") this.routeLabel.addClass("jefr-route-ready");
        else this.routeLabel.addClass("jefr-route-idle");
      }
      this.updateSendState();
    };
    // Promote to busy / idle immediately; only delay busy→listening so brief
    // gaps between check_messages calls don't flicker the pill.
    if (nextKey === "ready" && this._agentPillKey === "busy") {
      this._agentPillTimer = window.setTimeout(apply, 1200);
    } else {
      apply();
    }
  }

  /* --------------------------- Messaging ------------------------- */

  hasContent() {
    return this.messagesEl && !this.messagesEl.querySelector(".jefr-empty");
  }

  ensureMessagesReady() {
    if (!this.hasContent()) this.messagesEl.empty();
  }

  scrollToBottom() {
    const el = this.scrollEl || this.messagesEl;
    if (el) el.scrollTop = el.scrollHeight;
  }

  addUserBubble(text) {
    this.ensureMessagesReady();
    const row = this.messagesEl.createDiv({ cls: "jefr-row jefr-row-user" });
    const bubble = row.createDiv({ cls: "jefr-bubble jefr-bubble-user" });
    bubble.createDiv({ cls: "jefr-bubble-text", text });
    bubble.createDiv({ cls: "jefr-bubble-time", text: nowTime() });
    this.trimHistory();
    this.scrollToBottom();
  }

  async addReplyBubble(content) {
    this.ensureMessagesReady();
    const row = this.messagesEl.createDiv({ cls: "jefr-row jefr-row-ai" });
    const bubble = row.createDiv({ cls: "jefr-bubble jefr-bubble-ai" });
    const md = bubble.createDiv({ cls: "jefr-bubble-md markdown-rendered" });
    await renderMd(this, content, md);
    bubble.createDiv({ cls: "jefr-bubble-time", text: nowTime() });
    this.trimHistory();
    this.scrollToBottom();
  }

  renderSharedHistory(items) {
    for (const it of items) {
      if (!it || !it.id || this.renderedIds.has(it.id)) continue;
      this.renderedIds.add(it.id);
      if (it.kind === "reply") {
        this.addReplyBubble(it.text || "");
      } else if (it.kind === "image" && ((it.images && it.images.length) || it.dataUrl)) {
        const imgs = it.images && it.images.length ? it.images : [{ dataUrl: it.dataUrl, name: it.name }];
        this.addImageBubble(imgs, it.caption);
      } else if (it.kind === "image" || it.kind === "file") {
        this.addUserBubble(it.caption || it.name || it.text || "[" + it.kind + "]");
      } else {
        this.addUserBubble(it.text || "");
      }
    }
  }

  addImageBubble(images, caption) {
    this.ensureMessagesReady();
    // Backward compatible: accept a single (dataUrl, name, caption) call too.
    let imgs = images;
    if (typeof images === "string") {
      imgs = [{ dataUrl: images, name: caption }];
      caption = arguments[2];
    }
    const row = this.messagesEl.createDiv({ cls: "jefr-row jefr-row-user" });
    const bubble = row.createDiv({ cls: "jefr-bubble jefr-bubble-user jefr-bubble-image" });
    for (const im of imgs || []) {
      if (im && im.dataUrl) {
        bubble.createEl("img", { cls: "jefr-msg-img", attr: { src: im.dataUrl, alt: im.name || "image" } });
      }
    }
    if (caption) bubble.createDiv({ cls: "jefr-bubble-text", text: caption });
    bubble.createDiv({ cls: "jefr-bubble-time", text: nowTime() });
    this.trimHistory();
    this.scrollToBottom();
  }

  addSystemNote(text) {
    this.ensureMessagesReady();
    const row = this.messagesEl.createDiv({ cls: "jefr-row jefr-row-system" });
    row.createDiv({ cls: "jefr-system-note", text });
    this.scrollToBottom();
  }

  trimHistory() {
    const max = this.plugin.settings.maxHistory || 400;
    while (this.messagesEl.children.length > max) {
      this.messagesEl.removeChild(this.messagesEl.firstChild);
    }
  }

  clearHistory() {
    this.renderEmptyState();
  }

  doSend() {
    const text = this.input.value.trim();
    const attachments = this.attachments.slice();
    if (!text && attachments.length === 0) return;
    const ws = this.activeWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      new Notice("jefr is offline on the selected host — check Local/VPS connection.");
      return;
    }
    try {
      if (attachments.length) {
        this.queueSend({
          type: "sendImages",
          dataUrls: attachments.map((a) => a.dataUrl),
          caption: text,
        });
      } else if (text) {
        this.queueSend({ type: "sendText", text });
      }
    } catch (e) {
      new Notice("jefr: failed to send message.");
      return;
    }
    this.pushSentHistory(text);
    this.input.value = "";
    this.attachments = [];
    this.renderAttachments();
    this.updateSendState();
    this.input.focus();
  }

  /* --------------------------- Questions ------------------------- */

  renderQuestion(q) {
    if (!q || !q.questions || !q.questions.length) {
      this.clearQuestionUi();
      return;
    }
    // Stale rebroadcast after we already answered/cancelled this id.
    if (this._dismissedQuestionId && q.id === this._dismissedQuestionId) {
      return;
    }
    // New question — drop any prior dismiss suppress.
    if (this._dismissedQuestionId && q.id !== this._dismissedQuestionId) {
      this._dismissedQuestionId = null;
    }
    // Don't wipe/re-render an already-shown question when other state updates
    // (queue count, reply, etc.) arrive — that was clearing the visible card.
    if (q.id === this.currentQuestionId) return;
    this.currentQuestionId = q.id;
    this.pendingQuestion = q;
    this.selected = {};
    this.closeQuestionModal({ keepChip: false });
    this.questionEl.empty();

    const compact = !!this.plugin.settings.minimized;
    if (compact) {
      // Compact pane is too narrow for option lists — open a wide modal and
      // leave a slim dock chip so the user can reopen if they dismiss it.
      this.renderQuestionChip(q);
      this.openQuestionModal(q);
    } else {
      this.mountQuestionCard(this.questionEl, q, { inModal: false });
      this.bindQuestionKeys(q);
      this.scrollToBottom();
    }
  }

  /** Slim dock banner shown in compact mode while a question is pending. */
  renderQuestionChip(q) {
    this.questionEl.empty();
    const chip = this.questionEl.createDiv({ cls: "jefr-qchip" });
    const left = chip.createDiv({ cls: "jefr-qchip-left" });
    left.createSpan({ cls: "jefr-qchip-title", text: "Agent question" });
    left.createSpan({ cls: "jefr-qchip-badge", text: "Awaiting" });
    const btn = chip.createEl("button", {
      cls: "jefr-btn jefr-btn-send jefr-qchip-btn",
      text: "Answer",
    });
    btn.onclick = () => this.openQuestionModal(q);
  }

  openQuestionModal(q) {
    if (!q) return;
    if (this.questionModal) {
      const prev = this.questionModal;
      // Null first so onClose does not treat this as a user dismiss.
      this.questionModal = null;
      prev.close();
    }
    const modal = new JefrQuestionModal(this.app, this, q);
    this.questionModal = modal;
    this.renderQuestionChip(q);
    modal.open();
  }

  /**
   * @param {{ keepChip?: boolean }} [opts]
   * keepChip: leave the dock chip (user dismissed modal without answering).
   */
  closeQuestionModal(opts) {
    const keepChip = !!(opts && opts.keepChip);
    const modal = this.questionModal;
    if (!modal) {
      if (!keepChip) this.questionMount = null;
      return;
    }
    this.questionModal = null;
    modal.close();
    if (!keepChip) this.questionMount = null;
  }

  clearQuestionUi() {
    this.removeQuestionKeyHandler();
    this.closeQuestionModal({ keepChip: false });
    this.questionEl.empty();
    this.currentQuestionId = null;
    this.currentQuestionEndpointId = null;
    this.pendingQuestion = null;
    this.questionMount = null;
  }

  /**
   * Build the question UI into `host` (in-pane card or modal body).
   * @param {{ inModal?: boolean }} opts
   */
  mountQuestionCard(host, q, opts) {
    const inModal = !!(opts && opts.inModal);
    host.empty();
    this.questionMount = host;

    const card = host.createDiv({ cls: "jefr-qcard" + (inModal ? " jefr-qcard-modal" : "") });
    if (!inModal) {
      const head = card.createDiv({ cls: "jefr-qcard-head" });
      head.createSpan({ cls: "jefr-qcard-title", text: "Agent question" });
      head.createSpan({ cls: "jefr-qcard-badge", text: "Awaiting answer" });
    } else {
      const head = card.createDiv({ cls: "jefr-qcard-head jefr-qcard-head-modal" });
      head.createSpan({ cls: "jefr-qcard-badge", text: "Awaiting answer" });
    }

    const body = card.createDiv({ cls: "jefr-qcard-body" });
    for (const qi of q.questions) {
      if (!this.selected[qi.id]) this.selected[qi.id] = [];
      const block = body.createDiv({ cls: "jefr-qblock" });
      block.createDiv({ cls: "jefr-qtext", text: qi.question });
      const optsEl = block.createDiv({ cls: "jefr-qopts" });
      for (const opt of qi.options || []) {
        const selected = (this.selected[qi.id] || []).indexOf(opt.id) > -1;
        const optEl = optsEl.createDiv({
          cls:
            "jefr-qopt" +
            (qi.allow_multiple ? " jefr-multi" : "") +
            (selected ? " jefr-selected" : ""),
        });
        optEl.createSpan({ cls: "jefr-qcheck" });
        optEl.createSpan({ cls: "jefr-qopt-label", text: opt.label });
        optEl.onclick = () => this.toggleOption(qi, opt.id, optEl, optsEl);
      }
      block.createEl("input", {
        cls: "jefr-qother",
        attr: {
          type: "text",
          placeholder: "Additional notes (Enter to submit)",
          "data-qid": qi.id,
        },
      });
    }

    const actions = card.createDiv({ cls: "jefr-qactions" });
    const cancel = actions.createEl("button", { cls: "jefr-btn jefr-btn-ghost", text: "Cancel" });
    cancel.onclick = () => this.cancelQuestion();
    const submit = actions.createEl("button", { cls: "jefr-btn jefr-btn-send", text: "Submit answer" });
    submit.onclick = () => this.submitQuestion(q);
  }

  bindQuestionKeys(q) {
    // Enter (anywhere except the main message box) submits the question; Shift+
    // Enter is left alone. Registered while the card is shown and torn down on
    // submit / cancel / replace so it never lingers or double-fires.
    this.removeQuestionKeyHandler();
    const onKey = (e) => {
      if (e.key !== "Enter" || e.shiftKey) return;
      const ae = document.activeElement;
      if (ae && ae.classList && ae.classList.contains("jefr-input")) return;
      e.preventDefault();
      this.submitQuestion(q);
    };
    document.addEventListener("keydown", onKey, true);
    this._removeQuestionKey = () =>
      document.removeEventListener("keydown", onKey, true);
  }

  removeQuestionKeyHandler() {
    if (this._removeQuestionKey) {
      this._removeQuestionKey();
      this._removeQuestionKey = null;
    }
  }

  toggleOption(qi, optId, optEl, optsContainer) {
    let arr = this.selected[qi.id] || [];
    const idx = arr.indexOf(optId);
    if (qi.allow_multiple) {
      if (idx > -1) arr.splice(idx, 1);
      else arr.push(optId);
    } else {
      arr = idx > -1 ? [] : [optId];
      optsContainer.querySelectorAll(".jefr-qopt").forEach((el) => el.removeClass("jefr-selected"));
    }
    this.selected[qi.id] = arr;
    optEl.toggleClass("jefr-selected", arr.indexOf(optId) > -1);
  }

  submitQuestion(q) {
    if (!q || this.currentQuestionId !== q.id) return;
    const ws = this.activeWs();
    const epId = this.currentQuestionEndpointId || this.activeEndpointId;
    const c = this.conns[epId];
    const sock = (c && c.ws) || ws;
    if (!sock || sock.readyState !== WebSocket.OPEN) {
      new Notice("jefr is offline.");
      return;
    }
    const root = this.questionMount || this.questionEl;
    const answers = [];
    for (const qi of q.questions) {
      const otherEl = root.querySelector(`.jefr-qother[data-qid="${qi.id}"]`);
      answers.push({
        questionId: qi.id,
        selected: this.selected[qi.id] || [],
        other: otherEl ? otherEl.value.trim() : "",
      });
    }
    sock.send(JSON.stringify({ type: "submitAnswer", data: { id: q.id, answers } }));
    this._dismissedQuestionId = q.id;
    this.addSystemNote("Answer submitted");
    this.clearQuestionUi();
  }

  cancelQuestion() {
    const epId = this.currentQuestionEndpointId || this.activeEndpointId;
    const c = this.conns[epId];
    if (this.currentQuestionId) this._dismissedQuestionId = this.currentQuestionId;
    if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(JSON.stringify({ type: "cancelQuestion" }));
    }
    this.addSystemNote("Question cancelled");
    this.clearQuestionUi();
  }

  /* ----------------------- Inbound state ------------------------- */

  async handleResponseLog(m) {
    const markdown = m && typeof m.markdown === "string" ? m.markdown : "";
    if (!markdown.trim()) return;
    const rel =
      (this.plugin.settings.logNotifyPath || "").trim() ||
      "_Vault/MCP Response Log.md";
    try {
      await writeVaultMarkdown(this.app, rel, markdown);
    } catch (e) {
      console.error("[jefr] responseLog write failed", e);
      new Notice(
        "jefr: failed to write Response Log — " +
          (e && e.message ? e.message : e),
      );
    }
  }

  handleState(d, endpointId) {
    const epId = endpointId || this.activeEndpointId;
    const conn = this.conns[epId];
    if (!conn) return;

    conn.agent = d.agent || null;
    conn.agents = Array.isArray(d.agents) ? d.agents : [];
    conn.selectedAgentId = d.selectedAgentId || null;
    conn.queue = Array.isArray(d.queue) ? d.queue : [];
    conn.queueCount =
      typeof d.queueCount === "number" ? d.queueCount : conn.queue.length;
    if (d.workspace) conn.workspace = d.workspace;
    conn.question = d.question || null;

    // Rebuild merged agent list for the picker.
    this.rebuildLiveAgents();

    // If this is the active host, mirror selection from bridge when it matches.
    if (epId === this.activeEndpointId && d.selectedAgentId !== undefined) {
      // Keep local host choice; only sync agent id from this host's bridge.
      this.selectedAgentId = d.selectedAgentId || null;
    }

    this.refreshAggregateStatus();
    this.updateRouteLabel();
    // Drive agent pill only from the active host (debounce lives in setAgentStatus).
    if (epId === this.activeEndpointId) {
      this.setAgentStatus(conn.agent || null);
    } else if (!this.conns[this.activeEndpointId] || this.conns[this.activeEndpointId].status !== "online") {
      this.setAgentStatus(null);
    }
    if (this.agentMenu && this.agentMenu.hasClass("jefr-open")) {
      const sig = this.agentMenuSignature();
      if (sig !== this._agentMenuSig) {
        this._agentMenuSig = sig;
        this.renderAgentMenu();
      }
    }

    // Questions: prefer active host; otherwise show from any host that asks.
    if (d.question) {
      // Ignore stale question still on disk after we already submitted/cancelled.
      if (this._dismissedQuestionId && d.question.id === this._dismissedQuestionId) {
        /* keep suppressed until question file is cleared */
      } else if (epId === this.activeEndpointId || !this.currentQuestionId) {
        this.currentQuestionEndpointId = epId;
        if (epId !== this.activeEndpointId) {
          this.activeEndpointId = epId;
        }
        this.renderQuestion(d.question);
      }
    } else if (
      this.currentQuestionId &&
      this.currentQuestionEndpointId === epId
    ) {
      this.clearQuestionUi();
    } else if (
      this._dismissedQuestionId &&
      this.currentQuestionEndpointId === epId
    ) {
      // Server finally dropped the question we already answered.
      this._dismissedQuestionId = null;
    }

    // Shared history — prefix ids with host so Local/VPS don't collide.
    if (Array.isArray(d.history)) {
      const tagged = d.history.map((it) => {
        if (!it || !it.id) return it;
        return Object.assign({}, it, { id: epId + ":" + it.id });
      });
      this.renderSharedHistory(tagged);
    }

    if (d.reply && d.reply.content) {
      const ts = epId + ":" + (d.reply.timestamp || "");
      if (ts !== this.lastReplyTs) {
        this.lastReplyTs = ts;
        if (typeof d.reply.percent === "number") {
          this.updateProgress(d.reply.percent, d.reply.content);
        } else {
          this.hideProgress();
        }
      }
    }
  }

  rebuildLiveAgents() {
    const out = [];
    for (const ep of this.enabledEndpoints()) {
      const conn = this.conns[ep.id];
      const list = (conn && conn.agents) || [];
      for (const a of list) {
        if (!a || !a.id) continue;
        out.push(
          Object.assign({}, a, {
            hostId: ep.id,
            hostLabel: ep.label,
          }),
        );
      }
    }
    this.liveAgents = out;
  }

  toggleQueuePanel() {
    if (this.queueOpen) this.closeQueuePanel();
    else this.openQueuePanel();
  }

  openQueuePanel() {
    if (!this.queuePanel) return;
    const items = this.lastQueue || [];
    if (!items.length) return; // nothing queued
    this.queueOpen = true;
    this.renderQueuePanel();
    this.queuePanel.addClass("jefr-open");
  }

  closeQueuePanel() {
    this.queueOpen = false;
    if (this.queuePanel) this.queuePanel.removeClass("jefr-open");
  }

  renderQueuePanel() {
    if (!this.queuePanel) return;
    this.queuePanel.empty();
    const items = this.lastQueue || [];
    const head = this.queuePanel.createDiv({ cls: "jefr-queue-head" });
    head.createSpan({ text: items.length + " message" + (items.length === 1 ? "" : "s") + " queued" });
    if (items.length > 0) {
      const clearBtn = head.createEl("button", { cls: "jefr-queue-clear", text: "Clear all" });
      clearBtn.onclick = () => this.clearQueueAll();
    }
    for (const it of items) {
      const row = this.queuePanel.createDiv({ cls: "jefr-queue-row" });
      const type = it.type || "text";
      let preview;
      if (type === "image") {
        const n = it.images && it.images.length ? it.images.length : 1;
        const label = n > 1 ? "[" + n + " images]" : "[Image]";
        preview = it.caption ? label + " " + it.caption : label;
      }
      else if (type === "file") preview = "[File] " + (it.path ? it.path.split(/[\\/]/).pop() : "");
      else preview = (it.content || "").replace(/\s+/g, " ").trim();
      row.createSpan({ cls: "jefr-queue-type jefr-qt-" + type, text: type });
      row.createSpan({ cls: "jefr-queue-text", text: preview.length > 120 ? preview.slice(0, 120) + "…" : preview });
      const del = row.createEl("button", { cls: "jefr-queue-del", attr: { "aria-label": "Delete this queued message" } });
      del.setText("×");
      del.onclick = (e) => {
        e.stopPropagation();
        this.deleteQueueItem(it.id);
      };
    }
  }

  recallHistory(dir) {
    const hist = this.sentHistory || (this.sentHistory = []);
    if (!hist.length) return;
    if (this.historyIndex == null) this.historyIndex = -1;
    if (this.historyIndex === -1) {
      // Entering history navigation: stash the current draft to restore later.
      this.historyDraft = this.input.value;
    }
    if (dir < 0) {
      this.historyIndex =
        this.historyIndex === -1 ? hist.length - 1 : Math.max(0, this.historyIndex - 1);
    } else {
      if (this.historyIndex === -1) return;
      this.historyIndex += 1;
      if (this.historyIndex >= hist.length) {
        // Past the newest entry: restore the draft and leave history mode.
        this.historyIndex = -1;
        this.input.value = this.historyDraft || "";
        this.placeCaretEnd();
        this.updateSendState();
        return;
      }
    }
    this.input.value = hist[this.historyIndex];
    this.placeCaretEnd();
    this.updateSendState();
  }

  placeCaretEnd() {
    const len = this.input.value.length;
    try {
      this.input.setSelectionRange(len, len);
    } catch (e) {
      /* ignore */
    }
  }

  pushSentHistory(text) {
    if (!text) return;
    this.sentHistory = this.sentHistory || [];
    if (this.sentHistory[this.sentHistory.length - 1] !== text) {
      this.sentHistory.push(text);
    }
    if (this.sentHistory.length > 100) this.sentHistory.shift();
    this.historyIndex = -1;
    this.historyDraft = "";
  }

  deleteQueueItem(id) {
    if (!id) return;
    const ws = this.activeWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      new Notice("jefr is offline — can't delete right now.");
      return;
    }
    try {
      ws.send(JSON.stringify({ type: "deleteQueueItem", id }));
    } catch (e) {
      new Notice("jefr: failed to delete queued message.");
    }
  }

  clearQueueAll() {
    const ws = this.activeWs();
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      new Notice("jefr is offline — can't clear right now.");
      return;
    }
    try {
      ws.send(JSON.stringify({ type: "clearQueue" }));
    } catch (e) {
      new Notice("jefr: failed to clear queue.");
    }
  }

  /* ----- Reliable sends on the active endpoint ----- */

  genCid() {
    this._cidSeq = (this._cidSeq || 0) + 1;
    return Date.now().toString(36) + "-" + this._cidSeq;
  }

  queueSend(payload) {
    this.pending = this.pending || new Map();
    const cid = this.genCid();
    payload.cid = cid;
    this.pending.set(cid, {
      payload,
      attempts: 0,
      endpointId: this.activeEndpointId,
    });
    this.flushSend(cid);
  }

  flushSend(cid) {
    const entry = this.pending && this.pending.get(cid);
    if (!entry) return;
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.attempts > 5) {
      this.pending.delete(cid);
      if (this._ackTimers && this._ackTimers.has(cid)) {
        clearTimeout(this._ackTimers.get(cid));
        this._ackTimers.delete(cid);
      }
      new Notice("jefr: couldn't confirm a message was delivered — try reloading Cursor.");
      return;
    }
    const c = this.conns[entry.endpointId || this.activeEndpointId];
    const ws = c && c.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(entry.payload));
      } catch (e) {
        /* retry via watchdog */
      }
    }
    this._ackTimers = this._ackTimers || new Map();
    if (this._ackTimers.has(cid)) return;
    const t = window.setTimeout(() => {
      this._ackTimers.delete(cid);
      if (this.pending && this.pending.has(cid)) {
        this.recoverConnection(entry.endpointId);
      }
    }, 3000);
    this._ackTimers.set(cid, t);
  }

  flushPending(endpointId) {
    if (!this.pending || !this.pending.size) return;
    for (const cid of Array.from(this.pending.keys())) {
      const entry = this.pending.get(cid);
      if (!endpointId || (entry && entry.endpointId === endpointId)) {
        this.flushSend(cid);
      }
    }
  }

  ackSend(cid) {
    if (this.pending) this.pending.delete(cid);
    if (this._ackTimers && this._ackTimers.has(cid)) {
      clearTimeout(this._ackTimers.get(cid));
      this._ackTimers.delete(cid);
    }
  }

  recoverConnection(endpointId) {
    const id = endpointId || this.activeEndpointId;
    const c = this.conns[id];
    if (!c || c._recovering) return;
    c._recovering = true;
    try {
      if (c.ws) c.ws.close();
    } catch (e) {
      /* ignore */
    }
    window.setTimeout(() => {
      if (c) c._recovering = false;
    }, 1500);
  }

  updateProgress(pct, label) {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    if (this.progressWrap) this.progressWrap.style.display = "";
    if (this.progressFill) this.progressFill.style.width = p + "%";
    if (this.progressLabel) {
      const line = (label || "").split("\n")[0].replace(/^#+\s*/, "").trim();
      this.progressLabel.setText(p + "%" + (line ? " · " + (line.length > 60 ? line.slice(0, 60) + "…" : line) : ""));
    }
    if (this._progressHideTimer) {
      clearTimeout(this._progressHideTimer);
      this._progressHideTimer = null;
    }
    if (p >= 100) {
      this._progressHideTimer = window.setTimeout(() => this.hideProgress(), 2500);
    }
  }

  hideProgress() {
    if (this._progressHideTimer) {
      clearTimeout(this._progressHideTimer);
      this._progressHideTimer = null;
    }
    if (this.progressWrap) this.progressWrap.style.display = "none";
    if (this.progressFill) this.progressFill.style.width = "0%";
  }

  /* --------------------------- Socket (multi-host) --------------- */

  connectAll() {
    this.manualClose = false;
    const eps = this.enabledEndpoints();
    if (!eps.length) {
      this.refreshAggregateStatus();
      return;
    }
    if (!eps.some((e) => e.id === this.activeEndpointId)) {
      this.activeEndpointId = eps[0].id;
    }
    for (const ep of eps) this.connectOne(ep);
    this.refreshAggregateStatus();
    this.updateRouteLabel();
  }

  connectOne(ep) {
    if (!ep || !ep.id) return;
    let conn = this.conns[ep.id];
    if (!conn) {
      conn = {
        ep,
        ws: null,
        status: "offline",
        reconnectAttempts: 0,
        reconnectTimer: null,
        pingTimer: null,
        awaitingPong: false,
        agent: null,
        agents: [],
        selectedAgentId: null,
        queue: [],
        queueCount: 0,
        workspace: null,
        question: null,
      };
      this.conns[ep.id] = conn;
    } else {
      conn.ep = ep;
    }
    if (conn.ws) return;

    const url = `ws://${ep.host}:${ep.port}`;
    conn.status = "connecting";
    this.refreshAggregateStatus();

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.scheduleReconnect(ep.id);
      return;
    }
    conn.ws = ws;
    const endpointId = ep.id;

    ws.onopen = () => {
      const c = this.conns[endpointId];
      if (!c || c.ws !== ws) return;
      c.reconnectAttempts = 0;
      c.awaitingPong = false;
      c.status = "online";
      this.startPing(endpointId);
      this.flushPending(endpointId);
      this.refreshAggregateStatus();
      this.updateRouteLabel();
    };

    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === "init" || m.type === "stateUpdate") {
        this.handleState(m, endpointId);
      } else if (m.type === "responseLog") {
        void this.handleResponseLog(m);
      } else if (m.type === "queueUpdate") {
        const c = this.conns[endpointId];
        if (c) {
          c.queueCount = m.count || 0;
          if (endpointId === this.activeEndpointId) this.refreshAggregateStatus();
        }
      } else if (m.type === "sendAck") {
        this.ackSend(m.cid);
      } else if (m.type === "pong") {
        const c = this.conns[endpointId];
        if (c) c.awaitingPong = false;
      }
    };

    ws.onclose = () => {
      const c = this.conns[endpointId];
      if (!c) return;
      this.stopPing(endpointId);
      c.ws = null;
      c.status = "offline";
      this.refreshAggregateStatus();
      if (!this.manualClose && this.plugin.settings.autoReconnect) {
        this.scheduleReconnect(endpointId);
      }
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  scheduleReconnect(endpointId) {
    const c = this.conns[endpointId];
    if (!c || c.reconnectTimer) return;
    c.reconnectAttempts = (c.reconnectAttempts || 0) + 1;
    const delay = Math.min(1000 * Math.pow(1.5, c.reconnectAttempts - 1), 30000);
    c.reconnectTimer = setTimeout(() => {
      c.reconnectTimer = null;
      const ep =
        this.enabledEndpoints().find((e) => e.id === endpointId) || c.ep;
      if (ep && ep.enabled !== false) this.connectOne(ep);
    }, delay);
  }

  startPing(endpointId) {
    this.stopPing(endpointId);
    const c = this.conns[endpointId];
    if (!c) return;
    c.awaitingPong = false;
    c.pingTimer = setInterval(() => {
      const conn = this.conns[endpointId];
      if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;
      if (conn.awaitingPong) {
        conn.awaitingPong = false;
        this.recoverConnection(endpointId);
        return;
      }
      try {
        conn.ws.send(JSON.stringify({ type: "ping" }));
        conn.awaitingPong = true;
      } catch {
        /* ignore */
      }
    }, 12000);
  }

  stopPing(endpointId) {
    const c = this.conns[endpointId];
    if (c && c.pingTimer) {
      clearInterval(c.pingTimer);
      c.pingTimer = null;
    }
  }

  teardownAll() {
    this.manualClose = true;
    for (const id of Object.keys(this.conns)) {
      this.teardownOne(id);
    }
    this.refreshAggregateStatus();
  }

  teardownOne(endpointId) {
    const c = this.conns[endpointId];
    if (!c) return;
    this.stopPing(endpointId);
    if (c.reconnectTimer) {
      clearTimeout(c.reconnectTimer);
      c.reconnectTimer = null;
    }
    if (c.ws) {
      try {
        c.ws.close();
      } catch {
        /* ignore */
      }
      c.ws = null;
    }
    c.status = "offline";
  }

  /** @deprecated */
  connect() {
    this.connectAll();
  }

  /** @deprecated */
  teardownSocket() {
    this.teardownAll();
  }
}

/* ------------------------------------------------------------------ */
/* Settings tab                                                        */
/* ------------------------------------------------------------------ */

class JefrSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    this.plugin.settings = migrateSettings(this.plugin.settings);

    containerEl.createEl("h3", { text: "Endpoints (multi-host)" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Obsidian runs locally and can talk to several jefr bridges at once (e.g. Local :39517 and VPS forward :39518). Pick the route in the chat picker.",
    });

    const endpoints = this.plugin.settings.endpoints || [];
    endpoints.forEach((ep, idx) => {
      new Setting(containerEl)
        .setName(ep.label || ep.id || "Endpoint " + (idx + 1))
        .setDesc("id: " + ep.id)
        .addToggle((tg) =>
          tg.setValue(ep.enabled !== false).onChange(async (v) => {
            ep.enabled = v;
            await this.plugin.saveSettings();
            this.display();
          }),
        )
        .addText((t) =>
          t
            .setPlaceholder("Label")
            .setValue(ep.label || "")
            .onChange(async (v) => {
              ep.label = (v || "").trim() || ep.id;
              await this.plugin.saveSettings();
            }),
        )
        .addText((t) =>
          t
            .setPlaceholder("127.0.0.1")
            .setValue(ep.host || "127.0.0.1")
            .onChange(async (v) => {
              ep.host = (v || "").trim() || "127.0.0.1";
              await this.plugin.saveSettings();
            }),
        )
        .addText((t) =>
          t
            .setPlaceholder("39517")
            .setValue(String(ep.port || 39517))
            .onChange(async (v) => {
              const n = parseInt(v, 10);
              ep.port = Number.isFinite(n) && n > 0 ? n : 39517;
              await this.plugin.saveSettings();
            }),
        );
    });

    new Setting(containerEl)
      .setName("Add endpoint")
      .setDesc("Another ws://host:port bridge (usually another LocalForward port).")
      .addButton((b) =>
        b.setButtonText("Add").onClick(async () => {
          const n = (this.plugin.settings.endpoints || []).length + 1;
          this.plugin.settings.endpoints.push({
            id: "ep" + n,
            label: "Host " + n,
            host: "127.0.0.1",
            port: 39517 + n,
            enabled: true,
          });
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(containerEl)
      .setName("Default route")
      .setDesc("Which endpoint is selected when the chat opens.")
      .addDropdown((dd) => {
        for (const ep of endpoints) {
          dd.addOption(ep.id, `${ep.label} (:${ep.port})`);
        }
        dd.setValue(this.plugin.settings.activeEndpointId || endpoints[0]?.id || "local");
        dd.onChange(async (v) => {
          this.plugin.settings.activeEndpointId = v;
          const ep = endpoints.find((e) => e.id === v);
          if (ep) {
            this.plugin.settings.host = ep.host;
            this.plugin.settings.port = ep.port;
          }
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Auto-reconnect")
      .setDesc("Automatically reconnect when Cursor restarts or the connection drops.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.autoReconnect).onChange(async (v) => {
          this.plugin.settings.autoReconnect = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Max messages kept")
      .setDesc("How many chat bubbles to keep in the view before trimming the oldest.")
      .addText((t) =>
        t
          .setPlaceholder("400")
          .setValue(String(this.plugin.settings.maxHistory))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.maxHistory = Number.isFinite(n) && n > 20 ? n : 400;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Compact paste thumbnail size")
      .setDesc("Width/height (px) of pasted or uploaded image thumbnails in compact mode. Default 26.")
      .addText((t) =>
        t
          .setPlaceholder("26")
          .setValue(String(this.plugin.settings.attachThumbSize ?? 26))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.attachThumbSize = Number.isFinite(n)
              ? Math.min(240, Math.max(16, n))
              : 26;
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl("h3", { text: "Notifications" });

    new Setting(containerEl)
      .setName("Notify on MCP log rewrite")
      .setDesc("Show a native OS (Windows) notification whenever the MCP Response Log file is rewritten.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.notifyOnLogRewrite).onChange(async (v) => {
          this.plugin.settings.notifyOnLogRewrite = v;
          await this.plugin.saveSettings();
          if (v) ensureNotificationPermission();
        }),
      );

    new Setting(containerEl)
      .setName("MCP log path")
      .setDesc("Vault-relative path to the MCP Response Log to watch (forward slashes).")
      .addText((t) =>
        t
          .setPlaceholder("_Vault/MCP Response Log.md")
          .setValue(this.plugin.settings.logNotifyPath)
          .onChange(async (v) => {
            this.plugin.settings.logNotifyPath = (v || "").trim() || "_Vault/MCP Response Log.md";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test notification")
      .setDesc("Fire a sample OS notification to confirm Windows toasts work.")
      .addButton((b) =>
        b.setButtonText("Send test").onClick(async () => {
          await ensureNotificationPermission();
          showOsNotification("MCP Response Log updated", {
            body: "This is a test notification from the jefr plugin.",
          });
        })
      );

    const tip = containerEl.createEl("p", { cls: "jefr-settings-tip" });
    tip.setText(
      "The jefr Cursor extension must be running for this to connect. Messages you send here go through the same queue your agent reads and also appear in the jefr panel inside Cursor."
    );
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/** Ask the browser/Electron for notification permission once (no-op if already
 *  granted or unsupported). Returns a promise that resolves to the permission. */
async function ensureNotificationPermission() {
  try {
    if (typeof Notification === "undefined") return "unsupported";
    if (Notification.permission === "granted" || Notification.permission === "denied") {
      return Notification.permission;
    }
    return await Notification.requestPermission();
  } catch {
    return "default";
  }
}

/** Overwrite (or create) a vault-relative markdown note. Used by responseLog. */
async function writeVaultMarkdown(app, relPath, markdown) {
  const path = String(relPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  if (!path) throw new Error("empty path");
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (folder) {
    const parts = folder.split("/");
    let cur = "";
    for (const part of parts) {
      cur = cur ? cur + "/" + part : part;
      if (!app.vault.getAbstractFileByPath(cur)) {
        try {
          await app.vault.createFolder(cur);
        } catch {
          /* exists */
        }
      }
    }
  }
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing) {
    await app.vault.modify(existing, markdown);
  } else {
    await app.vault.create(path, markdown);
  }
}

/** Show a native OS notification (Windows toast in Electron). Falls back to an
 *  in-app Obsidian Notice if the web Notification API is unavailable/blocked. */
function showOsNotification(title, opts) {
  const body = (opts && opts.body) || "";
  const onClick = opts && opts.onClick;
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      const n = new Notification(title, { body, silent: false });
      if (onClick) n.onclick = () => onClick();
      return;
    }
    if (typeof Notification !== "undefined" && Notification.permission !== "denied") {
      // Permission not resolved yet — request, then show on grant.
      ensureNotificationPermission().then((perm) => {
        if (perm === "granted") {
          const n = new Notification(title, { body, silent: false });
          if (onClick) n.onclick = () => onClick();
        } else {
          new Notice(title + (body ? " — " + body : ""));
        }
      });
      return;
    }
  } catch {
    /* fall through to Notice */
  }
  try {
    new Notice(title + (body ? " — " + body : ""));
  } catch {
    /* ignore */
  }
}

function nowTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function arrayBufferToBase64(buf) {
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function blobToDataUrl(blob) {
  return new Promise((resolve) => {
    try {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result || ""));
      r.onerror = () => resolve("");
      r.readAsDataURL(blob);
    } catch {
      resolve("");
    }
  });
}

/** Read an image from the native Electron clipboard as a data URL, or "" if none. */
function readClipboardImage() {
  return readClipboardImageDiag().dataUrl;
}

/** Read image FILES referenced on the clipboard (copied from File Explorer etc.),
 *  which appear as a text/uri-list of file:// URIs. Returns [{dataUrl, name}]. */
function readClipboardFileImages() {
  const out = [];
  try {
    const electron = require("electron");
    const clip = electron && electron.clipboard;
    if (!clip) return out;
    let txt = "";
    try {
      if (typeof clip.read === "function") txt = clip.read("text/uri-list") || "";
    } catch {
      /* ignore */
    }
    if (!txt && typeof clip.readText === "function") txt = clip.readText() || "";
    if (!txt) return out;
    const fs = require("fs");
    const path = require("path");
    const imageExts = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];
    const uris = txt
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && s[0] !== "#");
    for (const uri of uris) {
      let p = uri;
      if (/^file:\/\//i.test(p)) {
        p = decodeURIComponent(p.replace(/^file:\/\//i, ""));
        if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1); // Windows /C:/... → C:/...
      }
      const ext = (path.extname(p).slice(1) || "").toLowerCase();
      if (imageExts.indexOf(ext) === -1) continue;
      try {
        const buf = fs.readFileSync(p);
        const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "svg" ? "image/svg+xml" : "image/" + ext;
        out.push({ dataUrl: "data:" + mime + ";base64," + buf.toString("base64"), name: path.basename(p) });
      } catch {
        /* unreadable path */
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Like readClipboardImage but returns a diagnostic note for debugging. */
function readClipboardImageDiag() {
  try {
    const electron = require("electron");
    if (!electron) return { dataUrl: "", note: "electron: require returned null" };
    const clip = electron.clipboard || (electron.remote && electron.remote.clipboard);
    if (!clip) return { dataUrl: "", note: "electron: no .clipboard" };
    if (typeof clip.readImage !== "function") return { dataUrl: "", note: "electron: no readImage()" };
    const img = clip.readImage();
    if (!img) return { dataUrl: "", note: "electron: readImage null" };
    if (typeof img.isEmpty === "function" && img.isEmpty()) {
      let formats = "";
      try {
        formats = (clip.availableFormats && clip.availableFormats().join(",")) || "";
      } catch {
        /* ignore */
      }
      return { dataUrl: "", note: "electron: image empty; formats=[" + formats + "]" };
    }
    return { dataUrl: img.toDataURL(), note: "electron: image OK" };
  } catch (e) {
    return { dataUrl: "", note: "electron err: " + (e && e.message ? e.message : e) };
  }
}

async function renderMd(view, markdown, el) {
  try {
    if (MarkdownRenderer && typeof MarkdownRenderer.render === "function") {
      await MarkdownRenderer.render(view.app, markdown || "", el, "", view);
      return;
    }
    if (MarkdownRenderer && typeof MarkdownRenderer.renderMarkdown === "function") {
      await MarkdownRenderer.renderMarkdown(markdown || "", el, "", view);
      return;
    }
  } catch {
    /* fall through to plain text */
  }
  el.setText(markdown || "");
}

module.exports = JefrPlugin;
