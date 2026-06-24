(() => {
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];
  const actions = [...document.querySelectorAll('[aria-label="Tile actions"]')];
  return JSON.stringify({
    tileCount: tiles.length,
    actionButtons: actions.length,
    tiles: tiles.map((t, i) => ({
      i,
      title: t.querySelector('.chat-title-tab-title')?.textContent?.trim() || null,
      model: t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() || null,
      generating: !!t.querySelector('.ui-prompt-input-submit-button[data-state="stop"]'),
      planning: /planning\s+next\s+move/i.test(t.querySelector('.ui-collapsible-shimmer')?.textContent || ''),
      aiMsgs: t.querySelectorAll('[data-message-role="ai"]').length,
      userMsgs: t.querySelectorAll('[data-message-role="user"]').length,
      hasEditor: !!t.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input'),
      tileActionsInDom: !!t.querySelector('[aria-label="Tile actions"]'),
      globalActionBtn: !!actions[i],
    })),
  }, null, 0);
})()
