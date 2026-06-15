# CursorMCP对话插件 Cursor 对话插件 - 工作原理

## 1. 项目概述

CursorMCP对话插件是一个 Cursor IDE 插件，通过 **Model Context Protocol (MCP)** 在 Cursor 原生对话框之外建立一条旁路通信通道，让用户可以通过插件的 Webview 面板与 AI 进行持续交互。

**核心价值**：无需在 Cursor 对话框中手动输入，通过插件 UI 发送消息即可驱动 AI 持续工作，形成"发消息 → AI 处理 → 等待新消息"的永续循环。

---

## 2. 系统架构

### 2.1 三大组件

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           Cursor IDE                                        │
│                                                                              │
│  ┌─────────────────────┐                          ┌────────────────────┐    │
│  │   VSCode 扩展        │                          │   Cursor AI Agent  │    │
│  │   (extension.js)     │                          │                    │    │
│  │                      │                          │   - 处理用户请求     │    │
│  │  ┌────────────────┐  │                          │   - 调用 MCP 工具   │    │
│  │  │  Webview 面板   │  │                          │   - 生成回复        │    │
│  │  │  (React UI)     │  │                          │                    │    │
│  │  │  - 消息输入框   │  │                          └────────┬───────────┘    │
│  │  │  - 问题回答 UI  │  │                                   │                │
│  │  │  - 回复弹窗     │  │                                   │ Stdio          │
│  │  └────────────────┘  │                                   │ (stdin/stdout)  │
│  │          │            │                                   │                │
│  └──────────┼────────────┘                          ┌────────┴───────────┐    │
│             │                                       │   MCP Server        │    │
│             │                                       │   (mcp-server.mjs)  │    │
│             │        文件系统 IPC                     │                    │    │
│             │     ~/.moyu-message/                   │   - check_messages │    │
│             ├──────── queue.json ───────────────────►│   - ask_question   │    │
│             │◄─────── question.json ────────────────│                    │    │
│             ├──────── answer.json ──────────────────►│                    │    │
│             │◄─────── reply.json ───────────────────│                    │    │
│             │                                       └────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### 组件 1：MCP Server（`dist/mcp-server.mjs`）

- **运行方式**：独立 Node.js 进程，由 Cursor 根据 `.cursor/mcp.json` 配置自动启动
- **通信协议**：通过 stdin/stdout 使用 MCP 标准协议（JSON-RPC 2.0）与 Cursor AI 通信
- **职责**：
  - 提供 `check_messages` 工具 — 轮询用户消息并返回
  - 提供 `ask_question` 工具 — 向用户提问并等待回答
  - 处理消息（文本/图片/文件）格式转换
- **依赖**：`@modelcontextprotocol/sdk`

#### 组件 2：VSCode 扩展（`dist/extension.js`）

- **运行方式**：在 Cursor IDE 内部作为扩展运行
- **职责**：
  - 注册 Webview 面板，提供用户界面
  - 轮询检测 AI 的提问和回复
  - 处理用户通过 UI 发送的消息
  - 管理 MCP 配置的安装/卸载
  - 注入增强功能（拖拽上传、消息队列、历史增强、使用教程）
- **依赖**：VSCode Extension API

#### 组件 3：Webview UI（`dist/webview.js` + `dist/webview.css`）

- **运行方式**：在扩展的 Webview 面板中作为 HTML/JS 渲染
- **技术栈**：React 18
- **职责**：
  - 消息输入框（文本/图片/文件，支持拖拽）
  - 问题回答界面（单选/多选 + 自定义输入）
  - 回复摘要弹窗
  - 发送历史记录（含时间戳和重发功能）
  - 消息待发队列
  - 使用教程

---

## 3. 通信机制详解

### 3.1 文件系统 IPC

MCP Server 和 VSCode 扩展是两个**完全独立的进程**，通过共享文件目录实现进程间通信。

**数据目录**：`~/.moyu-message/`（可通过环境变量 `MESSENGER_DATA_DIR` 覆盖）

| 文件 | 写入方 | 读取方 | 数据格式 | 生命周期 |
|------|--------|--------|---------|---------|
| `queue.json` | VSCode 扩展 | MCP Server | `QueueItem[]` | 读完后清空为 `[]` |
| `question.json` | MCP Server | VSCode 扩展 | `QuestionData` | 用户回答后删除 |
| `answer.json` | VSCode 扩展 | MCP Server | `AnswerData` | 读完后删除 |
| `reply.json` | MCP Server | VSCode 扩展 | `ReplyData` | 展示后删除 |

### 3.2 轮询频率

