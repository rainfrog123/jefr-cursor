// Inspect tool-call messages (data-message-kind="tool") in each tile to learn
// how an MCP check_messages call is titled/structured vs a shell call, and what
// data-tool-status values appear. Used to build a reliable "connected" detector.
(() => {
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const scan = (t, i) => {
    const msgs = [...t.querySelectorAll('[data-message-kind="tool"]')];
    const info = msgs.slice(-14).map(m => {
      // candidate "title"/name elements inside the tool card
      const title =
        m.querySelector('.ui-shell-tool-call__line-description,[class*="title"],[class*="name"],[class*="header"]')
          ?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 50) || null;
      return {
        status: m.getAttribute('data-tool-status'),
        cls: (typeof m.className === 'string' ? m.className : '').slice(0, 50),
        // class list of the first child card (shell vs mcp may differ here)
        innerCls: (m.firstElementChild && typeof m.firstElementChild.className === 'string'
          ? m.firstElementChild.className : '').slice(0, 60),
        title,
        head: (m.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      };
    });
    return { i, toolMsgCount: msgs.length, msgs: info };
  };
  return JSON.stringify({ tiles: tiles.map(scan) }, null, 0);
})()
