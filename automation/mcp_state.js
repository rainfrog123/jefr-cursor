// Classify each tile's MCP loop state.
// Healthy "connection held open" => the agent is blocked inside check_messages,
//   so the tile is GENERATING (submit button data-state="stop"), no idle composer.
// "MCP cut out" => the turn ended: NOT generating, idle composer (submit
//   disabled/active), and a "Worked for ..." completion stamp is present.
(() => {
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const classify = (t, i) => {
    const submitEl = t.querySelector('.ui-prompt-input-submit-button');
    const submitState = submitEl?.getAttribute('data-state') || null;
    const generating = submitState === 'stop';
    const shimmer = t.querySelector('.ui-collapsible-shimmer')?.textContent?.trim() || '';
    const planning = /planning\s+next\s+move/i.test(shimmer);
    const tail = (t.innerText || '').replace(/\s+/g, ' ').trim().slice(-400);
    const workedFor = /worked for\s+[\dhms ]+/i.test(tail);
    const model = t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() || null;

    let mcp;
    if (generating || planning) mcp = 'alive';            // blocked in check_messages
    else if (workedFor) mcp = 'cut_out';                  // turn ended, idle
    else mcp = 'idle_unknown';                             // idle, no completion stamp seen
    return { i, model, generating, planning, submitState, workedFor, mcp };
  };
  const out = tiles.map(classify);
  return JSON.stringify({
    tileCount: tiles.length,
    anyCutOut: out.some(o => o.mcp === 'cut_out'),
    tiles: out,
  }, null, 0);
})()
