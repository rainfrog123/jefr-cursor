(() => {
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const statusSel = [
    '.glass-chat-status-bar__segment-label',
    '.agent-panel-followup-status-area',
    '[class*="status-bar"]',
    '[class*="followup-status"]',
    '[class*="agent-status"]',
    '[data-streamdown]',
  ];
  const out = { tileCount: tiles.length, tiles: [] };
  for (const [i, t] of tiles.entries()) {
    const hits = {};
    for (const sel of statusSel) {
      const els = [...t.querySelectorAll(sel)];
      if (els.length) hits[sel] = els.map(e => e.textContent?.trim()).filter(Boolean);
    }
    // any visible text nodes mentioning plan/thinking/generat
    const allText = [...t.querySelectorAll('*')]
      .map(e => e.childElementCount === 0 ? e.textContent?.trim() : '')
      .filter(t => t && /plan|think|generat|move|wait|tool|mcp/i.test(t))
      .slice(0, 20);
    out.tiles.push({ i, hits, statusText: allText });
  }
  // document-level status (outside tiles)
  const global = [...document.querySelectorAll('.glass-chat-status-bar__segment-label,.agent-panel-followup-status-area')]
    .map(e => e.textContent?.trim()).filter(Boolean);
  out.globalStatus = global;
  return JSON.stringify(out, null, 0);
})()
