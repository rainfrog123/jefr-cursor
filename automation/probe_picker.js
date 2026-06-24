(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const t = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')].at(-1);
  focusEditor(t);
  await sleep(100);
  const tr = t.querySelector('.ui-model-picker__trigger');
  const before = tr?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  tr.click();
  await sleep(500);
  const auto = visMenu().find(e => /^auto/i.test(e.textContent.trim()));
  const autoState = auto?.getAttribute('aria-checked') || auto?.getAttribute('data-state');
  auto?.click();
  await sleep(600);
  const after = t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  const compact = t.querySelector('.glass-model-picker-wrapper')?.getAttribute('data-compact-visible');
  // reopen
  t.querySelector('.ui-model-picker__trigger')?.click();
  await sleep(600);
  const items = visMenu().map(e => e.textContent.trim().replace(/\s+/g, ' ').slice(0, 80));
  document.querySelector('.ui-model-picker__trigger')?.click();
  return { before, after, autoState, compact, items };
})()
