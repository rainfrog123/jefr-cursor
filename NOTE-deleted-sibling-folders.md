# Related / deleted sibling folders (2026-07-21)

These lived under `C:\Users\jar71\Downloads\` next to this repo. They were **not** part of the `jefr-cursor` git tree. Removed after confirming day-to-day jefr only needs this project.

---

## `jefr-cursor-ssh` (split out 2026-07-23)

**What it is:** Former `multi-agent-ssh` branch of this repo, now its own project for Remote SSH / VPS.

**Where:**

- Local: `C:\Users\jar71\Downloads\jefr-cursor-ssh`
- GitHub: https://github.com/rainfrog123/jefr-cursor-ssh

**Removed from this repo:** local + `origin/multi-agent-ssh` (tip was `fe0e070`).


---

## `jefr-port-wip` (deleted)

**What it was:** Scratch / WIP copy of jefr pieces — no git remote, not installed as an extension.

**Had:**

- `automation/` — same family as this repo’s `automation/` (`cdp.py`, workflow scripts, …)
- `extension-src/` — snapshots of extension sources (`extension.ts`, `cdp-monitor.ts`, `messenger.ts`, …)
- `obsidian-plugin/` — Obsidian plugin bits

**Why:** Port / experiment dump alongside the real project.

**Superseded by:** this repo (`automation/`, `extension/`, `obsidian-plugin/`).

---

## `obsidian-cdp-bridge` (deleted)

**What it was:** Separate Cursor extension — Obsidian chat → WebSocket → CDP → type into Cursor’s native composer.

**Flow:**

```
Obsidian (jefr plugin UI)  --WS :39527-->  extension  --CDP :9222-->  Cursor composer
```

**Not the same as jefr-cursor:**

- No jefr MCP (`check_messages` / panel loop)
- No Python automation dependency
- Port **39527** (jefr’s usual local server differs, e.g. 39517)

**Had been linked as:**  
`%USERPROFILE%\.cursor\extensions\local.obsidian-cdp-bridge-0.1.0` → that folder  
(junction removed when deleted)

**When you’d recreate it:** Only if you want Obsidian to drive the composer **without** MCP.

---

## Use this repo instead

| Need | Location in jefr-cursor |
|------|-------------------------|
| MCP side panel + agent loop | `extension/` |
| CDP into Agents / workbench | `automation/cdp.py` |
| End-to-end Agents automation | `automation/workflow.py` |
| Live tile CDP monitor | `extension/src/cdp-monitor.ts` |
| Obsidian plugin | `obsidian-plugin/` |
