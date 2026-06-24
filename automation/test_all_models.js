(async () => {
  const MODELS = __MODELS__;
  const TILE = __TILE__;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const idx = TILE >= 0 ? TILE : tiles().length - 1;
  const t = tileAt(idx);
  if (!t) return { error: 'no tile', idx, tileCount: tiles().length };

  let agentId = agentIdOfTile(t);
  if (!agentId) {
    focusEditorIn(idx);
    await sleep(200);
    agentId = agentIdOfTile(tileAt(idx));
  }
  if (!agentId) return { error: 'no agentId', idx };

  const triggerText = () =>
    modelTriggerIn(idxByAgentId(agentId))
      ?.querySelector('.ui-model-picker__trigger-text')
      ?.textContent?.trim() || '';

  const results = [];
  for (const label of MODELS) {
    const r = await selectTargetModelByAgent(agentId, label);
    const after = triggerText();
    const ok = !!(r.ok && new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(after));
    results.push({ label, ok, after, select: r });
    await sleep(400);
  }

  return { agentId, idx: idxByAgentId(agentId), results };
})()
