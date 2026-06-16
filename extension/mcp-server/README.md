# jefr MCP server — plain-English walkthrough

This folder holds the **readable reconstruction** of the jefr-specific logic in
`dist/mcp-server.mjs`. The shipped `.mjs` is ~30,500 lines only because it
bundles two public libraries inside it (`@modelcontextprotocol/sdk` and `zod`);
the actual jefr code is the ~470-line slice rebuilt here as `index.ts`.

## What this program is

It's a tiny Node.js process that Cursor launches (configured in
`.cursor/mcp.json`). The AI agent talks to it over **stdin/stdout** using the
Model Context Protocol. It offers exactly three tools.

## How it talks to the panel: files on disk

The server and the VS Code extension are **separate processes**, so they pass
messages by reading/writing small JSON files in a shared folder
(`~/.moyu-message/`, override with `MESSENGER_DATA_DIR`):

- `queue.json` — extension → server. Things you queued to send (text/image/file).
- `question.json` — server → extension. The current open question.
- `answer.json` — extension → server. Your answer to that question.
- `reply.json` — server → extension. The agent's reply/progress summary to show.

```
   Cursor AI agent
        │  (stdio / MCP)
        ▼
  ┌─────────────┐     writes reply.json ─────────►  ┌──────────────┐
  │ MCP server  │     reads  queue.json  ◄─────────  │  Extension   │
  │ (index.ts)  │     writes question.json ────────► │  + Webview   │
  │             │     reads  answer.json  ◄────────  │  panel UI    │
  └─────────────┘                                    └──────────────┘
        │  ~/.moyu-message/*.json (file-system IPC)
```

## The three tools

### 1. `check_messages` (blocking)

This is the heartbeat of the whole "perpetual loop."

1. If the agent passed a `reply`, write it to `reply.json` so the panel shows it.
2. Then **wait**, checking `queue.json` every 100 ms:
   - If items appear, convert each to MCP content (text as-is; images become
     base64; small text files get inlined in a code block), clear the queue,
     append the `[system] …call check_messages again…` reminder, and return them.
   - If nothing arrives within `MAX_WAIT_MS` (default 2 min), return a "no new
     messages, call again" note so the loop keeps going.
   - Every `HEARTBEAT_INTERVAL` (default 8 s) it emits a heartbeat so the client
     doesn't think the call hung.

### 2. `send_progress` (instant)

Writes the given `progress` text to `reply.json` (so the panel shows it) and
returns immediately — used for status updates during long tasks.

### 3. `ask_question` (blocking)

1. Write the questions to `question.json` (each gets an id `q0`, `q1`, …) and
   delete any stale `answer.json`.
2. Wait, checking for `answer.json` every 100 ms:
   - When it appears, map the selected option ids back to their labels, combine
     with any free-text "other" note, format it for the agent, clean up both
     files, and return the answer.
   - Same timeout + heartbeat behavior as `check_messages`.

## Key constants (top of `index.ts`)

- `POLL_INTERVAL = 100` ms — disk re-check cadence.
- `HEARTBEAT_INTERVAL = 8000` ms — keep-alive cadence while blocked.
- `MAX_WAIT_MS = 120000` ms — give-up-and-recall timeout.
- `SYSTEM_SUFFIX` — the reminder appended to delivered messages that keeps the
  agent calling `check_messages`.

## Fidelity / caveats

- This is a **faithful, behavior-exact reconstruction** of the readable
  (non-minified) server slice — names and structure match the bundle closely.
- The build script `npm run compile:mcp` bundles `mcp-server/index.ts` back into
  `dist/mcp-server.mjs`. That requires Node.js (not installed in this
  environment), so the shipped `.mjs` was not regenerated from this file here.
