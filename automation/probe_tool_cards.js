// Dump the live tool cards in each agent tile, so we can see exactly what the
// Agents window renders while a turn is still in progress. The .jsonl
// transcript is NOT flushed mid-turn, so this DOM is the only live source of
// "what is the agent doing right now".
(function () {
  function tileRoots() {
    const tiled = [...document.querySelectorAll(".glass-agent-conversation-tiling__tile")];
    if (tiled.length > 0) return tiled;
    const shell = document.querySelector(".agent-panel-conversation-shell");
    return shell ? [shell] : [];
  }

  function agentIdOf(node) {
    const k = Object.keys(node).find(
      (x) => x.startsWith("__reactFiber$") || x.startsWith("__reactInternalInstance$"),
    );
    let f = k ? node[k] : null;
    let steps = 0;
    while (f && steps++ < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === "object" && typeof p.agentId === "string") return p.agentId;
      f = f.return;
    }
    return null;
  }

  const out = [];
  tileRoots().forEach((t, i) => {
    const cards = [...t.querySelectorAll('[data-message-kind="tool"]')];
    const statusBar = [...t.querySelectorAll(".glass-chat-status-bar__segment-label")]
      .map((e) => (e.textContent || "").trim())
      .filter(Boolean);
    const followup = (
      t.querySelector(".agent-panel-followup-status-area")?.textContent || ""
    ).trim();
    const shimmer = (
      t.querySelector(".ui-collapsible-action.ui-collapsible-shimmer")?.textContent || ""
    ).trim();

    out.push({
      tile: i,
      agentId: agentIdOf(t),
      totalToolCards: cards.length,
      statusBar,
      followup: followup.slice(0, 120),
      shimmer: shimmer.slice(0, 120),
      lastCards: cards.slice(-8).map((m) => ({
        status: m.getAttribute("data-tool-status"),
        kind: m.getAttribute("data-message-kind"),
        cls: (typeof m.className === "string" ? m.className : "").slice(0, 90),
        // Full text so we can decide how to build a clean label.
        text: (m.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180),
        // Child element classes give us the structure to target precisely.
        childCls: [...m.querySelectorAll("*")]
          .slice(0, 14)
          .map((c) => (typeof c.className === "string" ? c.className : ""))
          .filter(Boolean)
          .slice(0, 10),
      })),
    });
  });
  return JSON.stringify(out, null, 1);
})();
