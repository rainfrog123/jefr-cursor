// Tile helpers — prepended before workflow scripts
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function tiles() {
  const tiled = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  if (tiled.length > 0) return tiled;
  const shell = document.querySelector('.agent-panel-conversation-shell');
  return shell ? [shell] : [];
}
function tileAt(i) { return tiles()[i] ?? null; }
function visMenu() {
  return [...document.querySelectorAll('[role^="menuitem"],[role="option"]')].filter(e => e.offsetParent);
}
function findMenu(txt) {
  return visMenu().find(e => e.textContent.trim().toLowerCase().startsWith(txt.toLowerCase()));
}
function stopIn(el) {
  return el?.querySelector('.ui-prompt-input-submit-button[data-state="stop"]') ?? null;
}

function focusEditor(t) {
  const ed = t?.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');
  if (!ed) return null;
  ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  ed.focus(); ed.click();
  return ed;
}

function tileMenuTrigger(i) {
  const t = tiles()[i];
  const inTile = t?.querySelector('[aria-label="Tile actions"],.glass-agent-conversation-tiling__menu-trigger');
  if (inTile) return inTile;
  const actions = [...document.querySelectorAll('[aria-label="Tile actions"]')];
  return actions[i] ?? null;
}

async function closeTile(idx) {
  const countBefore = tiles().length;
  if (idx <= 0) return { error: 'refuse to close tile 0 (base tile)', idx };
  const trig = tileMenuTrigger(idx);
  if (!trig) return { error: 'no Tile actions', idx, countBefore };
  trig.click();
  await sleep(350);
  const close = findMenu('Close');
  if (!close) { trig.click(); return { error: 'no Close menu item', idx, countBefore }; }
  close.click();
  await sleep(900);
  return { ok: true, closed: idx, remaining: tiles().length, countBefore };
}

async function closeExtraTiles(keep) {
  const log = [];
  while (tiles().length > keep) {
    const idx = tiles().length - 1;
    if (keep >= 1 && idx < 1) break;
    const r = await closeTile(idx);
    log.push(r);
    if (r.error) return { error: r.error, count: tiles().length, log };
  }
  return { kept: tiles().length, log };
}

function dismissMenus() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
}

async function waitForAiResponse(idx, beforeCount, maxMs) {
  maxMs = maxMs || 90000;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(300);
    const msgs = aiMessagesInTile(idx);
    if (msgs.length > beforeCount) {
      const text = latestAiText(idx);
      if (text.length > 15 && !/^Planning next move/i.test(text)) {
        return { ok: true, aiCount: msgs.length, preview: text.slice(0, 160) };
      }
    }
  }
  return { ok: false, aiCount: aiMessagesInTile(idx).length, preview: latestAiText(idx).slice(0, 160) };
}

async function waitIdle(idx, maxMs) {
  maxMs = maxMs || 15000;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!stopInIdx(idx)) return true;
    await sleep(200);
  }
  return false;
}

async function openModelPicker(idx) {
  dismissMenus();
  await sleep(150);
  focusEditorIn(idx);
  await sleep(120);
  const trigger = modelTriggerIn(idx);
  if (!trigger) return null;
  trigger.click();
  await sleep(550);
  return trigger;
}

async function clickVisibleMenu(labelRe) {
  const item = visMenu().find(e => labelRe.test((e.textContent || '').trim()));
  if (!item) return { error: 'not found', label: String(labelRe) };
  const el = item.querySelector('[role="menuitem"],button,a') || item;
  if (typeof el.click === 'function') el.click();
  await sleep(400);
  return { ok: true, text: item.textContent.trim() };
}

/** Select GPT-5.5 with 1M context and High tier (Edit submenu).
 *  `pin` is an agentId string (preferred) or numeric tile index. */
