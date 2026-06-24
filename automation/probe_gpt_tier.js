(async () => {
  const idx = 1;
  // force Auto first
  await selectModel(idx, /^auto/i);
  const before = modelTriggerIn(idx)?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  const r = await selectGpt55High(idx);
  return { before, r, snapshot: snapshot() };
})()
