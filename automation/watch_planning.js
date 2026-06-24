(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const WAIT_MS = __WAITMS__;
  const TILE = __TILE__; // -1 = any, else index

  const tiles = () => [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const check = () => {
    const ts = tiles();
    const list = TILE >= 0 ? [ts[TILE]].filter(Boolean) : ts;
    const hits = list.map((t, i) => {
      const st = cursorTileStatus(t);
      return { i: TILE >= 0 ? TILE : ts.indexOf(t), ...st };
    }).filter(x => x.planning);
    return { any: hits.length > 0, hits, all: cursorAllTileStatus() };
  };

  const deadline = Date.now() + WAIT_MS;
  const log = [];
  while (Date.now() < deadline) {
    const r = check();
    if (r.any) {
      return { found: true, waitedMs: WAIT_MS - (deadline - Date.now()), hits: r.hits, snapshot: r.all };
    }
    log.push({ ms: WAIT_MS - (deadline - Date.now()), tiles: r.all.tiles.map(t => ({ i: t.i, planning: t.planning, planningText: t.planningText })) });
    await sleep(200);
  }
  const final = check();
  return { found: false, waitedMs: WAIT_MS, last: final.all, log: log.slice(-5) };
})()
