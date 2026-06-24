(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const RUN_MS = __RUNMS__;
  const PROMPT = "__PROMPT__";

  const tiles = () => [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const tileAt = i => tiles()[i] ?? null;
  const visMenu = () => [...document.querySelectorAll('[role^="menuitem"],[role="option"]')].filter(e => e.offsetParent);
  const stopIn = el => el?.querySelector('.ui-prompt-input-submit-button[data-state="stop"]') ?? null;

  let idx = tiles().length - 1;
  let target = tileAt(idx);
  if (!target) return { error: 'no tile', idx };

  const focusEditor = (t) => {
    const ed = t.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');
    if (!ed) return null;
    ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    ed.focus(); ed.click();
    return ed;
  };

  let ed = focusEditor(target);
  if (!ed) return { error: 'no editor', idx };
  await sleep(80);

  // model -> Auto
  const mt = target.querySelector('.ui-model-picker__trigger');
  const modelBefore = mt?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  if (mt && modelBefore !== 'Auto') {
    mt.click(); await sleep(300);
    const auto = visMenu().find(e => /^auto/i.test(e.textContent.trim()));
    if (auto) auto.click();
    await sleep(250);
    target = tileAt(idx) ?? target;
    ed = focusEditor(target) ?? ed;
  }

  // type
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, PROMPT);
  await sleep(120);
  if (!ed.textContent.includes(PROMPT)) {
    target = tileAt(idx) ?? target;
    ed = target.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');
    if (!ed?.textContent.includes(PROMPT)) return { error: 'insert failed', idx };
  }

  // send — draft tile may re-render after click; always re-query by index
  target = tileAt(idx) ?? target;
  const send = target.querySelector('.ui-prompt-input-submit-button');
  if (!(send && send.getAttribute('data-state') !== 'stop' && !/voice|mic/i.test(send.getAttribute('aria-label') || '')))
    return { error: 'no send button (mic/generating)', idx };
  send.click();

  // wait for generation + detect "Planning next moves"
  let started = false;
  let planning = false;
  let planningText = null;
  for (let i = 0; i < 120; i++) {
    await sleep(150);
    const t = tileAt(idx);
    const st = typeof cursorTileStatus === 'function' ? cursorTileStatus(t) : null;
    if (st?.planning) { planning = true; planningText = st.planningText; }
    if (stopIn(t)) { started = true; }
    if (stopIn(tiles().at(-1))) { started = true; idx = tiles().length - 1; }
    if (started && planning) break;
  }

  await sleep(RUN_MS);

  const t = tileAt(idx) ?? tiles().at(-1);
  const stopBtn = stopIn(t) ?? stopIn(tiles().at(-1));
  const stopped = !!stopBtn;
  if (stopBtn) stopBtn.click();

  const modelAfter = (tileAt(idx) ?? t)?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  return { idx, modelBefore, modelAfter, sent: PROMPT, started, planning, planningText, stopped, tileCount: tiles().length };
})()
