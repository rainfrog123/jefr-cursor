# Archived MCP messenger (user-level)

Archived **2026-08-11** so Cursor will not auto-load jefr / mcp-messenger.

## This folder (`~/.cursor/archive/mcp/`)

| File | Was |
| --- | --- |
| `mcp.json.bak` | `~/.cursor/mcp.json` (jefr MCP server) |
| `mcp-messenger.mdc.bak` | `~/.cursor/rules/mcp-messenger.mdc` (always-on agent rule) — **live path empty** |
| `jefr.jefr-cursor-1.0.5.bak-20260730__rules__mcp-messenger.mdc.bak` | leftover rule inside old extension bak tree |
| `extensions.json.*.bak` | pre-edit copy of `~/.cursor/extensions/extensions.json` |

## Extension disabled

| Path | Note |
| --- | --- |
| `~/.cursor/extensions/jefr.jefr-cursor-1.0.5.bak-disabled-*` | Symlink to `Music/Apps/jefr-cursor/extension` renamed so Cursor won’t load it |
| `extensions.json` | `jefr.jefr-cursor` entry removed |

Older bak already present: `jefr.jefr-cursor-1.0.5.bak-20260730/`.

## Other project archives (same pattern)

- `C:\Users\jar71\Music\blue\.cursor\archive\mcp\`
- `C:\Users\jar71\Music\Apps\jefr-cursor\.cursor\archive\mcp\`
- `C:\Users\jar71\Music\Apps\jefr-cursor-ssh\.cursor\archive\mcp\`

## Restore (if needed)

1. Copy `mcp.json.bak` → `~/.cursor/mcp.json`
2. Copy `mcp-messenger.mdc.bak` → `~/.cursor/rules/mcp-messenger.mdc`
3. Restore symlink name `jefr.jefr-cursor-1.0.5` and re-add extension entry (or reinstall VSIX)
4. Reload Cursor window

**Reload Cursor** after this archive for Tools & MCP / rules to drop `user-jefr`.
