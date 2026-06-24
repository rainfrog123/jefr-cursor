(async () => {
  const TARGET = __TARGET__;
  const PROMPT = __PROMPT__;
  const MODEL = __MODEL__;
  const log = [];
  const idx = TARGET >= 0 ? TARGET : 1;

  log.push({ step: 'start', snapshot: snapshot() });

  if (tiles().length > 0 && !tileAt(idx)) {
    return { error: 'target tile missing', idx, count: tiles().length, log };
  }
  if (tiles().length === 0) {
    return { error: 'still single-pane? split may have failed', log, snapshot: snapshot() };
  }

  // A freshly-split tile shows the "New Agent" title and has no AI messages yet.
  // Its React fiber can leak the *active* agent's id (the agent driving this
  // automation), so reading agentId now would pin us to the WRONG agent. Only
  // pin once the tile has its own conversation (after its first response); until
  // then, drive it by tile index. With keep-tiles no tiles close, so the index
  // is stable through the Auto/model-picker steps.
  const isFreshTile = (i) => {
    const ttl = tileAt(i)?.querySelector('.chat-title-tab-title')?.textContent?.trim() || '';
    return aiMessagesInTile(i).length === 0 || /^new agent$/i.test(ttl);
  };
  let agentId = agentIdOfTile(tileAt(idx));
  if (agentId && isFreshTile(idx)) agentId = null;
  if (!agentId && !isFreshTile(idx)) {
    focusEditorIn(idx);
    await sleep(200);
    agentId = agentIdOfTile(tileAt(idx));
  }
  const getIdx = () => (agentId ? idxByAgentId(agentId) : idx);
  log.push({ step: 'pinAgent', agentId, idx: getIdx(), fresh: isFreshTile(idx) });

  const aiBefore = aiMessagesInTile(getIdx()).length;

  let r = agentId
    ? await selectModelByAgent(agentId, /^auto/i)
    : await selectModel(idx, /^auto/i);
  log.push({ step: 'selectAuto', ...r });
  if (r.error) return { error: r.error, log, snapshot: snapshot() };

  let ed = focusEditorIn(getIdx());
  if (!ed) return { error: 'no editor on NEW tile', idx: getIdx(), log, snapshot: snapshot() };

  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, PROMPT);
  await sleep(120);
  if (!ed.textContent.includes(PROMPT)) return { error: 'insert failed', log, snapshot: snapshot() };

  const send = submitIn(getIdx());
  if (!(send && send.getAttribute('data-state') !== 'stop' && !/voice|mic/i.test(send.getAttribute('aria-label') || '')))
    return { error: 'no send on NEW tile', idx: getIdx(), log, snapshot: snapshot() };
  send.click();
  log.push({ step: 'sent', prompt: PROMPT, snapshot: snapshot() });

  let planning = false;
  let planningText = null;
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    const shimmer = tileAt(getIdx())?.querySelector('.ui-collapsible-shimmer')?.textContent || '';
    if (/planning\s+next\s+move/i.test(shimmer)) { planning = true; planningText = shimmer.trim(); break; }
  }
  log.push({ step: 'planning', planning, planningText });

  const response = await waitForAiResponse(getIdx(), aiBefore, 90000);
  log.push({ step: 'aiResponse', ...response, snapshot: snapshot() });
  if (!response.ok) return { error: 'no ai response on NEW tile', log, snapshot: snapshot() };

  await sleep(1000);
  const stopBtn = stopInIdx(getIdx());
  if (stopBtn) { stopBtn.click(); log.push({ step: 'stopped' }); }
  else log.push({ step: 'stopSkipped' });

  await waitIdle(getIdx(), 12000);
  dismissMenus();
  await sleep(300);

  agentId = agentId || agentIdOfTile(tileAt(getIdx()));
  if (!agentId) return { error: 'no agentId for new tile', idx: getIdx(), log, snapshot: snapshot() };

  // Select target model (passed via --model argument), addressed by agentId.
  r = await selectTargetModelByAgent(agentId, MODEL);
  log.push({ step: 'selectModel', model: MODEL, ...r });
  if (r.error) return { error: r.error, agentId, log, snapshot: snapshot() };

  const finalIdx = idxByAgentId(agentId);
  focusEditorIn(finalIdx);
  return {
    ok: true, idx: finalIdx, agentId, tileCount: tiles().length, prompt: PROMPT,
    planning, planningText, responsePreview: response.preview,
    targetModel: r.after || r.model, log, snapshot: snapshot(),
  };
})()
