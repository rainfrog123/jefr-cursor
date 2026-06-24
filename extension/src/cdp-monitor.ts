/**
 * CDP Monitor — Real-time tile state monitoring via Chrome DevTools Protocol.
 *
 * Connects to Cursor's CDP endpoint (port 9222) and queries the DOM directly
 * for tile state, agent IDs, and MCP connection status. Replaces the file-based
 * heartbeat system with direct DOM truth.
 *
 * Requires Cursor launched with:
 *   --remote-debugging-port=9222 --remote-allow-origins=*
 */

import * as http from "http";
import WebSocket from "ws";
import { EventEmitter } from "events";

// ── Types ────────────────────────────────────────────────────────────────────

export type TileState = "idle" | "generating" | "planning" | "mcp_connected" | "waiting" | "working";

export interface TileInfo {
  index: number;
  agentId: string | null;
  model: string;
  state: TileState;
  /** True only while a check_messages call is *currently running* (live tool
   *  card / shimmer) — not when "Ran Check Messages" merely sits in scrollback. */
  mcpVisible: boolean;
  /** True when submit button is in stop/generating mode */
  generating: boolean;
  /** True when "Planning next moves" shimmer is visible */
  planning: boolean;
  /** True when "Worked for..." completion marker is visible */
  worked: boolean;
}

export interface CdpStatus {
  connected: boolean;
  pageTitle: string | null;
  tiles: TileInfo[];
  error: string | null;
}

// ── Constants ────────────────────────────────────────────────────────────────

const CDP_HOST = "127.0.0.1";
const CDP_PORT = 9222;
const POLL_INTERVAL_MS = 500;

// ── CDP Session ──────────────────────────────────────────────────────────────

class CdpSession {
  private ws: WebSocket | null = null;
  private messageId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, { handshakeTimeout: 5000 });
      this.ws.on("open", () => {
        this.call("Runtime.enable").then(() => resolve()).catch(reject);
      });
      this.ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (typeof msg.id === "number" && this.pending.has(msg.id)) {
            const { resolve } = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            resolve(msg);
          }
        } catch {
          // ignore parse errors
        }
      });
      this.ws.on("error", reject);
      this.ws.on("close", () => {
        for (const { reject } of this.pending.values()) {
          reject(new Error("WebSocket closed"));
        }
        this.pending.clear();
      });
    });
  }

  async call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    const id = ++this.messageId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("CDP call timeout"));
        }
      }, 10000);
    });
  }

  async evaluate(expression: string, awaitPromise = true): Promise<unknown> {
    const resp = await this.call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    }) as { result?: { result?: { value?: unknown } }; exceptionDetails?: unknown };
    if (resp.exceptionDetails) {
      throw new Error(`JS exception: ${JSON.stringify(resp.exceptionDetails)}`);
    }
    return resp.result?.result?.value;
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }
}

// ── CDP Monitor ──────────────────────────────────────────────────────────────

export class CdpMonitor extends EventEmitter {
  private session: CdpSession | null = null;
  private wsUrl: string | null = null;
  private pageTitle: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastStatus: CdpStatus | null = null;

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async clickAt(x: number, y: number): Promise<void> {
    if (!this.session) {
      throw new Error("CDP session not connected");
    }
    await this.session.call("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
    });
    await this.session.call("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await this.session.call("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
  }

  /** Start monitoring. Emits 'status' events with CdpStatus on each poll. */
  async start(): Promise<void> {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    await this.poll();
  }

  /** Stop monitoring and disconnect. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.session) {
      this.session.close();
      this.session = null;
    }
    this.wsUrl = null;
    this.pageTitle = null;
  }

  /** Get current status (cached from last poll). */
  getStatus(): CdpStatus {
    return this.lastStatus || {
      connected: false,
      pageTitle: null,
      tiles: [],
      error: "Not started",
    };
  }

  /** Force an immediate poll (useful after actions). */
  async pollNow(): Promise<CdpStatus> {
    return this.poll();
  }

