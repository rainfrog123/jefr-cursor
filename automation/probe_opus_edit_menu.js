(async () => {
  const idx = typeof __TILE__ === 'number' ? __TILE__ : 0;
  focusEditorIn(idx);
  await sleep(120);

  const before = modelTriggerIn(idx)?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  let trigger = await openModelPicker(idx);
  if (!trigger) return { error: 'no picker', idx, before };

  // Toggle Auto off if needed so Opus row is visible
  let items = visMenu();
  if (!items.some(e => /Opus 4\.8/i.test(e.textContent || ''))) {
    const autoRow = items.find(e => /^auto/i.test((e.textContent || '').trim()));
    const sw = autoRow?.querySelector('button,[role="switch"],input[type="checkbox"]');
    if (sw) { sw.click(); await sleep(600); }
    else if (autoRow) { autoRow.click(); await sleep(600); }
    trigger = await openModelPicker(idx);
  }

  const opusRow = visMenu().find(e =>
    e.getAttribute('role') === 'menuitem' &&
    e.querySelector('.ui-model-picker__item-content') &&
    /Opus 4\.8/i.test((e.textContent || '').trim())
  );
  if (!opusRow) {
    dismissMenus();
    return { error: 'opus row not found', before, options: visMenu().map(e => e.textContent.trim()) };
  }
  opusRow.click();
  await sleep(400);

  trigger = await openModelPicker(idx);
  if (!trigger) return { error: 'no picker after opus click', before };

  const editClick = await clickVisibleMenu(/^Edit$/i);
  if (editClick.error) {
    dismissMenus();
    return { error: 'edit not found', before, editClick, menu: visMenu().map(e => e.textContent.trim()) };
  }

  await sleep(300);
  const editMenuItems = visMenu()
    .filter(e => e.offsetParent !== null)
    .map(e => e.textContent.trim().replace(/\s+/g, ' '));

  dismissMenus();
  return { before, editMenuItems, after: modelTriggerIn(idx)?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() };
})()
