(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const TILE = __TILE__;

  const tiles = () => [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const ts = tiles();
  const ti = TILE >= 0 ? TILE : ts.length - 1;
  const t = ts[ti];
  if (!t) return { error: 'no tile', tileCount: ts.length };

  // focus tile editor so picker opens for this tile
  const ed = t.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');
  ed?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  ed?.focus(); ed?.click();
  await sleep(120);

  const current = t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  const trigger = t.querySelector('.ui-model-picker__trigger');
  if (!trigger) return { error: 'no model picker', tile: ti, current };

  trigger.click();
  await sleep(500);

  const sel = '[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="option"],[data-radix-collection-item]';
  const items = [...document.querySelectorAll(sel)]
    .filter(el => el.offsetParent !== null)
    .map(el => ({
      text: el.textContent.trim().replace(/\s+/g, ' '),
      role: el.getAttribute('role'),
      disabled: el.getAttribute('aria-disabled') === 'true',
    }));

  // dedupe by text
  const seen = new Set();
  const models = items.map(i => i.text).filter(t => { if (seen.has(t)) return false; seen.add(t); return true; });

  trigger.click(); // close
  await sleep(100);

  return { tile: ti, tileCount: ts.length, current, models, items };
})()
