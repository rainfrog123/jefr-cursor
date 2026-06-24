// agent_map.js — map each agent tile to its stable agentId (= chat UUID) via the
// React fiber, and optionally focus a tile BY agentId.
//
// Usage (via cdp.py --file, with a __AGENT__ substitution for focus):
//   python cdp.py --file agent_map.js                 -> list {i, agentId, model, state}
//   (replace __AGENT__ with a uuid in the caller to focus that agent's tile)
(() => {
  const TARGET = "__AGENT__"; // caller may replace; "" / "__AGENT__" = list only

  const fiberOf = (node) => {
    const k = Object.keys(node).find(
      (x) => x.startsWith("__reactFiber$") || x.startsWith("__reactInternalInstance$")
    );
    return k ? node[k] : null;
  };
  const agentIdOf = (node) => {
    let f = fiberOf(node), steps = 0;
    while (f && steps++ < 40) {
      const p = f.memoizedProps;
      if (p && typeof p === "object" && typeof p.agentId === "string") return p.agentId;
      f = f.return;
    }
    return null;
  };

  const tiles = (() => {
    const tiled = [...document.querySelectorAll(".glass-agent-conversation-tiling__tile")];
    if (tiled.length > 0) return tiled;
    const shell = document.querySelector(".agent-panel-conversation-shell");
    return shell ? [shell] : [];
  })();
  const rows = tiles.map((t, i) => {
    const submit = t.querySelector(".ui-prompt-input-submit-button");
    const aria = submit?.getAttribute("aria-label") || "";
    const text = (t.innerText || "").replace(/\s+/g, " ").trim();
    return {
      i,
      agentId: agentIdOf(t),
      model: t.querySelector(".ui-model-picker__trigger-text")?.textContent?.trim() || "",
      generating: submit?.getAttribute("data-state") === "stop" || /stop generation/i.test(aria),
      runningJefr: /(Ran|Running) Check Messages in jefr/i.test(text),
    };
  });

  if (TARGET && TARGET !== "__" + "AGENT__") {
    const hit = rows.find((r) => r.agentId === TARGET);
    if (!hit) return { ok: false, error: "agentId not found", target: TARGET, rows };
    const ed = tiles[hit.i]?.querySelector(".tiptap.ProseMirror.ui-prompt-input-editor__input");
    if (ed) {
      ed.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      ed.focus();
      ed.click();
    }
    return { ok: true, focused: hit.i, agentId: TARGET, rows };
  }

  return { ok: true, rows };
})()