| 轮询方 | 目标文件 | 频率 | 说明 |
|--------|---------|------|------|
| MCP Server | `queue.json` | 100ms | `check_messages` 工具内部 while 循环 |
| MCP Server | `answer.json` | 100ms | `ask_question` 工具内部 while 循环 |
| VSCode 扩展 | `question.json` | 500ms | `setInterval` 定时器 |
| VSCode 扩展 | `reply.json` | 500ms | `setInterval` 定时器 |

---

## 4. 核心流程

### 4.1 用户发送文本消息

1. 用户在 Webview 输入框中输入文本，按 Enter
2. React 组件通过 `vscode.postMessage({ type: "sendText", text })` 发送到扩展
3. 扩展调用 `sendText(text)` → 追加到 `queue.json`
4. MCP Server 轮询发现新消息，处理后返回给 Cursor AI
5. AI 处理并回复

### 4.2 用户发送图片

1. 用户点击"图片"按钮或拖拽图片到输入区
2. 图片被读取并 base64 编码
3. 通过 `queue.json` 传递，MCP Server 返回图片数据给 AI

### 4.3 用户发送文件

1. 用户点击"文件"按钮，或右键资源管理器 → "CursorMCP对话插件: 发送文件到输入框"
2. 文本文件（< 512KB）读取内容包裹在代码块中
3. 其他文件仅返回文件名和大小信息

### 4.4 AI 向用户提问

1. AI 调用 `ask_question` 工具，写入 `question.json`
2. 扩展轮询发现后推送到 Webview 展示
3. 用户选择后，回答写入 `answer.json`
4. MCP Server 读取回答返回给 AI

### 4.5 AI 推送回复摘要

1. AI 调用 `check_messages` 时传入 `reply` 参数
2. 摘要写入 `reply.json`，扩展推送到 Webview 弹窗展示

---

## 5. 永续循环机制

### 5.1 Cursor Rules

安装 MCP 配置时，会在工作区写入 `.cursor/rules/mcp-messenger.mdc`（alwaysApply 规则），强制要求 AI 在每轮回复后调用 `check_messages`。

由于 `check_messages` 内部是无限 while 循环（阻塞到有新消息），形成永续循环：

```
AI 回复完毕 → 调用 check_messages → 等待用户消息 → 返回给 AI → AI 回复 → 再次调用...
```

### 5.2 系统后缀

每条用户消息末尾会追加系统提示，作为双保险机制确保 AI 继续调用 `check_messages`。

---

## 6. MCP 配置

### 6.1 `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "CursorMCP对话插件": {
      "command": "node",
      "args": ["<扩展安装路径>/dist/mcp-server.mjs"]
    }
  }
}
```

### 6.2 工具定义

| 工具 | 描述 | 参数 |
|------|------|------|
| `check_messages` | 轮询用户消息（阻塞式） | `reply`（可选，Markdown 摘要） |
| `ask_question` | 向用户提问并等待回答 | `questions`（必填，问题数组） |

---

## 7. 消息类型

| 类型 | 说明 | MCP Server 处理 |
|------|------|----------------|
| `text` | 文本消息 | 直接返回文本内容 |
| `image` | 图片消息 | 读取文件 → base64 → 返回图片数据 |
| `file` | 文件消息 | 文本文件读内容（< 512KB），其他返回元信息 |

支持的图片格式：PNG、JPEG、GIF、WebP、SVG、BMP

支持的文本文件：`.txt`, `.md`, `.json`, `.js`, `.ts`, `.jsx`, `.tsx`, `.py`, `.java`, `.c`, `.cpp`, `.css`, `.html`, `.xml`, `.yaml`, `.yml`, `.vue`, `.svelte` 等 30+ 种

---

## 8. 项目结构

```
xw-cursor-message/
├── package.json              # 插件配置与构建脚本
├── media/icon.svg            # 侧边栏图标
├── mcp-server/index.ts       # MCP Server 源码
├── src/
│   ├── extension.ts          # 扩展入口（Webview、命令、轮询）
│   ├── messenger.ts          # 文件 IPC 层
│   └── webview/
│       ├── index.tsx          # React UI
│       └── webview.css        # 样式
└── dist/                      # 构建产物
    ├── extension.js
    ├── mcp-server.mjs
    ├── webview.js
    └── webview.css
```

---

## 9. 构建与部署

1. `npm run compile` — 编译所有组件（esbuild）
2. `npx @vscode/vsce package --no-dependencies` — 生成 `.vsix`
3. Cursor 中 `Extensions: Install from VSIX...` 安装
4. 重启 Cursor，确认 Tools & MCP 中"CursorMCP对话插件"已启用
5. 在插件中激活卡密即可使用