async function selectGpt55High(pin) {
  const getIdx = () => (typeof pin === 'string' ? idxByAgentId(pin) : pin);
  const agentId = typeof pin === 'string' ? pin : agentIdOfTile(tileAt(pin));
  const triggerText = () =>
    modelTriggerIn(getIdx())?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() || '';

  async function focusTile() {
    const i = getIdx();
    if (i < 0) return false;
    focusEditorIn(i);
    await sleep(120);
    return true;
  }

  if (!(await focusTile())) return { error: 'tile not found', agentId, idx: getIdx() };
  let before = triggerText();
  if (/GPT-5\.5 1M High/i.test(before || '')) {
    return { ok: true, model: before, skipped: true, idx: getIdx(), agentId };
  }
  if (!modelTriggerIn(getIdx())) return { error: 'no picker', idx: getIdx(), agentId };

  async function ensureFullMenu() {
    let items = visMenu();
    const hasGpt = items.some(e =>
      e.getAttribute('role') === 'menuitem' &&
      e.querySelector('.ui-model-picker__item-content') &&
      /GPT-5\.5/i.test(e.textContent)
    );
    if (hasGpt) return true;
    const autoRow = items.find(e => /^auto/i.test((e.textContent || '').trim()));
    const sw = autoRow?.querySelector('button,[role="switch"],input[type="checkbox"]');
    if (sw) { sw.click(); await sleep(600); return true; }
    if (autoRow) { autoRow.click(); await sleep(600); return true; }
    return false;
  }

  async function openPicker() {
    dismissMenus();
    await sleep(150);
    if (!(await focusTile())) return null;
    const trig = modelTriggerIn(getIdx());
    if (!trig) return null;
    trig.click();
    await sleep(550);
    return trig;
  }

  let trigger = await openPicker();
  if (!trigger) return { error: 'no picker', idx: getIdx(), agentId };
  await ensureFullMenu();

  let gptRow = visMenu().find(e =>
    e.getAttribute('role') === 'menuitem' &&
    e.querySelector('.ui-model-picker__item-content') &&
    /^GPT-5\.5/i.test((e.textContent || '').trim())
  );
  if (!gptRow) {
    dismissMenus();
    return { error: 'model not found', before, options: visMenu().map(e => e.textContent.trim()), agentId };
  }
  gptRow.click();
  await sleep(400);

  trigger = await openPicker();
  if (!trigger) return { error: 'no picker after gpt', idx: getIdx(), agentId };
  let r = await clickVisibleMenu(/^Edit$/i);
  if (r.error) {
    dismissMenus();
    return { error: 'edit not found', before, options: visMenu().map(e => e.textContent.trim()), agentId };
  }

  await clickVisibleMenu(/^1M$/i);
  await sleep(200);
  r = await clickVisibleMenu(/^High$/i);
  if (r.error) {
    dismissMenus();
    return { error: 'high tier not found', before, agentId };
  }

  dismissMenus();
  await sleep(300);
  const after = triggerText();
  if (!/GPT-5\.5/i.test(after || '')) {
    return { error: 'gpt not selected', before, after, idx: getIdx(), agentId };
  }
  return { ok: true, idx: getIdx(), agentId, before, after };
}

async function selectGpt55HighByAgent(agentId) {
  if (idxByAgentId(agentId) < 0) return { error: 'tile not found for agentId', agentId };
  return selectGpt55High(agentId);
}

/** True when `label` requests Opus 4.8 1M High Fast (not Extra High). */
function isOpusHighFastLabel(label) {
  return /Opus 4\.8/i.test(label) && /High Fast/i.test(label) && !/Extra High/i.test(label);
}

/** True when `label` requests Opus 4.8 1M Extra High Fast. */
function isOpusExtraHighFastLabel(label) {
  return /Opus 4\.8/i.test(label) && /Extra High Fast/i.test(label);
}

/** Select Opus 4.8 with 1M context, a thinking tier (High | Extra High), and Fast.
 *  `pin` is an agentId string (preferred) or numeric tile index — the live index
 *  is re-resolved from agentId before every focus/picker action so we never
 *  wander onto a neighbouring tile. */
