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
 *   { type: "pong" }
 * Protocol (client -> server):
 *   { type: "sendText", text }
 *   { type: "submitAnswer", data: { id, answers: [{ questionId, selected, other }] } }
 *   { type: "cancelQuestion" }
 *   { type: "ackReply" }
 *   { type: "ping" }
 */

const { Plugin, ItemView, PluginSettingTab, Setting, MarkdownRenderer, Notice, setIcon } = require("obsidian");

const VIEW_TYPE_JEFR = "jefr-chat-view";

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 39517,
  autoReconnect: true,
  maxHistory: 400,
  minimized: false,
};

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

class JefrPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    this.registerView(VIEW_TYPE_JEFR, (leaf) => new JefrView(leaf, this));

    this.addRibbonIcon("messages-square", "Open jefr chat", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-jefr-chat",
      name: "Open jefr chat",
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
  }

  onunload() {
    // Views detach themselves and close their sockets via onClose().
  }

  async saveSettings() {
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
/* The chat view                                                       */
/* ------------------------------------------------------------------ */

class JefrView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;

    this.ws = null;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.reconnectAttempts = 0;
    this.manualClose = false;

    // De-dupe / render bookkeeping.
    this.lastReplyTs = null;
    this.currentQuestionId = null;
    this.selected = {}; // questionId -> string[]
    this.connStatus = "offline";
    this.attachments = []; // staged images: { id, name, dataUrl }
    this._progressHideTimer = null;
    this.lastQueue = [];
    this.queueOpen = false;
    this.renderedIds = new Set(); // shared-history item ids already shown
  }

  getViewType() {
    return VIEW_TYPE_JEFR;
  }

  getDisplayText() {
    return "jefr";
  }

  getIcon() {
    return "messages-square";
  }

  async onOpen() {
    this.buildUI();
    this.connect();
  }

  async onClose() {
    this.manualClose = true;
    this.teardownSocket();
  }

  onSettingsChanged() {
    // Reconnect to the (possibly) new host/port.
    this.teardownSocket();
    this.reconnectAttempts = 0;
    this.connect();
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
    brand.createSpan({ cls: "jefr-logo", text: "jefr" });
    this.statusPill = brand.createSpan({ cls: "jefr-status jefr-status-offline", text: "Offline" });

    const headerRight = header.createDiv({ cls: "jefr-header-right" });
    this.queueBadge = headerRight.createSpan({ cls: "jefr-queue-badge", text: "" });
    this.queueBadge.onclick = () => this.toggleQueuePanel();
    this.minimizeBtn = headerRight.createEl("button", { cls: "jefr-icon-btn", attr: { "aria-label": "Toggle compact mode" } });
    this.minimizeBtn.onclick = () => this.toggleMinimized();
    this.reconnectBtn = headerRight.createEl("button", { cls: "jefr-icon-btn", attr: { "aria-label": "Reconnect" } });
    setIcon(this.reconnectBtn, "refresh-cw");
    this.reconnectBtn.onclick = () => {
      this.teardownSocket();
      this.reconnectAttempts = 0;
      this.connect();
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
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) {
        // Try every clipboard method; if none yields an image, fall back to
        // absorbing any ![[..]] embed Obsidian may insert.
        this.tryClipboardImage().then((ok) => {
          if (!ok) window.setTimeout(() => this.absorbEmbeds(), 60);
        });
      }
    });
    this.input.addEventListener("input", () => this.updateSendState());
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

  renderEmptyState() {
    this.messagesEl.empty();
    const empty = this.messagesEl.createDiv({ cls: "jefr-empty" });
    empty.createDiv({ cls: "jefr-empty-icon", text: "✦" });
    empty.createDiv({ cls: "jefr-empty-title", text: "jefr chat" });
    empty.createDiv({
      cls: "jefr-empty-sub",
      text: "Send a message to your Cursor agent. Everything here syncs with the jefr panel in Cursor.",
    });
  }

  updateSendState() {
    const hasText = this.input && this.input.value.trim().length > 0;
    const hasAttach = this.attachments.length > 0;
    const online = this.connStatus === "online";
    if (this.sendBtn) this.sendBtn.disabled = (!hasText && !hasAttach) || !online;
    if (this.hint) {
      this.hint.setText(online ? "Enter to send" : "Offline — waiting for Cursor…");
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
    if (!this.statusPill) return;
    this.statusPill.removeClass("jefr-status-online", "jefr-status-offline", "jefr-status-connecting");
    if (status === "online") {
      this.statusPill.addClass("jefr-status-online");
      this.statusPill.setText("Online");
    } else if (status === "connecting") {
      this.statusPill.addClass("jefr-status-connecting");
      this.statusPill.setText("Connecting…");
    } else {
      this.statusPill.addClass("jefr-status-offline");
      this.statusPill.setText("Offline");
    }
    this.updateSendState();
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
      } else if (it.kind === "image" && it.dataUrl) {
        this.addImageBubble(it.dataUrl, it.name, it.caption);
      } else if (it.kind === "image" || it.kind === "file") {
        this.addUserBubble(it.caption || it.name || it.text || "[" + it.kind + "]");
      } else {
        this.addUserBubble(it.text || "");
      }
    }
  }

  addImageBubble(dataUrl, name, caption) {
    this.ensureMessagesReady();
    const row = this.messagesEl.createDiv({ cls: "jefr-row jefr-row-user" });
    const bubble = row.createDiv({ cls: "jefr-bubble jefr-bubble-user jefr-bubble-image" });
    bubble.createEl("img", { cls: "jefr-msg-img", attr: { src: dataUrl, alt: name || "image" } });
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
    if (this.connStatus !== "online" || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("jefr is offline — open Cursor with the jefr extension running.");
      return;
    }
    try {
      if (attachments.length) {
        // Combine text + image(s) into ONE message: send the text as the caption
        // on the first image so the agent receives it as a single item.
        attachments.forEach((a, i) => {
          this.ws.send(JSON.stringify({ type: "sendImage", dataUrl: a.dataUrl, caption: i === 0 ? text : "" }));
        });
      } else if (text) {
        this.ws.send(JSON.stringify({ type: "sendText", text }));
      }
      // Bubbles are rendered from the shared history broadcast (no optimistic add),
      // so the same message shows identically across all front-ends.
    } catch (e) {
      new Notice("jefr: failed to send message.");
      return;
    }
    this.input.value = "";
    this.attachments = [];
    this.renderAttachments();
    this.updateSendState();
    this.input.focus();
  }

  /* --------------------------- Questions ------------------------- */

  renderQuestion(q) {
    if (!q || !q.questions || !q.questions.length) {
      this.questionEl.empty();
      this.currentQuestionId = null;
      return;
    }
    // Don't wipe/re-render an already-shown question when other state updates
    // (queue count, reply, etc.) arrive — that was clearing the visible card.
    if (q.id === this.currentQuestionId) return;
    this.currentQuestionId = q.id;
    this.selected = {};
    this.questionEl.empty();

    const card = this.questionEl.createDiv({ cls: "jefr-qcard" });
    const head = card.createDiv({ cls: "jefr-qcard-head" });
    head.createSpan({ cls: "jefr-qcard-title", text: "Agent question" });
    head.createSpan({ cls: "jefr-qcard-badge", text: "Awaiting answer" });

    const body = card.createDiv({ cls: "jefr-qcard-body" });
    for (const qi of q.questions) {
      this.selected[qi.id] = [];
      const block = body.createDiv({ cls: "jefr-qblock" });
      block.createDiv({ cls: "jefr-qtext", text: qi.question });
      const opts = block.createDiv({ cls: "jefr-qopts" });
      for (const opt of qi.options || []) {
        const optEl = opts.createDiv({ cls: "jefr-qopt" + (qi.allow_multiple ? " jefr-multi" : "") });
        optEl.createSpan({ cls: "jefr-qcheck" });
        optEl.createSpan({ cls: "jefr-qopt-label", text: opt.label });
        optEl.onclick = () => this.toggleOption(qi, opt.id, optEl, opts);
      }
      const other = block.createEl("input", {
        cls: "jefr-qother",
        attr: { type: "text", placeholder: "Additional notes (optional)", "data-qid": qi.id },
      });
      void other;
    }

    const actions = card.createDiv({ cls: "jefr-qactions" });
    const cancel = actions.createEl("button", { cls: "jefr-btn jefr-btn-ghost", text: "Cancel" });
    cancel.onclick = () => this.cancelQuestion();
    const submit = actions.createEl("button", { cls: "jefr-btn jefr-btn-send", text: "Submit answer" });
    submit.onclick = () => this.submitQuestion(q);

    this.scrollToBottom();
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
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      new Notice("jefr is offline.");
      return;
    }
    const answers = [];
    for (const qi of q.questions) {
      const otherEl = this.questionEl.querySelector(`.jefr-qother[data-qid="${qi.id}"]`);
      answers.push({
        questionId: qi.id,
        selected: this.selected[qi.id] || [],
        other: otherEl ? otherEl.value.trim() : "",
      });
    }
    this.ws.send(JSON.stringify({ type: "submitAnswer", data: { id: q.id, answers } }));
    this.addSystemNote("Answer submitted");
    this.questionEl.empty();
    this.currentQuestionId = null;
  }

  cancelQuestion() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cancelQuestion" }));
    }
    this.addSystemNote("Question cancelled");
    this.questionEl.empty();
    this.currentQuestionId = null;
  }

  /* ----------------------- Inbound state ------------------------- */

  handleState(d) {
    // Connection / workspace
    if (d.workspace) {
      const name = d.workspace.name || "";
      const p = d.workspace.path || "";
      this.workspaceLine.setText(name ? `${name}` : "");
      this.workspaceLine.setAttr("title", p);
    }

    // Queue badge + remember the queued items for the toggle panel.
    this.lastQueue = Array.isArray(d.queue) ? d.queue : [];
    const count = typeof d.queueCount === "number" ? d.queueCount : this.lastQueue.length;
    if (this.queueBadge) {
      this.queueBadge.setText(count > 0 ? `${count} queued` : "");
      this.queueBadge.toggleClass("jefr-has-queue", count > 0);
    }
    if (count === 0 && this.queueOpen) this.closeQueuePanel();
    else if (this.queueOpen) this.renderQueuePanel();

    // Question
    if (d.question) {
      this.renderQuestion(d.question);
    } else if (this.currentQuestionId) {
      this.questionEl.empty();
      this.currentQuestionId = null;
    }

    // Shared chat history (sends from any front-end)
    if (Array.isArray(d.history)) this.renderSharedHistory(d.history);

    // Progress only — actual reply bubbles now come through the shared history
    // (kind: "reply"), so we don't render them from reply.json to avoid doubles.
    if (d.reply && d.reply.content) {
      const ts = d.reply.timestamp || "";
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
    head.setText(items.length + " message" + (items.length === 1 ? "" : "s") + " queued");
    for (const it of items) {
      const row = this.queuePanel.createDiv({ cls: "jefr-queue-row" });
      const type = it.type || "text";
      let preview;
      if (type === "image") preview = it.caption ? "[Image] " + it.caption : "[Image]";
      else if (type === "file") preview = "[File] " + (it.path ? it.path.split(/[\\/]/).pop() : "");
      else preview = (it.content || "").replace(/\s+/g, " ").trim();
      row.createSpan({ cls: "jefr-queue-type jefr-qt-" + type, text: type });
      row.createSpan({ cls: "jefr-queue-text", text: preview.length > 120 ? preview.slice(0, 120) + "…" : preview });
    }
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

  /* --------------------------- Socket ---------------------------- */

  connect() {
    if (this.ws) return;
    this.manualClose = false;
    const { host, port } = this.plugin.settings;
    const url = `ws://${host}:${port}`;
    this.setStatus("connecting");

    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus("online");
      this.startPing();
    };

    ws.onmessage = (ev) => {
      let m;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === "init" || m.type === "stateUpdate") {
        this.handleState(m);
      } else if (m.type === "queueUpdate") {
        if (this.queueBadge) {
          const c = m.count || 0;
          this.queueBadge.setText(c > 0 ? `${c} queued` : "");
          this.queueBadge.toggleClass("jefr-has-queue", c > 0);
        }
      } else if (m.type === "pong") {
        // keep-alive ack
      }
    };

    ws.onclose = () => {
      this.stopPing();
      this.ws = null;
      this.setStatus("offline");
      if (!this.manualClose && this.plugin.settings.autoReconnect) {
        this.scheduleReconnect();
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

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "ping" }));
        } catch {
          /* ignore */
        }
      }
    }, 20000);
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  teardownSocket() {
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.manualClose = true;
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.setStatus("offline");
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
    containerEl.createEl("h3", { text: "jefr connection" });

    new Setting(containerEl)
      .setName("Host")
      .setDesc("Host of the jefr local server running inside Cursor (usually 127.0.0.1).")
      .addText((t) =>
        t
          .setPlaceholder("127.0.0.1")
          .setValue(this.plugin.settings.host)
          .onChange(async (v) => {
            this.plugin.settings.host = (v || "").trim() || "127.0.0.1";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Port")
      .setDesc("Port of the jefr local server. Default is 39517.")
      .addText((t) =>
        t
          .setPlaceholder("39517")
          .setValue(String(this.plugin.settings.port))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.port = Number.isFinite(n) && n > 0 ? n : 39517;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-reconnect")
      .setDesc("Automatically reconnect when Cursor restarts or the connection drops.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.autoReconnect).onChange(async (v) => {
          this.plugin.settings.autoReconnect = v;
          await this.plugin.saveSettings();
        })
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
