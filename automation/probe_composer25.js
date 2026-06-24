(async () => {
  const idx = __TILE__;
  const r = await selectModel(idx, /Composer 2\.5/i);
  const model = modelTriggerIn(idx)?.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim();
  return { selectResult: r, currentModel: model };
})()
