(async () => {
  const idx = typeof __TILE__ === 'number' ? __TILE__ : 0;
  const layout = detectLayout();
  const before = modelTriggerIn(idx)?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  const r = await selectOpus48HighFast(idx);
  const after = modelTriggerIn(idx)?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  return {
    layout,
    idx,
    before,
    after,
    ok: !!(r.ok && /Opus 4\.8 1M Extra High Fast/i.test(after || '')),
    result: r,
    snapshot: snapshot(),
  };
})()
