(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const idx = 1;
  const ts = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const t = ts[idx];
  if (!t) return { error: 'no tile 1', tileCount: ts.length };

  const ed = t.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');
  ed?.focus(); ed?.click();
  await sleep(100);

  const tr = t.querySelector('.ui-model-picker__trigger');
  const before = tr?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  const wrapper = tr?.closest('.glass-model-picker-wrapper');
  const compact = wrapper?.getAttribute('data-compact-visible');

  tr?.click();
  await sleep(600);

  const menuRoots = [...document.querySelectorAll('[role="menu"],[data-radix-menu-content]')].map(m => ({
    role: m.getAttribute('role'),
    text: m.textContent?.trim().slice(0, 300),
    childCount: m.children.length,
  }));

  const items = [...document.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"]')]
    .filter(e => e.offsetParent !== null)
    .map(e => ({
      text: e.textContent.trim().replace(/\s+/g, ' ').slice(0, 100),
      role: e.getAttribute('role'),
      checked: e.getAttribute('aria-checked'),
      disabled: e.getAttribute('aria-disabled'),
      html: e.innerHTML.slice(0, 250),
    }));

  // also check tile 0 picker for comparison
  const t0 = ts[0];
  const tr0 = t0?.querySelector('.ui-model-picker__trigger');
  const before0 = tr0?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();

  tr?.click(); // close
  await sleep(200);

  // open tile 0 picker
  tr0?.click();
  await sleep(600);
  const items0 = [...document.querySelectorAll('[role="menuitem"],[role="menuitemcheckbox"],[role="option"]')]
    .filter(e => e.offsetParent !== null)
    .map(e => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 80));
  tr0?.click();

  return {
    tileCount: ts.length,
    tile1: { before, compact, wrapperClass: wrapper?.className?.toString?.().slice(0, 80), items, menuRoots },
    tile0: { before: before0, items: items0 },
    allPickers: [...document.querySelectorAll('.ui-model-picker__trigger')].map((p, i) => ({
      i,
      text: p.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim(),
      compact: p.closest('.glass-model-picker-wrapper')?.getAttribute('data-compact-visible'),
    })),
  };
})()
