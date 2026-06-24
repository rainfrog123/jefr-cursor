(() => {
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  return JSON.stringify(tiles.map((t, i) => {
    const submit = t.querySelector('.ui-prompt-input-submit-button');
    const text = (t.innerText || '').replace(/\s+/g, ' ').trim();
    return {
      i,
      submitState: submit?.getAttribute('data-state') || null,
      submitAria: submit?.getAttribute('aria-label') || null,
      // fingerprints of MY messenger session:
      mentionsResponseLog: /MCP Response Log\.md/i.test(text),
      mentionsInvokeMcp: /directly invoke the mcp|invoke the mcp directly|keep the mcp connection/i.test(text),
      runCheckMessages: (text.match(/(Ran|Running) Check Messages in jefr/gi) || []).length,
      focused: !!t.closest('.glass-agent-conversation-tiling__tile--active') ||
               t.matches('.glass-agent-conversation-tiling__tile--active') ||
               !!t.querySelector(':focus'),
      tail: text.slice(-200),
    };
  }), null, 0);
})()
