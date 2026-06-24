(() => {
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const t = tiles[0];
  if (!t) return JSON.stringify({ error: 'no tile 0' });

  // Collect class names that look tool/mcp/status related (for discovery)
  const interesting = new Set();
  t.querySelectorAll('*').forEach(el => {
    (el.className && typeof el.className === 'string' ? el.className.split(/\s+/) : [])
      .forEach(c => {
        if (/tool|mcp|spinner|loading|error|status|pending|run|stream|interrupt|abort|cancel|generat|busy/i.test(c)) {
          interesting.add(c);
        }
      });
  });

  // Last bit of visible text in the tile (tail of the conversation)
  const innerTail = (t.innerText || '').replace(/\s+/g, ' ').trim().slice(-600);

  // Submit button + status area
  const submit = t.querySelector('.ui-prompt-input-submit-button');
  const statusArea = t.querySelector('.agent-panel-followup-status-area')?.textContent?.trim() || '';
  const shimmer = t.querySelector('.ui-collapsible-shimmer')?.textContent?.trim() || '';

  // Any element whose data-state attr exists
  const dataStates = [...t.querySelectorAll('[data-state]')]
    .map(e => ({ cls: (typeof e.className==='string'?e.className:'').slice(0,60), state: e.getAttribute('data-state') }))
    .slice(0, 25);

  return JSON.stringify({
    interestingClasses: [...interesting],
    submit: submit ? { state: submit.getAttribute('data-state'), label: submit.getAttribute('aria-label') } : null,
    statusArea,
    shimmer,
    dataStates,
    innerTail,
  }, null, 0);
})()