async function selectOpus481MFast(pin, tier) {
  const tierLabel = tier === 'Extra High' ? 'Extra High' : 'High';
  const expectedRe = tierLabel === 'Extra High'
    ? /Opus 4\.8 1M Extra High Fast/i
    : /Opus 4\.8 1M High Fast/i;
  const getIdx = () => (typeof pin === 'string' ? idxByAgentId(pin) : pin);
  const agentId = typeof pin === 'string' ? pin : agentIdOfTile(tileAt(pin));
  const triggerText = () =>
    modelTriggerIn(getIdx())?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() || '';

  async function focusTile() {
    const i = getIdx();
    if (i < 0) return false;
    focusEditorIn(i);
    await sleep(120);
    return true;
  }

  function menuLabel(e) {
    return (e.textContent || '').trim().replace(/\s*Edit\s*$/i, '').trim();
  }

  function configuredOpusRowInMenu() {
    return visMenu().find(e =>
      e.getAttribute('role') === 'menuitem' && expectedRe.test(menuLabel(e))
    );
  }

  function opusBaseRowInMenu() {
    return visMenu().find(e =>
      e.getAttribute('role') === 'menuitem' &&
      e.querySelector('.ui-model-picker__item-content') &&
      /Opus 4\.8/i.test(menuLabel(e)) &&
      !expectedRe.test(menuLabel(e))
    );
  }

  async function openFullMenu() {
    dismissMenus();
    await sleep(150);
    if (!(await focusTile())) return null;
    const trig = modelTriggerIn(getIdx());
    if (!trig) return null;
    trig.click();
    await sleep(550);
    if (!configuredOpusRowInMenu() && !opusBaseRowInMenu()) {
      const autoRow = visMenu().find(e => /^auto/i.test((e.textContent || '').trim()));
      const sw = autoRow?.querySelector('button,[role="switch"],input[type="checkbox"]');
      if (sw) { sw.click(); await sleep(600); }
      else if (autoRow) { autoRow.click(); await sleep(600); }
      dismissMenus();
      await sleep(200);
      if (!(await focusTile())) return null;
      const trig2 = modelTriggerIn(getIdx());
      if (!trig2) return null;
      trig2.click();
      await sleep(550);
    }
    return modelTriggerIn(getIdx());
  }

  async function waitForExpected(before) {
    let after = '';
    for (let i = 0; i < 10; i++) {
      after = triggerText();
      if (expectedRe.test(after || '')) break;
      await sleep(200);
    }
    if (!expectedRe.test(after || '')) {
      return { error: `opus ${tierLabel.toLowerCase()} fast not selected`, before, after, idx: getIdx(), agentId };
    }
    return { ok: true, idx: getIdx(), agentId, before, after };
  }

  if (!(await focusTile())) return { error: 'tile not found', agentId, idx: getIdx() };
  let before = triggerText();
  if (expectedRe.test(before || '')) {
    return { ok: true, model: before, skipped: true, idx: getIdx(), agentId };
  }
  if (!modelTriggerIn(getIdx())) return { error: 'no picker', idx: getIdx(), agentId };

  const trigger = await openFullMenu();
  if (!trigger) return { error: 'no picker', idx: getIdx(), agentId };

  // Prefer the fully-labelled row ("Opus 4.8 1M Extra High Fast") — clicking the
  // base Opus row alone often sticks on High Fast as the saved default.
  const configured = configuredOpusRowInMenu();
  if (configured) {
    configured.click();
    await sleep(400);
    dismissMenus();
    await sleep(300);
    const direct = await waitForExpected(before);
    if (direct.ok) return { ...direct, via: 'directRow' };
  }

  let opusRow = opusBaseRowInMenu() || opusRowInMenuFallback();
  function opusRowInMenuFallback() {
    return visMenu().find(e =>
      e.getAttribute('role') === 'menuitem' &&
      e.querySelector('.ui-model-picker__item-content') &&
      /Opus 4\.8/i.test(menuLabel(e))
    );
  }
  if (!opusRow) {
    dismissMenus();
    return { error: 'model not found', before, options: visMenu().map(e => e.textContent.trim()), agentId };
  }
  opusRow.click();
  await sleep(400);

  dismissMenus();
  await sleep(200);
  if (!(await focusTile())) return { error: 'tile lost before edit menu', agentId };
  modelTriggerIn(getIdx())?.click();
  await sleep(550);
  opusRow = opusBaseRowInMenu() || opusRowInMenuFallback();
  const editBtn = opusRow?.querySelector('.ui-model-picker__edit-btn') ||
    opusRow?.querySelector('button[class*="edit"]');
  if (editBtn) {
    editBtn.click();
  } else {
    let r = await clickVisibleMenu(/^Edit$/i);
    if (r.error) {
      dismissMenus();
      return { error: 'edit not found', before, options: visMenu().map(e => e.textContent.trim()), agentId };
    }
  }
  await sleep(400);

  await clickVisibleMenu(/^1M$/i);
  await sleep(200);
  const tierItem = visMenu().find(e => {
    const t = (e.textContent || '').trim();
    return tierLabel === 'Extra High' ? /^Extra High$/i.test(t) : /^High$/i.test(t);
  });
  if (!tierItem) {
    dismissMenus();
    return { error: `${tierLabel.toLowerCase()} tier not found`, before, agentId };
  }
  (tierItem.querySelector('[role="menuitem"],button,a') || tierItem).click();
  await sleep(400);
  const fastItem = visMenu().find(e =>
    /^Fast$/i.test((e.textContent || '').trim())
  );
  if (!fastItem) {
    dismissMenus();
    return { error: 'fast tier not found', before, agentId };
  }
  if (fastItem.getAttribute('aria-checked') !== 'true') {
    fastItem.click();
    await sleep(250);
  }

  dismissMenus();
  await sleep(300);
  return { ...(await waitForExpected(before)), via: 'editMenu' };
}

