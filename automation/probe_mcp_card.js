// Find how a jefr MCP (check_messages) tool-call renders in a tile, so we can
// build a reliable "successfully connected" stop condition for the Enter hold.
(() => {
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const scan = (t, i) => {
    // tool-call-like cards (exclude plain ai/user message bubbles)
    const cards = [...t.querySelectorAll('[class*="tool-call"],[class*="tool_call"],[class*="mcp"]')];
    const cardInfo = cards.map(c => {
      const cls = (typeof c.className === 'string' ? c.className : '');
      const running = cls.includes('with-stop') ||
        !!c.querySelector('[data-state="stop"],[class*="spinner"],[class*="shimmer"],.codicon-modifier-spin');
      return {
        cls: cls.slice(0, 90),
        running,
        txt: (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
        mentionsCheck: /check_messages/i.test(c.textContent || ''),
      };
    });
    const submit = t.querySelector('.ui-prompt-input-submit-button');
    return {
      i,
      generating: submit?.getAttribute('data-state') === 'stop',
      cardCount: cards.length,
      checkCards: cardInfo.filter(c => c.mentionsCheck),
      anyRunningCard: cardInfo.filter(c => c.running).slice(-4),
    };
  };
  return JSON.stringify({ tiles: tiles.map(scan) }, null, 0);
})()
