# jefr cursor — How It Works

## 1. Overview

jefr cursor is a Cursor IDE extension that uses the **Model Context Protocol (MCP)** to open a side-channel outside Cursor’s native chat. Users interact through the extension Webview panel while the AI agent keeps working in a perpetual loop.

**Core value**: Drive the AI continuously from the plugin UI without typing in Cursor chat — send message → AI processes → wait for next message.

---

## 2. Architecture

### 2.1 Three components

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Cursor IDE                                        │
│                                                                              │
│  ┌─────────────────────┐                          ┌────────────────────┐    │
│  │   VSCode extension   │                          │   Cursor AI Agent  │    │
│  │   (extension.js)     │                          │                    │    │
│  │                      │                          │   - Handle requests │    │
│  │  ┌────────────────┐  │                          │   - Call MCP tools  │    │
│  │  │  Webview panel │  │                          │   - Generate reply  │    │
│  │  │  (React UI)    │  │                          └────────┬───────────┘    │
│  │  │  - Message box │  │                                   │                │
│  │  │  - Q&A UI      │  │                                   │ Stdio          │
│  │  │  - Reply modal │  │                                   │ (stdin/stdout)  │
│  │  └────────────────┘  │                                   │                │
│  └──────────┼────────────┘                          ┌────────┴───────────┐    │
│             │                                       │   MCP Server        │    │
│             │        File-system IPC                │   (mcp-server.mjs)  │    │
│             │     ~/.moyu-message/                  │                    │    │
│             ├──────── queue.json ───────────────────►│   - check_messages │    │
│             │◄─────── question.json ────────────────│   - ask_question   │    │
│             ├──────── answer.json ──────────────────►│   - send_progress  │    │
│             │◄─────── reply.json ───────────────────│                    │    │
│             │                                       └────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Component 1: MCP Server (`dist/mcp-server.mjs`)

- **Runtime**: Standalone Node.js process started by Cursor from `.cursor/mcp.json`
- **Protocol**: MCP over stdin/stdout (JSON-RPC 2.0)
- **Responsibilities**:
  - `check_messages` — poll user messages (blocking)
  - `ask_question` — ask the user and wait for answers
  - `send_progress` — push progress to the remote console
  - Format text/image/file messages for the agent
- **Dependency**: `@modelcontextprotocol/sdk`

#### Component 2: VSCode extension (`dist/extension.js`)

- **Runtime**: Inside Cursor as an extension
- **Responsibilities**:
  - Register Webview panel UI
  - Poll for AI questions and reply summaries
  - Queue messages from the UI
  - Install/remove MCP config
  - Drag-and-drop, history, task queue, tutorial
- **Dependency**: VSCode Extension API

#### Component 3: Webview UI (`dist/webview.js` + `dist/webview.css`)

- **Runtime**: HTML/JS in the Webview panel
- **Stack**: React 18
- **Responsibilities**:
  - Text/image/file input (with drag-and-drop)
  - Single/multi-select questions with custom text
  - Unified send/reply history list (history-item-v2 rows)
  - Send history with resend
  - Pending message queue
  - Tutorial tab

---

## 3. IPC

### 3.1 File-system IPC

The MCP server and extension are **separate processes** sharing a directory.

**Data directory**: `~/.moyu-message/` (override with `MESSENGER_DATA_DIR`)

| File | Writer | Reader | Format | Lifecycle |
|------|--------|--------|--------|-----------|
| `queue.json` | Extension | MCP server | `QueueItem[]` | Cleared to `[]` after read |
| `question.json` | MCP server | Extension | `QuestionData` | Deleted after answer |
| `answer.json` | Extension | MCP server | `AnswerData` | Deleted after read |
| `reply.json` | MCP server | Extension | `ReplyData` | Deleted after display |

### 3.2 Polling

| Poller | File | Interval | Notes |
|--------|------|----------|-------|
| MCP server | `queue.json` | 100ms | Inside `check_messages` loop |
| MCP server | `answer.json` | 100ms | Inside `ask_question` loop |
| Extension | `question.json` | 500ms | `setInterval` |
| Extension | `reply.json` | 500ms | `setInterval` |

---

## 4. Core flows

### 4.1 User sends text

1. User types in Webview and presses Enter
2. React sends `vscode.postMessage({ type: "sendText", text })`
3. Extension appends to `queue.json`
4. MCP server returns content to the agent
5. Agent replies

### 4.2 User sends image

1. User picks or drags an image
2. Image is base64-encoded in the queue
3. MCP server returns image data to the agent

### 4.3 User sends file

1. User picks a file or uses **jefr cursor: Send file to queue**
2. Text files (&lt; 512KB) are wrapped in a code block
3. Other files return name and size only

### 4.4 Agent asks a question

1. Agent calls `ask_question` → writes `question.json`
2. Extension shows the question in Webview
3. User answers → `answer.json`
4. MCP server returns the answer to the agent

### 4.5 Agent pushes reply summary

1. Agent calls `check_messages` with optional `reply`
2. Summary written to `reply.json` → appended to the Send history list in Webview

---

## 5. Perpetual loop

### 5.1 Cursor rules

Installing MCP config writes `.cursor/rules/mcp-messenger.mdc` (`alwaysApply`), requiring `check_messages` after each turn.

Because `check_messages` blocks until a new message arrives:

```
Reply → check_messages → wait → message → reply → check_messages → ...
```

### 5.2 System suffix

Each user message can include a system hint so the agent keeps calling `check_messages`.

---

## 6. MCP configuration

### 6.1 `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "jefr cursor": {
      "command": "node",
      "args": ["<extension-path>/dist/mcp-server.mjs"]
    }
  }
}
```

### 6.2 Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `check_messages` | Poll user messages (blocking) | `reply` (optional Markdown summary) |
| `ask_question` | Ask and wait for answers | `questions` (required array) |
| `send_progress` | Push progress (non-blocking) | `progress` (required Markdown) |

---

## 7. Message types

| Type | Description | MCP handling |
|------|-------------|--------------|
| `text` | Plain text | Return content |
| `image` | Image | Read file → base64 |
| `file` | File | Text content if small text file; else metadata |

Supported images: PNG, JPEG, GIF, WebP, SVG, BMP

Supported text extensions: `.txt`, `.md`, `.json`, `.js`, `.ts`, `.jsx`, `.tsx`, `.py`, and many more.

---

## 8. Build and deploy

1. `npm run compile` — build extension, webview, MCP server
2. `npx @vscode/vsce package --no-dependencies` — create `.vsix`
3. Install VSIX in Cursor
4. Restart Cursor; enable **jefr cursor** under Tools & MCP
5. Activate license key in the panel
