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
  /** True when a jefr check_messages tool card is in an ERROR/failed state — the
   *  server-drop fingerprint: the held-open call died, so there's no "Ran…"
   *  success and no "Worked for…" stamp, and the tile would otherwise read as a
   *  plain idle/down. Determined from the card's status/class/error-icon only —
   *  never from arbitrary card text — so a reply that merely mentions "error"
   *  can't false-positive. */
  mcpErrored: boolean;
  /** True when submit button is in stop/generating mode */
  generating: boolean;
  /** True when "Planning next moves" shimmer is visible */
  planning: boolean;
  /** True when "Worked for..." completion marker is visible */
  worked: boolean;
  /** True when the tile is idle with the injected prompt restored, un-sent, in its
   *  composer — Cursor puts the draft back when a held-open turn dies, so this
   *  catches a cut-off that left no "Worked for…" stamp. Fingerprint-scoped to the
   *  spawn prompts so a human-typed draft can't trip it. */
  draftPending: boolean;
  /** True when the transcript tail shows a standby reply while the tile is idle
   *  (no blocked check_messages) — the loop cut out without a "Worked for…" stamp. */
  standbyCutoff: boolean;
  /** True when this tile shows the "Payment failed … Manage Billing" banner — the
   *  account's billing is blocked, so the tile can't run. Auto-closed on sight. */
  billingBlocked: boolean;
  /**
   * Labels of the most recent tool cards rendered in this tile, oldest → newest.
   *
   * This is the ONLY live, mid-turn view of what an agent is doing. Cursor does
   * not flush the `.jsonl` transcript until a turn ends — a jefr agent parked in
   * the perpetual MCP loop can run for hours with nothing written to disk — so
   * the transcript can only ever describe *previous* turns. The tile DOM renders
   * each tool card as it happens, which is what the panel needs.
   *
   * Empty when the selectors don't match (Cursor's DOM is private and drifts
   * between builds); callers must degrade to the transcript, never assume this.
   */
  liveTools: string[];
  /** True when the newest tool card is still running. */
  liveToolRunning: boolean;
  /** Live status-bar / follow-up text, e.g. "Worked for 3m 12s". */
  statusText: string;
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

  /** Poll an evaluate expression until it returns truthy or the timeout elapses.
   *  Returns as soon as the UI settles, so it's far faster than a fixed sleep
   *  while still bounding the worst case. */
  private async pollEval(
    expr: string,
    timeoutMs: number,
    stepMs = 50,
  ): Promise<unknown> {
    const start = Date.now();
    for (;;) {
      let v: unknown;
      try {
        v = await this.session!.evaluate(expr, false);
      } catch {
        v = undefined;
      }
      if (v) return v;
      if (Date.now() - start >= timeoutMs) return v;
      await this.sleep(stepMs);
    }
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

  /** Hard refresh: tear down the current CDP session and dedupe cache, then
   *  poll fresh. A plain pollNow() reuses the existing session and skips the
   *  status emit when nothing changed — useless when the session has drifted or
   *  gone stale (selectors changed, page swapped, socket half-dead). Dropping the
   *  session forces the next poll to reconnect from scratch, and clearing
   *  lastStatus guarantees the status event re-fires so the roster is rebuilt and
   *  re-pushed even if the result is byte-identical. Used by the manual Refresh
   *  button so it can actually recover a wedged monitor instead of no-op'ing. */
  async forceReconnect(): Promise<CdpStatus> {
    if (this.session) {
      this.session.close();
      this.session = null;
    }
    this.wsUrl = null;
    this.pageTitle = null;
    this.lastStatus = null;
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
    // Prefer focusing the tip-tap editor so Ctrl+W targets this tile. Dropped /
    // dead tiles often have no usable editor — fall back to clicking the tile
    // chrome (or its menu trigger) so the pane still receives focus.
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
    if (ed) {
      ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      ed.focus();
      ed.click();
      return { ok: true, via: 'editor' };
    }
    const trig = t.querySelector('[aria-label="Tile actions"],.glass-agent-conversation-tiling__menu-trigger');
    const hit = trig || t;
    const r = hit.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { ok: false };
    return {
      ok: true,
      via: 'chrome',
      x: r.left + Math.min(r.width / 2, 24),
      y: r.top + Math.min(r.height / 2, 18),
    };
  }
  return { ok: false };
})()
    `;
    try {
      const res = (await this.session.evaluate(js, false)) as
        | { ok?: boolean; via?: string; x?: number; y?: number }
        | false
        | null;
      if (!res || !res.ok) return false;
      if (res.via === "chrome" && typeof res.x === "number" && typeof res.y === "number") {
        await this.clickAt(res.x, res.y);
        await this.sleep(80);
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Press a key chord via CDP (keyDown + keyUp). Modifier bits per CDP:
   *  Alt=1, Ctrl=2, Meta=4, Shift=8. */
  private async pressKey(
    key: string,
    code: string,
    vk: number,
    mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {},
  ): Promise<void> {
    if (!this.session) {
      throw new Error("CDP session not connected");
    }
    let modifiers = 0;
    if (mods.alt) modifiers |= 1;
    if (mods.ctrl) modifiers |= 2;
    if (mods.meta) modifiers |= 4;
    if (mods.shift) modifiers |= 8;
    const base = {
      modifiers,
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    };
    await this.session.call("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.session.call("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Fast tile close: focus the tile, then send Ctrl+W (Cursor's close-tile
   *  shortcut; Ctrl+D is OPEN/new-tile, not close). Far quicker than driving the
   *  tile menu. Verifies the SPECIFIC agent's tile is gone, so a mis-focus or a
   *  swallowed chord can't close the wrong one; returns false if it's still
   *  present (the caller falls back to the menu close). */
  async closeAgentTileFast(agentId: string): Promise<boolean> {
    if (!this.session) return false;
    const focused = await this.focusAgent(agentId);
    if (!focused) return false;
    await this.sleep(80);
    try {
      await this.pressKey("w", "KeyW", 87, { ctrl: true });
    } catch {
      return false;
    }
    const goneJs = `
