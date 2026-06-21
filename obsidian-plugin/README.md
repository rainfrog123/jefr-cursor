# jefr — Obsidian chat plugin

A faithful port of the **jefr** Cursor side-panel input area, living inside Obsidian.

Send prompts to your Cursor AI agent, read its replies (rendered as Markdown), and answer its questions — all from a single Obsidian view. Everything you send here flows through the **same message queue** your Cursor agent reads via the jefr MCP server, and also shows up as chat bubbles in the **jefr panel inside Cursor**.

## How it works

The jefr VS Code / Cursor extension runs a small local WebSocket server (default `ws://127.0.0.1:39517`). This plugin is a WebSocket client of that server and speaks the same protocol as the built-in Remote Console:

- **You send** → `sendText` → lands in the per-workspace queue the agent reads via `check_messages`, and echoes into the Cursor jefr panel history.
- **Agent replies** → pushed to the plugin as `stateUpdate.reply` and rendered as a Markdown bubble.
- **Agent asks a question** (`ask_question`) → rendered as an interactive card; your answer is sent back via `submitAnswer`.

No file paths or workspace hashing to configure — the extension already points its server at the correct workspace data directory.

## Install

1. Copy this folder into your vault's plugins directory:
   `<your-vault>/.obsidian/plugins/jefr-chat/`
   It must contain `manifest.json`, `main.js`, and `styles.css`.
2. In Obsidian: **Settings → Community plugins → Reload plugins**, then enable **jefr**.
3. Make sure **Cursor is open** with the jefr extension running (it auto-starts the local server).
4. Open the chat via the ribbon icon (speech bubbles) or the command palette: **"jefr: Open jefr chat"**.

## Settings

- **Host** — usually `127.0.0.1`.
- **Port** — default `39517` (the jefr server's preferred port).
- **Auto-reconnect** — reconnect automatically when Cursor restarts.
- **Max messages kept** — how many bubbles to keep before trimming the oldest.

## Notes

- The connection status pill (Online / Connecting / Offline) reflects the live WebSocket state.
- This channel is **text-only** (matching the server's `sendText` API). Image/file attachments are not sent from Obsidian.
- `isDesktopOnly` is set because the plugin opens a local network socket to Cursor.
