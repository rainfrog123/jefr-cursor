(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const PROMPT = 'say hi';
  const tiles = () => [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const tileAt = i => tiles()[i] ?? null;

  const readStatus = (t) => {
    const labels = [...t.querySelectorAll('.glass-chat-status-bar__segment-label')]
      .map(e => e.textContent?.trim()).filter(Boolean);
    const follow = t.querySelector('.agent-panel-followup-status-area')?.textContent?.trim() || '';
    const combined = [...labels, follow].join(' ');
    const planning = /planning\s+next\s+move/i.test(combined) || /planning\s+next\s+move/i.test(t.innerText || '');
    return { labels, follow, combined, planning };
  };

  // use last tile (or tile with Auto model)
  let idx = tiles().length - 1;
  let target = tileAt(idx);
  const autoIdx = tiles().findIndex(t =>
    t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() === 'Auto');
  if (autoIdx >= 0) { idx = autoIdx; target = tileAt(idx); }

  const ed = target?.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');
  if (!ed) return { error: 'no editor', idx };
  ed.focus(); ed.click();
  await sleep(80);

  const mt = target.querySelector('.ui-model-picker__trigger');
  if (mt && mt.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() !== 'Auto') {
    mt.click(); await sleep(250);
    const auto = [...document.querySelectorAll('[role^="menuitem"],[role="option"]')]
      .filter(e => e.offsetParent).find(e => /^auto/i.test(e.textContent.trim()));
    if (auto) auto.click();
    await sleep(200); ed.focus();
    target = tileAt(idx) ?? target;
  }

  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, PROMPT);
  await sleep(100);
  const send = target.querySelector('.ui-prompt-input-submit-button');
  if (!send || send.getAttribute('data-state') === 'stop') return { error: 'cannot send' };
  send.click();

  const log = [];
  let sawPlanning = false;
  let firstPlanningAt = null;
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    const t = tileAt(idx) ?? tiles().at(-1);
    const s = readStatus(t);
    if (s.planning && !sawPlanning) { sawPlanning = true; firstPlanningAt = i * 200; }
    if (i % 5 === 0 || s.planning) log.push({ ms: i * 200, ...s });
    const stop = t?.querySelector('.ui-prompt-input-submit-button[data-state="stop"]');
    if (!stop && i > 10) break; // generation ended
  }
  return { idx, sawPlanning, firstPlanningAt, log: log.slice(-15) };
})()
