(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tiles = () => [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const tileAt = i => tiles()[i] ?? null;

  const findPlanningEl = (root) => {
    const hits = [];
    for (const el of root.querySelectorAll('*')) {
      if (el.children.length) continue;
      const txt = el.textContent?.trim();
      if (txt && /planning\s+next\s+move/i.test(txt)) {
        hits.push({
          tag: el.tagName,
          class: el.className?.toString?.().slice(0, 150),
          text: txt,
        });
      }
    }
    return hits;
  };

  const readStatus = (t) => {
    const seg = [...t.querySelectorAll('.glass-chat-status-bar__segment-label')]
      .map(e => e.textContent?.trim()).filter(Boolean);
    const follow = t.querySelector('.agent-panel-followup-status-area')?.textContent?.trim() || '';
    const statusArea = t.querySelector('.glass-chat-status-bar')?.textContent?.trim() || '';
    const hits = findPlanningEl(t);
    return {
      seg, follow, statusArea,
      planningInTile: /planning\s+next\s+move/i.test(t.innerText || ''),
      planningEls: hits,
    };
  };

  let idx = tiles().findIndex(t =>
    t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() === 'Auto');
  if (idx < 0) idx = tiles().length - 1;
  let target = tileAt(idx);
  const ed = target?.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');
  ed?.focus();
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, 'ping');
  await sleep(80);
  target = tileAt(idx);
  const send = target?.querySelector('.ui-prompt-input-submit-button');
  if (send?.getAttribute('data-state') !== 'stop') send?.click();

  for (let i = 0; i < 60; i++) {
    await sleep(200);
    const t = tileAt(idx) ?? tiles().at(-1);
    const s = readStatus(t);
    if (s.planningInTile || s.planningEls.length) {
      return { ms: i * 200, idx, ...s };
    }
  }
  return { idx, planning: false, note: 'not seen within 12s' };
})()