  private async connect(): Promise<void> {
    try {
      const targets = await this.fetchTargets();
      const workbench = await this.findWorkbench(targets);
      if (!workbench) {
        throw new Error("No workbench page found (is Cursor running with --remote-debugging-port=9222?)");
      }
      this.wsUrl = workbench.webSocketDebuggerUrl;
      this.pageTitle = workbench.title;
      this.session = new CdpSession();
      await this.session.connect(this.wsUrl);
    } catch (e) {
      this.emitStatus({
        connected: false,
        pageTitle: null,
        tiles: [],
        error: (e as Error).message,
      });
      throw e;
    }
  }

  private async fetchTargets(): Promise<Array<{ type: string; webSocketDebuggerUrl?: string; title?: string; url?: string }>> {
    return new Promise((resolve, reject) => {
      const req = http.get(`http://${CDP_HOST}:${CDP_PORT}/json/list`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Invalid CDP response"));
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error("CDP connection timeout"));
      });
    });
  }

  private async findWorkbench(targets: Array<{ type: string; webSocketDebuggerUrl?: string; title?: string }>): Promise<{ webSocketDebuggerUrl: string; title: string } | null> {
    const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);

    // Prefer "Cursor Agents" page first — that's where multi-agent tiles live
    const agentsPage = pages.find((p) => /Cursor Agents/i.test(p.title || ""));
    if (agentsPage) {
      const hasEditor = await this.checkHasEditor(agentsPage.webSocketDebuggerUrl!);
      if (hasEditor) {
        return { webSocketDebuggerUrl: agentsPage.webSocketDebuggerUrl!, title: agentsPage.title || "" };
      }
    }

    // Fallback: any page with a chat editor
    for (const page of pages) {
      const hasEditor = await this.checkHasEditor(page.webSocketDebuggerUrl!);
      if (hasEditor) {
        return { webSocketDebuggerUrl: page.webSocketDebuggerUrl!, title: page.title || "" };
      }
    }
    return null;
  }

  private async checkHasEditor(wsUrl: string): Promise<boolean> {
    const session = new CdpSession();
    try {
      await session.connect(wsUrl);
      const result = await session.evaluate("!!document.querySelector('.tiptap.ProseMirror')", false);
      return !!result;
    } catch {
      return false;
    } finally {
      session.close();
    }
  }

  private async poll(): Promise<CdpStatus> {
    if (!this.session) {
      try {
        await this.connect();
      } catch (e) {
        const status: CdpStatus = {
          connected: false,
          pageTitle: null,
          tiles: [],
          error: (e as Error).message,
        };
        this.emitStatus(status);
        return status;
      }
    }

    try {
      const tiles = await this.queryTileState();
      const status: CdpStatus = {
        connected: true,
        pageTitle: this.pageTitle,
        tiles,
        error: null,
      };
      this.emitStatus(status);
      return status;
    } catch (e) {
      // Connection lost — reset and try to reconnect next poll
      this.session?.close();
      this.session = null;
      const status: CdpStatus = {
        connected: false,
        pageTitle: null,
        tiles: [],
        error: (e as Error).message,
      };
      this.emitStatus(status);
      return status;
    }
  }

  /** Focus the composer of the tile whose agentId matches. Returns true on success. */
  async focusAgent(agentId: string): Promise<boolean> {
    if (!this.session) return false;
    const js = `
(function() {
  const TARGET = ${JSON.stringify(agentId)};
  function tileRoots() {
    const tiled = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
    if (tiled.length > 0) return tiled;
    const shell = document.querySelector('.agent-panel-conversation-shell');
    return shell ? [shell] : [];
  }
  function agentIdOf(node) {
    const k = Object.keys(node).find(x =>
      x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$')
    );
    let f = k ? node[k] : null, steps = 0;
    while (f && steps++ < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.agentId === 'string') return p.agentId;
      f = f.return;
    }
    return null;
  }
  const roots = tileRoots();
  for (let i = 0; i < roots.length; i++) {
    const t = roots[i];
    if (agentIdOf(t) !== TARGET) continue;
    const eds = [...t.querySelectorAll('.tiptap.ProseMirror.ui-prompt-input-editor__input')]
      .filter(e => !e.closest('.prompt-edit-input'));
    const isFu = e => e.closest('.agent-panel-followup-input') ||
      /send follow-?up/i.test((e.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')) ||
        e.getAttribute('data-placeholder') || '');
    const ed = eds.find(isFu) || eds[eds.length - 1];
    if (ed) { ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); ed.focus(); ed.click(); return true; }
  }
  return false;
})()
    `;
    try {
      return !!(await this.session.evaluate(js, false));
    } catch {
      return false;
    }
  }

  /** Close the tile for agentId. Returns true only after the target tile is gone. */
  async closeAgentTile(agentId: string): Promise<boolean> {
    if (!this.session) return false;
    const triggerJs = `
(function() {
  const TARGET = ${JSON.stringify(agentId)};
  function tileRoots() {
    const tiled = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
    if (tiled.length > 0) return tiled;
    return [];
  }
  function agentIdOf(node) {
    const k = Object.keys(node).find(x =>
      x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$')
    );
    let f = k ? node[k] : null, steps = 0;
    while (f && steps++ < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.agentId === 'string') return p.agentId;
      f = f.return;
    }
    return null;
  }
  function visMenu() {
    return [...document.querySelectorAll('[role^="menuitem"],[role="option"]')].filter(e => e.offsetParent);
  }
  function tileMenuTrigger(tile, idx) {
    const inTile = tile?.querySelector('[aria-label="Tile actions"],.glass-agent-conversation-tiling__menu-trigger');
    if (inTile) return inTile;
    const actions = [...document.querySelectorAll('[aria-label="Tile actions"],.glass-agent-conversation-tiling__menu-trigger')]
      .filter(e => e.offsetParent);
    return actions[idx] || null;
  }
  const tiles = tileRoots();
  if (tiles.length <= 1) return false;
  let idx = -1;
  for (let i = 0; i < tiles.length; i++) {
    if (agentIdOf(tiles[i]) === TARGET) { idx = i; break; }
  }
  if (idx < 0) return false;
  const trig = tileMenuTrigger(tiles[idx], idx);
  if (!trig) return false;
  const r = trig.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, idx, count: tiles.length };
})()
    `;
    const closeJs = `
(function() {
  const items = [...document.querySelectorAll('[role^="menuitem"],[role="option"]')]
    .filter(e => e.offsetParent);
  const close = items.find(e => (e.textContent || '').trim().toLowerCase().startsWith('close'));
  if (!close) return false;
  const r = close.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (close.textContent || '').trim() };
})()
    `;
    const goneJs = `
(function() {
  const TARGET = ${JSON.stringify(agentId)};
  function tileRoots() {
    const tiled = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
    if (tiled.length > 0) return tiled;
    return [];
  }
  function agentIdOf(node) {
    const k = Object.keys(node).find(x =>
      x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$')
    );
    let f = k ? node[k] : null, steps = 0;
    while (f && steps++ < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.agentId === 'string') return p.agentId;
      f = f.return;
    }
    return null;
  }
  return !tileRoots().some(t => agentIdOf(t) === TARGET);
})()
    `;
    try {
      const trigger = await this.session.evaluate(triggerJs, false) as { x?: number; y?: number } | false;
      if (!trigger || typeof trigger.x !== "number" || typeof trigger.y !== "number") {
        return false;
      }
      await this.clickAt(trigger.x, trigger.y);
      await this.sleep(350);
      const close = await this.session.evaluate(closeJs, false) as { x?: number; y?: number } | false;
      if (!close || typeof close.x !== "number" || typeof close.y !== "number") {
        return false;
      }
      await this.clickAt(close.x, close.y);
      await this.sleep(900);
      return !!(await this.session.evaluate(goneJs, false));
    } catch {
      return false;
    }
  }

  private async queryTileState(): Promise<TileInfo[]> {
    const js = `
(function() {
  // Multi-tile: .glass-agent-conversation-tiling__tile
  // Single-pane (one agent): .agent-panel-conversation-shell — no tiling wrapper
  function tileRoots() {
    const tiled = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
    if (tiled.length > 0) return tiled;
    const shell = document.querySelector('.agent-panel-conversation-shell');
    return shell ? [shell] : [];
  }
  const tiles = tileRoots();

  function agentIdOf(node) {
    const k = Object.keys(node).find(x =>
      x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$')
    );
    let f = k ? node[k] : null, steps = 0;
    while (f && steps++ < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === 'object' && typeof p.agentId === 'string') return p.agentId;
      f = f.return;
    }
    return null;
  }

  // A check_messages MCP call counts as "connected / held open" only while it is
  // *currently running* — a live tool card (or collapsible action) that names
  // "Check Messages in jefr" and still carries a running/shimmer indicator.
  // Completed ("Ran ...") cards left in scrollback are ignored, so historical
  // transcript text can never make a tile look permanently connected.
  function mcpRunningIn(t) {
    const toolCards = [...t.querySelectorAll('[data-message-kind="tool"]')];
    for (const m of toolCards) {
      const txt = m.textContent || '';
      if (!/check\\s*messages/i.test(txt) || !/jefr/i.test(txt)) continue;
      const status = (m.getAttribute('data-tool-status') || '').toLowerCase();
      const cls = typeof m.className === 'string' ? m.className : '';
      const running =
        /run|load|pend|progress|stream|active/.test(status) ||
        /with-stop/.test(cls) ||
        !!m.querySelector('[class*="shimmer"],[class*="spinner"],.codicon-modifier-spin,[data-state="stop"],[class*="with-stop"]');
      if (running) return true;
    }
    // Fallback for builds that don't tag tool cards: a live collapsible-action
    // shimmer naming check messages is also an in-progress call.
    const shimmers = [...t.querySelectorAll('.ui-collapsible-shimmer')];
    for (const s of shimmers) {
      if (/check\\s*messages/i.test(s.textContent || '')) return true;
    }
    return false;
  }

  return tiles.map((t, i) => {
    const submit = t.querySelector('.ui-prompt-input-submit-button');
    const aria = submit?.getAttribute('aria-label') || '';
    const generating = submit?.getAttribute('data-state') === 'stop' || /stop generation/i.test(aria);

    const sh = t.querySelector('.ui-collapsible-action.ui-collapsible-shimmer')?.textContent || '';
    const planning = /planning\\s+next\\s+move/i.test(sh);

    const mcpRunning = mcpRunningIn(t);

    // "Worked for ..." completion stamp = the turn ended (MCP cut out). Prefer the
    // live status/followup area; fall back to the recent tail. We do NOT scan the
    // whole transcript, so an old stamp from a prior turn won't mark a live tile.
    const statusText = [
      ...[...t.querySelectorAll('.glass-chat-status-bar__segment-label')].map(e => e.textContent || ''),
      t.querySelector('.agent-panel-followup-status-area')?.textContent || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const full = (t.innerText || '').replace(/\\s+/g, ' ');
    const tail = full.length > 400 ? full.slice(-400) : full;
    const worked = /worked for\\s+[\\dhms ]+/i.test(statusText) || /worked for\\s+[\\dhms ]+/i.test(tail);

    const model = t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() || '';

    // Precedence: a live MCP call wins over planning/generating, so a transient
    // "Planning next moves" shimmer can't demote a held-open connection (which
    // previously flip-flopped the state, inflating connect counts and resetting
    // uptime).
    let state = 'idle';
    if (mcpRunning) state = 'mcp_connected';
    else if (planning) state = 'planning';
    else if (generating) state = 'generating';

    return {
      index: i,
      agentId: agentIdOf(t),
      model,
      state,
      mcpVisible: mcpRunning,
      generating,
      planning,
      worked,
    };
  });
})()
    `;
    const result = await this.session!.evaluate(js, false);
    return (result as TileInfo[]) || [];
  }

  private emitStatus(status: CdpStatus): void {
    const changed = JSON.stringify(status) !== JSON.stringify(this.lastStatus);
    this.lastStatus = status;
    if (changed) {
      this.emit("status", status);
    }
  }
}

// ── Singleton instance ───────────────────────────────────────────────────────

let monitor: CdpMonitor | null = null;

export function getCdpMonitor(): CdpMonitor {
  if (!monitor) {
    monitor = new CdpMonitor();
  }
  return monitor;
}

export function stopCdpMonitor(): void {
  if (monitor) {
    monitor.stop();
    monitor = null;
  }
}
