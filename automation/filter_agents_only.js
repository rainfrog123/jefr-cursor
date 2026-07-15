(() => {
  const STYLE_ID = "jefr-cdp-agents-only";

  // Remove prior injection if re-run
  document.getElementById(STYLE_ID)?.remove();

  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* Hide repository / folder section headers in Agents sidebar */
    .ui-sidebar-section-head,
    .glass-sidebar-section-drag-target.ui-sidebar-section-head {
      display: none !important;
    }
  `;
  document.documentElement.appendChild(style);

  // Also collapse empty spacing by hiding any wrapper that ONLY contains a section head
  // (best-effort; agent rows stay visible)
  const folders = [...document.querySelectorAll(".ui-sidebar-section-head")];
  const agents = [...document.querySelectorAll(".glass-sidebar-agent-menu-btn")];

  const folderNames = folders.map((el) =>
    (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80)
  );
  const agentNames = agents.map((el) =>
    (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 100)
  );

  return {
    ok: true,
    styleId: STYLE_ID,
    hiddenFolders: folderNames,
    keptAgents: agentNames,
    folderCount: folders.length,
    agentCount: agents.length,
  };
})()
