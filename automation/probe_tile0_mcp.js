(() => {
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const t = tiles[0];
  if (!t) return JSON.stringify({ error: 'no tile 0' });

  const all = [...t.querySelectorAll('*')];

  // Any element mentioning an MCP / tool call by text
  const mentionsTool = all
    .filter(e => e.children.length === 0)
    .map(e => (e.textContent || '').trim())
    .filter(s => /check_messages|mcp|calling|called|tool|running|generating|cancel|stop/i.test(s))
    .slice(-25);

  // Submit button(s) full state
  const submits = [...t.querySelectorAll('.ui-prompt-input-submit-button')].map(b => ({
    state: b.getAttribute('data-state'),
    aria: b.getAttribute('aria-label'),
    disabled: b.disabled ?? null,
  }));

  // Any "stop" affordance / spinner anywhere
  const stopAnywhere = !!t.querySelector('[data-state="stop"]');
  const spinners = t.querySelectorAll('.codicon-loading,.ui-spinner,[class*="spinner"],[class*="shimmer"],.codicon-modifier-spin').length;

  // Tool-call / message cards
  const toolCards = [...t.querySelectorAll('[class*="tool"],[class*="mcp"],[data-message-role]')].map(e => ({
    cls: (typeof e.className === 'string' ? e.className : '').slice(0, 70),
    role: e.getAttribute('data-message-role'),
    txt: (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
  })).slice(-12);

  // Status bar / followup area text
  const statusArea = t.querySelector('.agent-panel-followup-status-area')?.textContent?.trim() || '';
  const shimmer = t.querySelector('.ui-collapsible-shimmer')?.textContent?.trim() || '';

  // aria-busy / live regions
  const busy = [...t.querySelectorAll('[aria-busy="true"]')].length;

  return JSON.stringify({
    submits, stopAnywhere, spinners, busy, statusArea, shimmer,
    mentionsTool, toolCards,
    tail: (t.innerText || '').replace(/\s+/g, ' ').trim().slice(-300),
  }, null, 0);
})()
