# jefr — Obsidian chat plugin

Local Obsidian UI for jefr. Talks to Cursor jefr bridges over WebSocket.

## Multi-host (Phase 2)

This plugin runs **on Windows Obsidian** (local). It can connect to **multiple** bridges at once:

| Endpoint | Typical port | Meaning |
|----------|--------------|---------|
| Local | `39517` | Local Cursor jefr |
| VPS | `39518` | Remote SSH jefr via LocalForward |

Settings → **jefr** → **Endpoints**. The chat route picker lists agents grouped by host.

`multi-agent-ssh` is the **VPS install** track. Do not put Obsidian multi-host logic on that branch — Obsidian stays on **`multi-agent-local`**.

## Install

Symlink or copy this folder to `<vault>/.obsidian/plugins/jefr-chat/` (`manifest.json`, `main.js`, `styles.css`).

Enable in Community plugins → reload.

## Protocol

Same as the Cursor Remote Console WS (`sendText`, `selectAgent`, `stateUpdate`, `responseLog`, …).
