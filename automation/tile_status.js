// Shared tile status helpers (included inline or via evaluate)
function cursorTileStatus(tile) {
  if (!tile) return null;
  const seg = [...tile.querySelectorAll('.glass-chat-status-bar__segment-label')]
    .map(e => e.textContent?.trim()).filter(Boolean);
  const follow = tile.querySelector('.agent-panel-followup-status-area')?.textContent?.trim() || '';
  const shimmer = tile.querySelector('.ui-collapsible-action.ui-collapsible-shimmer');
  const shimmerText = shimmer?.textContent?.trim() || '';
  const planning = /planning\s+next\s+move/i.test(shimmerText);
  const generating = tile.querySelector('.ui-prompt-input-submit-button[data-state="stop"]') != null;
  return {
    title: tile.querySelector('.chat-title-tab-title')?.textContent?.trim() || null,
    model: tile.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() || null,
    submit: {
      state: tile.querySelector('.ui-prompt-input-submit-button')?.getAttribute('data-state'),
      label: tile.querySelector('.ui-prompt-input-submit-button')?.getAttribute('aria-label'),
    },
    statusLabels: seg,
    followup: follow,
    planning,
    planningText: shimmerText || null,
    generating,
  };
}

function cursorAllTileStatus() {
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  return {
    tileCount: tiles.length,
    anyPlanning: tiles.some(t => cursorTileStatus(t)?.planning),
    tiles: tiles.map((t, i) => ({ i, ...cursorTileStatus(t) })),
  };
}
