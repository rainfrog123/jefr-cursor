function detectLayout() {
  const tiling = tiles().length;
  const shells = document.querySelectorAll('.agent-panel-conversation-shell').length;
  const editors = document.querySelectorAll('.tiptap.ProseMirror.ui-prompt-input-editor__input').length;
  const mode = tiling > 0 ? 'tiled' : (shells >= 1 || editors >= 1 ? 'single-pane' : 'unknown');
  return { mode, tiling, shells, editors, tileActions: document.querySelectorAll('[aria-label="Tile actions"]').length, chatActions: document.querySelectorAll('[aria-label="Chat actions"]').length };
}

function snapshot() {
  const layout = detectLayout();
  const out = { layout, tiles: [] };
  // model of the ACTIVE composer (follow-up if present), not the first picker found
  const activeModel = (i) => modelTriggerIn(i)?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  if (layout.mode === 'tiled') {
    out.tiles = tiles().map((t, i) => ({
      i, title: t.querySelector('.chat-title-tab-title')?.textContent?.trim(),
      model: activeModel(i) || t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim(),
      generating: !!stopIn(t), planning: /planning/i.test(t.querySelector('.ui-collapsible-shimmer')?.textContent || ''),
    }));
  } else {
    out.tiles = [{
      i: 0, title: document.querySelector('.chat-title-tab-title')?.textContent?.trim(),
      model: activeModel(0) || document.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim(),
      generating: !!document.querySelector('.ui-prompt-input-submit-button[data-state="stop"]'),
      planning: /planning/i.test(document.querySelector('.ui-collapsible-shimmer')?.textContent || ''),
    }];
  }
  return out;
}

async function prepareOneTile() {
  const log = [];
  const before = snapshot();
  log.push({ step: 'before', ...before });

  if (before.layout.mode === 'single-pane') {
    return { ok: true, count: 1, layout: 'single-pane', log, baseTile: 0, newTileAfterSplit: 1 };
  }

  if (before.layout.mode === 'tiled') {
    // always collapse back to a single base tile so the workflow can start with
    // a fresh Ctrl+D split (close every tile except the base tile 0)
    while (tiles().length > 1) {
      const idx = tiles().length - 1;
      if (idx < 1) break;
      const r = await closeTile(idx);
      log.push(r);
      if (r.error) return { error: r.error, log, snapshot: snapshot() };
      if (!tileAt(0)) return { error: 'tile 0 vanished', log, snapshot: snapshot() };
    }
    const after = snapshot();
    log.push({ step: 'afterTrim', ...after });
    if (after.layout.tiling !== 1) return { error: 'expected 1 tiled pane', log, snapshot: after };
    return { ok: true, count: 1, layout: 'tiled', log, baseTile: 0, newTileAfterSplit: 1 };
  }

  return { error: 'unknown layout', log, snapshot: before };
}

async function enforceTwoTilesAfterSplit() {
  const log = [];
  const before = snapshot();
  log.push({ step: 'afterSplit', ...before });

  if (before.layout.mode === 'tiled') {
    while (tiles().length > 2) {
      const r = await closeTile(tiles().length - 1);
      log.push(r);
      if (r.error) return { error: r.error, log, snapshot: snapshot() };
    }
    const after = snapshot();
    return after.layout.tiling === 2
      ? { ok: true, layout: 'tiled', count: 2, baseTile: 0, newTile: 1, log, snapshot: after }
      : { error: 'expected 2 tiles', log, snapshot: after };
  }

  // single-pane after split should become tiled
  await sleep(500);
  const after = snapshot();
  if (after.layout.tiling === 2) {
    return { ok: true, layout: 'tiled', count: 2, baseTile: 0, newTile: 1, log, snapshot: after };
  }
  return { error: 'split did not create 2 tiles', log, snapshot: after };
}

// editor/composer scoped to tile index (or document in single-pane)
function rootForTile(idx) {
  return tiles().length > 0 ? tileAt(idx) : (document.querySelector('.agent-panel-conversation-shell') || document);
}

// All prompt editors in a tile, EXCLUDING inline "edit previous message" boxes.
function editorsIn(idx) {
  const root = rootForTile(idx);
  if (!root) return [];
  return [...root.querySelectorAll('.tiptap.ProseMirror.ui-prompt-input-editor__input')]
    .filter(ed => !ed.closest('.prompt-edit-input'));
}

function isFollowupEditor(ed) {
  if (ed.closest('.agent-panel-followup-input')) return true;
  const ph = ed.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')
    || ed.getAttribute('data-placeholder') || '';
  return /send follow-?up/i.test(ph);
}

// The composer we should drive: prefer the live "Send follow-up" input of an
// active conversation; otherwise the main composer (last non-edit editor).
function editorIn(idx) {
  const eds = editorsIn(idx);
  if (eds.length === 0) return null;
  return eds.find(isFollowupEditor) || eds[eds.length - 1];
}

// The .ui-prompt-input container wrapping the active composer (for sibling lookups).
function composerRootIn(idx) {
  const ed = editorIn(idx);
  return ed ? (ed.closest('.ui-prompt-input') || ed.closest('.agent-prompt-input-root')) : null;
}

function focusEditorIn(idx) {
  const ed = editorIn(idx);
  if (!ed) return null;
  ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  ed.focus(); ed.click();
  return ed;
}

function modelTriggerIn(idx) {
  const trig = composerRootIn(idx)?.querySelector('.ui-model-picker__trigger');
  if (trig) return trig;
  if (tiles().length > 0) return tileAt(idx)?.querySelector('.ui-model-picker__trigger');
  if (idx === 0) return document.querySelector('.ui-model-picker__trigger');
  return null;
}

function submitIn(idx) {
  const btn = composerRootIn(idx)?.querySelector('.ui-prompt-input-submit-button');
  if (btn) return btn;
  if (tiles().length > 0) return tileAt(idx)?.querySelector('.ui-prompt-input-submit-button');
  return document.querySelector('.ui-prompt-input-submit-button');
}

function aiMessagesInTile(idx) {
  const root = tiles().length > 0 ? tileAt(idx) : document.querySelector('.agent-panel-conversation-shell') || document;
  return [...root.querySelectorAll('[data-message-role="ai"]')];
}

function latestAiText(idx) {
  const msgs = aiMessagesInTile(idx);
  const last = msgs[msgs.length - 1];
  return last ? (last.innerText || last.textContent || '').trim() : '';
}

function stopInIdx(idx) {
  if (tiles().length > 0) return stopIn(tileAt(idx));
  const b = document.querySelector('.ui-prompt-input-submit-button[data-state="stop"]');
  return b || null;
}
