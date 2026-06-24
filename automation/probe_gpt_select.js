(async () => {
  const TARGET = 1;
  const log = [];
  const idx = TARGET;

  let r = await selectModel(idx, /GPT-5\.5 1M High/i);
  log.push({ step: 'selectGptHigh', ...r, options: r.options });

  if (r.error) {
    r = await selectModel(idx, /GPT-5\.5/i);
    log.push({ step: 'selectGptLoose', ...r, options: r.options });
  }

  return { idx, tileCount: tiles().length, log, snapshot: snapshot() };
})()
