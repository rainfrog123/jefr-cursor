(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const tilesNow = () => [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const vis = () => [...document.querySelectorAll('[role^="menuitem"],[role="option"]')].filter(e => e.offsetParent);
  const find = txt => vis().find(e => e.textContent.trim().toLowerCase().startsWith(txt.toLowerCase()));
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: k, bubbles: true }));
  const log = [];

  const before = tilesNow().length;
  const TRIG = '.glass-agent-conversation-tiling__menu-trigger,[aria-label="Tile actions"],[aria-label="Chat actions"]';
  const actions = tilesNow().at(-1)?.querySelector(TRIG) || document.querySelector(TRIG);
  if (!actions) return { error: 'no trigger' };
  actions.click();
  await sleep(400);
  log.push('menu: ' + vis().map(e => e.textContent.trim()).join(' | '));

  const split = find('Split');
  if (!split) return { error: 'no split', log };
  split.focus();
  key(split, 'ArrowRight');
  await sleep(400);
  log.push('submenu: ' + vis().map(e => e.textContent.trim()).join(' | '));

  const right = find('Right');
  log.push('right found: ' + !!right);
  if (right) right.click();
  else key(document.activeElement, 'Enter');

  await sleep(1500);
  const after = tilesNow().length;
  return { before, after, split: after > before, log };
})()
