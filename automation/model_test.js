(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const target = tiles.at(-1);
  if (!target) return { error: 'no tile' };
  const mt = target.querySelector('.ui-model-picker__trigger');
  const cur = mt?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  mt.click();
  await sleep(350);
  const vis = () => [...document.querySelectorAll('[role^="menuitem"],[role="option"]')].filter(e => e.offsetParent);
  const opts = vis().map(e => e.textContent.trim());
  const auto = vis().find(e => /^auto/i.test(e.textContent.trim()));
  let clicked = false;
  if (auto) { auto.click(); clicked = true; }
  await sleep(400);
  const after = mt?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  return { before: cur, after, clicked, optionsCount: opts.length, firstOpts: opts.slice(0, 8) };
})()
