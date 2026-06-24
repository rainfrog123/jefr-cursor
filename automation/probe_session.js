// Probe: does each agent tile carry a distinct, stable session identifier?
// Looks at (1) DOM attributes on the tile root + key descendants, and
// (2) React fiber props/state for id-ish keys (sessionId, composerId,
// bubbleId, tabId, threadId, etc). Returns a per-tile summary.
(() => {
  const tiles = [...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];

  const ID_KEY = /(^|\.)((session|composer|bubble|tab|thread|conversation|chat|agent|pane|view|generation)Id|id|uuid|guid)$/i;
  const looksId = (v) =>
    typeof v === 'string' &&
    v.length >= 6 &&
    v.length <= 64 &&
    /[0-9a-f]{4}/i.test(v) &&
    !/\s/.test(v);

  // Collect attributes on an element that look like identifiers.
  function attrIds(el) {
    const out = {};
    if (!el) return out;
    for (const a of el.attributes || []) {
      if (/id$/i.test(a.name) || /^data-/.test(a.name)) {
        if (looksId(a.value) || /id$/i.test(a.name)) out[a.name] = a.value;
      }
    }
    return out;
  }

  // Find the React fiber for a DOM node.
  function fiberOf(node) {
    const k = Object.keys(node).find((x) => x.startsWith('__reactFiber$') || x.startsWith('__reactInternalInstance$'));
    return k ? node[k] : null;
  }

  // Walk up the fiber tree from a node, scanning memoizedProps + memoizedState
  // for id-ish string fields. Returns {key:value} of the first matches found.
  function fiberIds(node, maxUp = 40) {
    const found = {};
    let f = fiberOf(node);
    let steps = 0;
    while (f && steps++ < maxUp) {
      for (const bag of [f.memoizedProps, f.memoizedState]) {
        if (bag && typeof bag === 'object') {
          for (const key of Object.keys(bag)) {
            try {
              const v = bag[key];
              if (ID_KEY.test(key) && looksId(v) && !found[key]) found[key] = v;
            } catch (e) {}
          }
        }
      }
      f = f.return;
    }
    return found;
  }

  const rows = tiles.map((t, i) => {
    const model = t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim() || '';
    const editor = t.querySelector('.tiptap.ProseMirror');
    return {
      i,
      model,
      tileAttrIds: attrIds(t),
      editorAttrIds: attrIds(editor),
      tileFiberIds: fiberIds(t),
      editorFiberIds: editor ? fiberIds(editor) : {},
    };
  });

  // Cross-tile uniqueness check: for each id key seen, are values distinct per tile?
  const keys = new Set();
  rows.forEach((r) => {
    [r.tileAttrIds, r.editorAttrIds, r.tileFiberIds, r.editorFiberIds].forEach((b) =>
      Object.keys(b).forEach((k) => keys.add(k))
    );
  });

  const distinctness = {};
  for (const k of keys) {
    const vals = rows.map((r) => r.tileFiberIds[k] || r.editorFiberIds[k] || r.tileAttrIds[k] || r.editorAttrIds[k]).filter(Boolean);
    distinctness[k] = { values: vals, allPresent: vals.length === rows.length, allDistinct: new Set(vals).size === vals.length && vals.length === rows.length };
  }

  return { tileCount: rows.length, rows, distinctness };
})()