(function() {
  const TARGET = ${JSON.stringify(agentId)};
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
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
  // Empty tiling = last tile closed. Also treat as gone if TARGET is absent.
  if (tiles.length === 0) return true;
  return !tiles.some(t => agentIdOf(t) === TARGET);
})()
    `;
    return !!(await this.pollEval(goneJs, 900, 50));
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
  // Allow closing the last remaining tile — Cursor may still expose Close / Ctrl+W.
  // (Previously we bailed when tiles.length <= 1, which made the red × look dead.)
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
  const roots = tileRoots();
  if (roots.length === 0) return true;
  return !roots.some(t => agentIdOf(t) === TARGET);
})()
    `;
    try {
      const trigger = await this.session.evaluate(triggerJs, false) as { x?: number; y?: number } | false;
      if (!trigger || typeof trigger.x !== "number" || typeof trigger.y !== "number") {
        return false;
      }
      await this.clickAt(trigger.x, trigger.y);
      // Poll for the "Close" menu item instead of a fixed wait — it renders fast.
      const close = (await this.pollEval(closeJs, 700, 40)) as
        | { x?: number; y?: number }
        | false
        | undefined;
      if (!close || typeof close.x !== "number" || typeof close.y !== "number") {
        return false;
      }
      await this.clickAt(close.x, close.y);
      // Poll for the tile to actually vanish rather than waiting a flat 900ms.
      return !!(await this.pollEval(goneJs, 1200, 60));
    } catch {
      return false;
    }
  }

  /** Close the tile at a given index (for tiles with no resolvable agentId).
   *  Returns true once the tile count drops. */
  async closeTileByIndex(index: number): Promise<boolean> {
    if (!this.session || !Number.isInteger(index) || index < 0) return false;
    const triggerJs = `
(function() {
  const IDX = ${index};
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  // Allow closing the last tile (same rationale as closeAgentTile).
  if (IDX >= tiles.length) return false;
  function tileMenuTrigger(tile, idx) {
    const inTile = tile?.querySelector('[aria-label="Tile actions"],.glass-agent-conversation-tiling__menu-trigger');
    if (inTile) return inTile;
    const actions = [...document.querySelectorAll('[aria-label="Tile actions"],.glass-agent-conversation-tiling__menu-trigger')]
      .filter(e => e.offsetParent);
    return actions[idx] || null;
  }
  const trig = tileMenuTrigger(tiles[IDX], IDX);
  if (!trig) return false;
  const r = trig.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, count: tiles.length };
})()
    `;
    const closeJs = `
(function() {
  const items = [...document.querySelectorAll('[role^="menuitem"],[role="option"]')]
    .filter(e => e.offsetParent);
  const close = items.find(e => (e.textContent || '').trim().toLowerCase().startsWith('close'));
  if (!close) return false;
  const r = close.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()
    `;
    try {
      const trigger = (await this.session.evaluate(triggerJs, false)) as
        | { x?: number; y?: number; count?: number }
        | false;
      if (!trigger || typeof trigger.x !== "number" || typeof trigger.y !== "number") {
        return false;
      }
      const before = typeof trigger.count === "number" ? trigger.count : 0;
      await this.clickAt(trigger.x, trigger.y);
      const close = (await this.pollEval(closeJs, 700, 40)) as
        | { x?: number; y?: number }
        | false
        | undefined;
      if (!close || typeof close.x !== "number" || typeof close.y !== "number") {
        return false;
      }
      await this.clickAt(close.x, close.y);
      // Poll until the tile count actually drops below the pre-close count
      // (including 1 → 0 when closing the last tile).
      const droppedJs = `document.querySelectorAll('.glass-agent-conversation-tiling__tile').length < ${before}`;
      return !!(await this.pollEval(droppedJs, 1200, 60));
    } catch {
      return false;
    }
  }

  /** Equalize every agent tile to the same width. Cursor's tiling is a binary
   *  split tree (`.ui-tiling` → `.ui-tiling-branch` → `.ui-tiling-child`…), and
   *  each Ctrl+D split halves the focused pane, so repeated spawns leave the
   *  leaves lopsided (50% / 25% / 12.5% / …). We can't just set every split to
   *  50/50 — that's what causes the imbalance — so instead we weight each branch's
   *  children by how many leaf panels live under each side. Setting flex-basis on
   *  the `.ui-tiling-child` wrappers (same property Cursor itself uses) makes all
   *  leaves render at equal size. Returns true when at least one tiling tree was
   *  balanced. */
  async equalizeTiles(): Promise<boolean> {
    if (!this.session) return false;
    const js = `
(function() {
  const root = document.querySelector('.ui-tiling');
  if (!root) return false;
  const leaves = (el) => {
    const p = el.querySelectorAll('.ui-tiling-panel');
    return p.length || 1;
  };
  function balance(branch) {
    const kids = [...branch.children].filter(
      (c) => c.classList && c.classList.contains('ui-tiling-child')
    );
    if (!kids.length) return;
    const counts = kids.map(leaves);
    const total = counts.reduce((a, b) => a + b, 0) || kids.length;
    kids.forEach((c, i) => {
      const pct = (counts[i] / total) * 100;
      c.style.flexBasis = 'calc(' + pct + '% - var(--tiling-sash-layout-size) / 2)';
      const inner = [...c.children].find(
        (x) => x.classList && x.classList.contains('ui-tiling-branch')
      );
      if (inner) balance(inner);
    });
  }
  const top = [...root.children].find(
    (x) => x.classList && x.classList.contains('ui-tiling-branch')
  );
  if (!top) return false;
  balance(top);
  return true;
})()
    `;
    try {
      return !!(await this.session.evaluate(js, false));
    } catch {
      return false;
    }
  }

  /** Hide (not remove) the "Payment failed … Manage Billing" banner(s). The banner
   *  has no native dismiss button, so we set display:none on any matching
   *  `.ui-short-tray`. Hiding (vs removing) keeps the node in the DOM so React's
   *  reconciler stays happy. No in-page observer — the caller re-applies this on the
   *  regular poll (status change + self-heal tick), so a React re-render that brings
   *  the banner back is undone on the next poll. Idempotent and cheap. Returns how
   *  many were hidden. */
  async hideBillingBanners(): Promise<number> {
    if (!this.session) return 0;
    const js = `
(function(){
  let n = 0;
  document.querySelectorAll('.ui-short-tray').forEach(tr => {
    if (/payment failed|manage billing/i.test(tr.textContent || '')) {
      if (tr.style.display !== 'none') tr.style.display = 'none';
      n++;
    }
  });
  return n;
})()
    `;
    try {
      const v = await this.session.evaluate(js, false);
      return typeof v === "number" ? v : 0;
    } catch {
      return 0;
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

  // The server-drop fingerprint, confirmed by CDP-inspecting a live drop: when the
  // held-open call dies (server crash/restart, transport break, client abort),
  // Cursor marks the in-flight check_messages tool card as **Cancelled** — it
  // carries data-tool-status="cancelled" and renders "Cancelled Check Messages in
  // jefr". A healthy call reads "Running…" then "Ran" (status running/completed),
  // so only a cancelled/failed/errored status is a drop. We key off the card's own
  // status (attribute + its lead status word) — NEVER the delivered reply text —
  // so a reply that merely contains "error" can't false-trip it.
  function mcpErroredIn(t) {
    const toolCards = [...t.querySelectorAll('[data-message-kind="tool"]')];
    // Only the MOST RECENT jefr check_messages card matters: an agent that
    // dropped then reconnected leaves an old "Cancelled" card up the transcript
    // while its newest card reads "Running"/"Ran". Judging by the latest card
    // alone means a recovered agent isn't stuck looking dropped.
    let last = null;
    for (const m of toolCards) {
      const txt = m.textContent || '';
      if (!/check\\s*messages/i.test(txt) || !/jefr/i.test(txt)) continue;
      last = m;
    }
    if (!last) return false;
    const status = (last.getAttribute('data-tool-status') || '').toLowerCase();
    if (/cancel|error|fail|abort|reject/.test(status)) return true;
    // Fallback for builds without the status attribute: the card text begins with
    // its status word, e.g. "CancelledCheck Messages in jefr".
    const txt = last.textContent || '';
    if (/^\\s*(cancel|failed|errored|aborted|rejected)/i.test(txt)) return true;
    return false;
  }

  // The agent is actively WORKING when any tool call is mid-flight: a tool card in
  // a running/loading status, or carrying a live shimmer/spinner. This is true
  // even when the submit button isn't in "stop" mode (tool execution happens
  // between text generations). Without it, a long turn between check_messages
  // calls reads as idle and can be misflagged as dropped. Verified via CDP: a
  // working tile has a tool card with data-tool-status="loading".
  function toolWorkingIn(t) {
    const cards = [...t.querySelectorAll('[data-message-kind="tool"]')];
    for (const m of cards) {
      const status = (m.getAttribute('data-tool-status') || '').toLowerCase();
      const cls = typeof m.className === 'string' ? m.className : '';
      const running =
        /run|load|pend|progress|stream/.test(status) ||
        /with-stop/.test(cls) ||
        !!m.querySelector('[class*="shimmer"],[class*="spinner"],.codicon-modifier-spin,[data-state="stop"]');
      if (running) return true;
    }
    return false;
  }

  // Model label from the LAST composer on the tile. A tile can host multiple
  // chat pickers; querySelector's first match is often a stale "Auto" from an
  // earlier composer, while the live follow-up is last.
  function modelOf(t) {
    const eds = [...t.querySelectorAll('.tiptap.ProseMirror.ui-prompt-input-editor__input')]
      .filter((e) => !e.closest('.prompt-edit-input'));
    const ed = eds[eds.length - 1];
    const root = ed
      ? (ed.closest('.ui-prompt-input') || ed.closest('.agent-prompt-input-root'))
      : null;
    const fromComposer = root?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
    if (fromComposer) return fromComposer;
    const texts = [...t.querySelectorAll('.ui-model-picker__trigger-text')]
      .filter((el) => !el.closest('.prompt-edit-input'));
    return texts[texts.length - 1]?.textContent?.trim() || '';
  }

  return tiles.map((t, i) => {
    const submits = [...t.querySelectorAll('.ui-prompt-input-submit-button')]
      .filter((b) => !b.closest('.prompt-edit-input'));
    const submit = submits[submits.length - 1];
    const aria = submit?.getAttribute('aria-label') || '';
    const generating = submits.some((b) => b.getAttribute('data-state') === 'stop') || /stop generation/i.test(aria);

    const sh = t.querySelector('.ui-collapsible-action.ui-collapsible-shimmer')?.textContent || '';
    const planning = /planning\\s+next\\s+move/i.test(sh);

    const mcpRunning = mcpRunningIn(t);
    const toolWorking = toolWorkingIn(t);
    // Visibly busy this poll — the strongest life signal. Every "ended" signal
    // below is gated on its absence: a live MCP card, generation, planning, or a
    // running tool means any cancelled card / stamp / standby text is stale.
    const busyNow = mcpRunning || generating || planning || toolWorking;
    // A cancelled-card drop only counts when the tile isn't otherwise busy — an
    // agent that recovered and is generating / running a tool again must not read
    // as dropped from a stale "Cancelled" card left up the transcript.
    const mcpErrored = !busyNow && mcpErroredIn(t);

    // "Worked for ..." completion stamp = the turn ended (MCP cut out). Trust the
    // live status/followup area directly. The tail fallback only counts when the
    // stamp sits at the very END of the visible text: during a new turn the
    // previous turn's stamp is still inside the last 400 chars (above the fresh
    // content), and an unanchored match flipped working agents to "Dropped".
    const statusText = [
      ...[...t.querySelectorAll('.glass-chat-status-bar__segment-label')].map(e => e.textContent || ''),
      t.querySelector('.agent-panel-followup-status-area')?.textContent || '',
    ].join(' ').replace(/\\s+/g, ' ').trim();
    const full = (t.innerText || '').replace(/\\s+/g, ' ');
    const tail = full.length > 400 ? full.slice(-400) : full;
    const worked =
      !busyNow &&
      (/worked for\\s+[\\dhms ]+/i.test(statusText) || /worked for\\s+[\\dhms ]+\\s*$/i.test(tail));

    // Restored-draft signal: when a held-open turn dies, Cursor puts the un-sent
    // prompt back into the composer. A tile sitting idle with the injected spawn
    // prompt still in its composer = the agent is gone, even with no "Worked for…"
    // stamp. Fingerprint-scoped to the spawn prompts so a human-typed draft can't
    // trip it; only meaningful for a previously-connected agent (gated in tile-state).
    const draftEds = [...t.querySelectorAll('.tiptap.ProseMirror')]
      .filter((e) => !e.closest('.prompt-edit-input'));
    const draftEl = draftEds[draftEds.length - 1]
      || t.querySelector('.agent-panel-followup-input .tiptap.ProseMirror')
      || t.querySelector('.tiptap.ProseMirror');
    const draftText = ((draftEl && draftEl.textContent) || '').trim();
    const draftPending =
      !busyNow &&
      draftText.length > 0 &&
      /keep the mcp connection|stand by|check\\s*messages|agent_id|invoke the mcp|call the mcp directly/i.test(draftText);

    // Standby-in-transcript: the agent replied "standing by / waiting" and stopped
    // re-calling check_messages. Catches the drop even when the composer is empty
    // and there's no "Worked for…" stamp — the case that kept reading as Working.
    // Anchored to the END of the visible text: once a new turn starts, fresh
    // content follows the standby reply and pushes it out of this window — an
    // unanchored match kept flagging working agents as "Server dropped".
    const standbyCutoff =
      !busyNow &&
      /standing\\s+by|waiting for your next (instruction|message)/i.test(tail.slice(-200));

    const model = modelOf(t);

    // Live tool-card feed — what this agent is doing RIGHT NOW. Cursor buffers
    // the .jsonl transcript until a turn ends, so for a long-running agent this
    // DOM read is the only source of in-turn activity. Best-effort by design:
    // wrapped so a selector change degrades to an empty list instead of taking
    // down the whole tile query.
    let liveTools = [];
    let liveToolRunning = false;
    try {
      const cards = [...t.querySelectorAll('[data-message-kind="tool"]')];
      const recent = cards.slice(-10);
      for (const m of recent) {
        // Card text starts with its status word ("Ran"/"Running"/"Cancelled"),
        // then the action. Strip the status so the label reads as the action.
        let txt = (m.textContent || '').replace(/\\s+/g, ' ').trim();
        txt = txt.replace(/^(ran|running|cancelled|canceled|failed|errored|aborted|rejected|pending|queued)\\s*/i, '');
        if (!txt) continue;
        liveTools.push(txt.slice(0, 120));
      }
      const last = cards[cards.length - 1];
      if (last) {
        const st = (last.getAttribute('data-tool-status') || '').toLowerCase();
        const cls = typeof last.className === 'string' ? last.className : '';
        liveToolRunning =
          /run|load|pend|progress|stream|active/.test(st) ||
          /with-stop/.test(cls) ||
          !!last.querySelector('[class*="shimmer"],[class*="spinner"],.codicon-modifier-spin,[data-state="stop"]');
      }
    } catch (e) {
      liveTools = [];
      liveToolRunning = false;
    }

    // Billing-blocked banner: "Payment failed … Manage Billing" (a .ui-short-tray
    // with a Manage Billing button). Scoped to short tray/button text so a chat
    // message that merely mentions billing can't false-trip it.
    const billingBlocked = [...t.querySelectorAll('.ui-short-tray, .ui-button, button, a')]
      .some(e => {
        const x = (e.textContent || '').trim();
        return x.length < 160 && /payment failed|manage billing/i.test(x);
      });

    // Precedence: a live MCP call wins over planning/generating, so a transient
    // "Planning next moves" shimmer can't demote a held-open connection (which
    // previously flip-flopped the state, inflating connect counts and resetting
    // uptime).
    // A "Worked for…" stamp or a restored draft means the turn ended, so a still-
    // "running" jefr card is stale and must NOT force mcp_connected (that was masking
    // cut-off tiles as connected/working).
    let state = 'idle';
    if (mcpRunning && !worked && !draftPending && !standbyCutoff) state = 'mcp_connected';
    else if (planning) state = 'planning';
    else if (generating) state = 'generating';
    else if (toolWorking) state = 'generating';

    return {
      index: i,
      agentId: agentIdOf(t),
      model,
      state,
      mcpVisible: mcpRunning,
      mcpErrored,
      generating: generating || toolWorking,
      planning,
      worked,
      draftPending,
      standbyCutoff,
      billingBlocked,
      liveTools,
      liveToolRunning,
      statusText: statusText.slice(0, 160),
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