async function selectOpus48HighFast(pin) {
  return selectOpus481MFast(pin, 'High');
}

async function selectOpus48ExtraHighFast(pin) {
  return selectOpus481MFast(pin, 'Extra High');
}

async function selectOpus48HighFastByAgent(agentId) {
  if (idxByAgentId(agentId) < 0) return { error: 'tile not found for agentId', agentId };
  return selectOpus48HighFast(agentId);
}

async function selectOpus48ExtraHighFastByAgent(agentId) {
  if (idxByAgentId(agentId) < 0) return { error: 'tile not found for agentId', agentId };
  return selectOpus48ExtraHighFast(agentId);
}

async function selectModel(t, namePattern) {
  const re = typeof namePattern === 'string' ? new RegExp(namePattern, 'i') : namePattern;
  let idx = typeof t === 'number' ? t : tiles().indexOf(t);
  if (idx < 0) idx = Math.max(0, tiles().length - 1);
  focusEditorIn(idx);
  await sleep(120);
  let trigger = modelTriggerIn(idx);
  let before = trigger?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  if (before && re.test(before)) return { ok: true, model: before, skipped: true, idx };
  if (!trigger) return { error: 'no picker', idx };

  async function openMenu() {
    dismissMenus();
    await sleep(150);
    trigger = modelTriggerIn(idx);
    if (!trigger) return [];
    trigger.click();
    await sleep(550);
    return visMenu();
  }

  async function closeMenu() {
    trigger?.click();
    await sleep(200);
  }

  async function pickFromOpen(items) {
    const pick = (list) => list.find(e => {
      const txt = (e.textContent || '').trim();
      return re.test(txt) || re.test(txt.replace(/Edit$/i, ''));
    });
    return pick(items.filter(e => e.getAttribute('role') === 'menuitem'))
        || pick(items.filter(e => (e.getAttribute('role') || '').includes('menuitem')));
  }

  async function pickTargetModelFromTile0() {
    if (idx === 0) return null;
    // Read tile 0's picker labels WITHOUT focusing tile 0 — focus steal is what
    // caused model changes to land on the wrong tile when idx > 0.
    dismissMenus();
    await sleep(100);
    const refTrig = modelTriggerIn(0);
    refTrig?.click();
    await sleep(500);
    const items = visMenu();
    const match = items.find(e => /GPT-5\.5/i.test(e.textContent.trim()));
    dismissMenus();
    await sleep(150);
    focusEditorIn(idx);
    await sleep(100);
    return match ? match.textContent.trim().replace(/\s*Edit\s*$/i, '').trim() : null;
  }

  async function clickItem(item) {
    const el = item?.querySelector?.('[role="menuitem"],button,a') || item;
    if (el && typeof el.click === 'function') { el.click(); return true; }
    return false;
  }

  let items = await openMenu();
  let item = await pickFromOpen(items);

  if (!item && /^auto/i.test(before || '') && !/^auto/i.test(re.source)) {
    // compact Auto menu — toggle Auto off via checkbox/switch inside the row
    const autoRow = items.find(e => /^auto/i.test((e.textContent || '').trim()));
    const sw = autoRow?.querySelector('button,[role="switch"],input[type="checkbox"]');
    if (sw) { sw.click(); await sleep(600); }
    else if (autoRow) { await clickItem(autoRow); await sleep(600); }
    trigger = modelTriggerIn(idx);
    before = trigger?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
    items = await openMenu();
    item = await pickFromOpen(items);
  }

  // still stuck in compact Auto — read exact GPT label from tile 0's full picker, retry
  if (!item && idx > 0) {
    await closeMenu();
    const targetLabel = await pickTargetModelFromTile0();
    if (targetLabel) {
      focusEditorIn(idx);
      await sleep(100);
      items = await openMenu();
      const loose = new RegExp(targetLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').split(/\s+/).slice(0, 3).join('.*'), 'i');
      item = items.find(e => loose.test(e.textContent.trim())) || await pickFromOpen(items);
    }
  }

  if (!item) {
    await closeMenu();
    // keyboard walk: open menu and arrow until pattern matches focused/highlighted item
    items = await openMenu();
    for (let n = 0; n < 12; n++) {
      items = visMenu();
      item = await pickFromOpen(items);
      if (item) break;
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
      await sleep(120);
    }
  }

  if (!item) {
    await closeMenu();
    return { error: 'model not found', before, options: items.map(e => e.textContent.trim()) };
  }
  if (!(await clickItem(item))) return { error: 'click failed', before };
  await sleep(350);
  const after = modelTriggerIn(idx)?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  return { ok: true, idx, before, after };
}

// ── agentId-pinned addressing ────────────────────────────────────────────────
// Tile INDEX is unstable across separate CDP evals (opening pickers, toggling
// Auto, splits). The agentId (from the React fiber) is stable, so we resolve the
// live index from it right before each action.

function agentIdOfTile(t) {
  if (!t) return null;
  const k = Object.keys(t).find(
    (x) => x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$')
  );
  let f = k ? t[k] : null, n = 0;
  while (f && n++ < 40) {
    const p = f.memoizedProps;
    if (p && typeof p === 'object' && typeof p.agentId === 'string') return p.agentId;
    f = f.return;
  }
  return null;
}

function idxByAgentId(id) {
  if (!id) return -1;
  return tiles().findIndex((t) => agentIdOfTile(t) === id);
}

/** Route a full picker label to the right agent-pinned selector. */
async function selectTargetModelByAgent(agentId, modelLabel) {
  const label = String(modelLabel || '').trim();
  if (isOpusExtraHighFastLabel(label)) return selectOpus48ExtraHighFastByAgent(agentId);
  if (isOpusHighFastLabel(label)) return selectOpus48HighFastByAgent(agentId);
  if (/GPT-5\.5.*1M High/i.test(label)) return selectGpt55HighByAgent(agentId);
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return selectModelByAgent(agentId, new RegExp(escaped, 'i'));
}

/** Select a model on the tile identified by `agentId` (resolving its live index
 *  each time). No tile-0 fallbacks — every lookup is pinned to the agent, so it
 *  can't wander onto a neighbouring tile. Handles the compact "Auto" menu. */
async function selectModelByAgent(agentId, namePattern) {
  const re = typeof namePattern === 'string' ? new RegExp(namePattern, 'i') : namePattern;
  const label = typeof namePattern === 'string' ? namePattern : (re.source || '');
  if (isOpusExtraHighFastLabel(label)) {
    return selectOpus48ExtraHighFastByAgent(agentId);
  }
  if (isOpusHighFastLabel(label)) {
    return selectOpus48HighFastByAgent(agentId);
  }
  if (/GPT-5\.5.*1M High/i.test(label)) {
    return selectGpt55HighByAgent(agentId);
  }
  const triggerText = () =>
    modelTriggerIn(idxByAgentId(agentId))
      ?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() || '';

  let idx = idxByAgentId(agentId);
  if (idx < 0) return { error: 'tile not found for agentId', agentId };
  focusEditorIn(idx);
  await sleep(150);
  const before = triggerText();
  if (before && re.test(before)) return { ok: true, model: before, skipped: true, idx, agentId };
  if (!modelTriggerIn(idx)) return { error: 'no picker', idx, agentId };

  const openMenu = async () => {
    dismissMenus();
    await sleep(150);
    const i = idxByAgentId(agentId);
    if (i < 0) return false;
    focusEditorIn(i);
    await sleep(120);
    const trig = modelTriggerIn(i);
    if (!trig) return false;
    trig.click();
    await sleep(550);
    return true;
  };

  // Selecting Auto: enable the Auto switch/row (opposite of toggling it off).
  if (/^auto/i.test(re.source)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await openMenu())) return { error: 'no picker', agentId };
      if (/^auto/i.test(triggerText())) {
        dismissMenus();
        return { ok: true, before, after: triggerText(), idx: idxByAgentId(agentId), agentId };
      }
      const autoRow = visMenu().find((e) => /^auto/i.test((e.textContent || '').trim()));
      const sw = autoRow?.querySelector('button,[role="switch"],input[type="checkbox"]');
      if (sw) {
        const on = sw.getAttribute('aria-checked') === 'true' || sw.getAttribute('data-state') === 'checked';
        if (!on) { sw.click(); await sleep(600); }
      } else if (autoRow) {
        autoRow.click();
        await sleep(600);
      }
      dismissMenus();
      await sleep(250);
      if (/^auto/i.test(triggerText())) {
        return { ok: true, before, after: triggerText(), idx: idxByAgentId(agentId), agentId };
      }
    }
    return { error: 'auto not selected', before, after: triggerText(), agentId };
  }

  const rowsNow = () => visMenu().filter(
    (e) => e.getAttribute('role') === 'menuitem' && e.querySelector('.ui-model-picker__item-content')
  );
  const matchRow = () => rowsNow().find(
    (e) => re.test(e.querySelector('.ui-model-picker__item-content')?.textContent || '')
  );

  // Try a few times: open menu, toggle Auto off if the list is hidden (which can
  // auto-pick the first model), RE-OPEN to get the full list, then click the
  // target row and verify the trigger actually changed.
  let lastOptions = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await openMenu())) return { error: 'no picker', agentId };

    if (!matchRow()) {
      const autoRow = visMenu().find((e) => /^auto/i.test((e.textContent || '').trim()));
      const sw = autoRow?.querySelector('button,[role="switch"],input[type="checkbox"]');
      if (sw) { sw.click(); await sleep(600); }
      else if (autoRow) { autoRow.click(); await sleep(600); }
      // Toggling Auto can auto-select the first model and/or close the menu —
      // re-open so the full list is present before we pick the real target.
      await openMenu();
    }

    const row = matchRow();
    lastOptions = rowsNow().map((e) => e.textContent.trim());
    if (row) {
      // Click the menuitem ROW itself (not the inner label/Edit button) with a
      // full pointer sequence — React menu rows select on the row's handler.
      const fire = (el, type) =>
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      fire(row, 'pointerdown');
      fire(row, 'mousedown');
      fire(row, 'pointerup');
      fire(row, 'mouseup');
      row.click();
      await sleep(500);
      dismissMenus();
      await sleep(250);
      if (re.test(triggerText())) {
        return { ok: true, before, after: triggerText(), idx: idxByAgentId(agentId), agentId };
      }
    }
    dismissMenus();
    await sleep(250);
  }
  return { error: 'not selected', before, after: triggerText(), agentId, options: lastOptions };
}

function focusTileFocusEval(idx) {
  return `(()=>{
    const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
    if(ts.length>0){const t=ts[${idx}];const ed=t?.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');ed&&ed.focus();return !!ed;}
    const ed=document.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');ed&&ed.focus();return !!ed;
  })()`;
}
