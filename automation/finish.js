(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const PROMPT = '123';
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const target = tiles.at(-1);
  if (!target) return { error: 'no tile' };
  const ed = target.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');
  if (!ed) return { error: 'no editor' };
  ed.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); ed.focus(); ed.click();
  await sleep(80);

  // model -> Auto
  const mt = target.querySelector('.ui-model-picker__trigger');
  const cur = mt?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  if (mt && cur !== 'Auto') {
    mt.click(); await sleep(300);
    const vis = [...document.querySelectorAll('[role^="menuitem"],[role="option"]')].filter(e => e.offsetParent);
    const auto = vis.find(e => /^auto/i.test(e.textContent.trim()));
    if (auto) auto.click();
    await sleep(250); ed.focus();
  }

  // type
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, PROMPT);
  await sleep(120);
  const typed = ed.textContent.includes(PROMPT);
  if (!typed) return { error: 'insert failed', model: mt?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() };

  // send
  const send = target.querySelector('.ui-prompt-input-submit-button');
  const stateBefore = send?.getAttribute('data-state');
  let sent = false;
  if (send && stateBefore !== 'stop' && !/voice|mic/i.test(send.getAttribute('aria-label') || '')) { send.click(); sent = true; }
  await sleep(900);
  const stateAfterSend = target.querySelector('.ui-prompt-input-submit-button')?.getAttribute('data-state');

  // stop after 5s
  await sleep(5000);
  const stopBtn = target.querySelector('.ui-prompt-input-submit-button[data-state="stop"]');
  let stopped = false;
  if (stopBtn) { stopBtn.click(); stopped = true; }
  const finalState = target.querySelector('.ui-prompt-input-submit-button')?.getAttribute('data-state');

  return {
    model: mt?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim(),
    typed, sent, stateBefore, stateAfterSend, stopped, finalState,
  };
})()
