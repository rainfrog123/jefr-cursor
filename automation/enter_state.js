// Rich per-tile state for diagnosing the Opus "Planning next moves" stuck phase.
// Returns, per tile: model, submit button (data-state/aria/disabled + whether it
// has a React onClick), the collapsible/shimmer text, AI message count + last AI
// text length, and any latent action controls (Resume/Continue/Retry/Run/Accept).
(() => {
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];

  const fiberProps = (el) => {
    if (!el) return null;
    const k = Object.keys(el).find((x) => x.startsWith('__reactProps$'));
    return k ? el[k] : null;
  };
  const agentIdOf = (node) => {
    const k = Object.keys(node).find((x) => x.startsWith('__reactFiber$'));
    let f = k ? node[k] : null, n = 0;
    while (f && n++ < 40) { const p = f.memoizedProps; if (p && typeof p.agentId === 'string') return p.agentId; f = f.return; }
    return null;
  };

  const ACTION_RE = /^(resume|continue|retry|try again|run|accept|keep going|generate)/i;

  const row = (t, i) => {
    const submit = t.querySelector('.ui-prompt-input-submit-button');
    const sp = fiberProps(submit);
    const shimmer = t.querySelector('.ui-collapsible-action.ui-collapsible-shimmer')?.textContent || '';
    const aiMsgs = [...t.querySelectorAll('[data-message-role="ai"]')];
    const lastAi = aiMsgs[aiMsgs.length - 1];
    const lastAiText = lastAi ? (lastAi.innerText || '').trim() : '';
    // latent action buttons inside the tile
    const buttons = [...t.querySelectorAll('button,[role="button"]')]
      .filter((b) => b.offsetParent)
      .map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim())
      .filter((x) => x && ACTION_RE.test(x));
    return {
      i,
      agentId: (agentIdOf(t) || '').slice(0, 8),
      model: t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() || '',
      submitState: submit?.getAttribute('data-state') || null,
      submitAria: submit?.getAttribute('aria-label') || null,
      submitDisabled: submit ? (submit.disabled || submit.getAttribute('aria-disabled') === 'true') : null,
      submitHasOnClick: !!(sp && typeof sp.onClick === 'function'),
      shimmer: shimmer.replace(/\s+/g, ' ').trim().slice(0, 60),
      planning: /planning\s+next\s+move/i.test(shimmer),
      generating: submit?.getAttribute('data-state') === 'stop' || /stop generation/i.test(submit?.getAttribute('aria-label') || ''),
      aiCount: aiMsgs.length,
      lastAiLen: lastAiText.length,
      lastAiTail: lastAiText.slice(-50),
      actionButtons: buttons,
      runningJefr: /(Ran|Running) Check Messages in jefr/i.test((t.innerText || '')),
    };
  };

  return { t: Date.now(), tiles: tiles.map(row) };
})()
