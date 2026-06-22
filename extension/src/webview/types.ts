/**
 * Shared types for the jefr webview UI.
 *
 * These describe the message protocol between the webview (this React app)
 * and the VS Code / Cursor extension host (`dist/extension.js`), plus the
 * data shapes that travel over that bridge.
 *
 * Reconstructed from the readable `extension.js` bridge handler and the
 * `webview.css` class inventory. See `README.md` in this folder.
 */

/* ------------------------------------------------------------------ */
/* Data shapes (mirrors of the JSON files used for file-system IPC)    */
/* ------------------------------------------------------------------ */

/** One pending item the user queued for the agent. */
export interface QueueItem {
  id: string;
  type: "text" | "image" | "file";
  /** Present for text items. */
  content?: string;
  /** Present for image/file items (absolute path on disk). */
  path?: string;
  /** Optional display name for image/file items. */
  name?: string;
  /** Optional caption for image items. */
  caption?: string;
  /** ISO timestamp. */
  timestamp: string;
}

/** A single question inside a `QuestionData` payload. */
export interface QuestionItem {
  id: string;
  question: string;
  options: Array<{ id: string; label: string }>;
  /** When true the user may pick multiple options. */
  allow_multiple?: boolean;
}

/** Payload written by the MCP server when the agent calls `ask_question`. */
export interface QuestionData {
  id: string;
  questions: QuestionItem[];
}

/** One answer the user submits back for a `QuestionItem`. */
export interface AnswerItem {
  questionId: string;
  /** Selected option ids. */
  selected: string[];
  /** Free-text "Other" notes. */
  other: string;
}

/** Payload written back when the user answers. */
export interface AnswerData {
  id: string;
  answers: AnswerItem[];
}

/** Reply summary pushed by the agent via `check_messages({ reply })`. */
export interface ReplyData {
  content: string;
  timestamp: string;
}

/** A row in the send/reply history list (`.history-item-v2`). */
export interface HistoryItem {
  id: string;
  /** "text" | "image" | "file" for user sends, "reply" for AI replies. */
  kind: "text" | "image" | "file" | "reply";
  index?: number;
  text?: string;
  caption?: string;
  path?: string;
  name?: string;
  dataUrl?: string;
  time?: string;
}

/** A staged attachment in the composer before sending. */
export interface Attachment {
  id: string;
  type: "image" | "file";
  path: string;
  name: string;
  dataUrl?: string;
}

/** An agent in the manager roster (connected or recently dropped). */
export interface LiveAgentInfo {
  /** The agent's stable id (its Cursor agentId / chat UUID). */
  id: string;
  /** Fresh heartbeat within the stale window. */
  connected: boolean;
  state: "waiting" | "working" | "idle";
  /** Pending messages currently queued for this agent. */
  queueCount: number;
  /** Times it came online (first connect + each reconnect). */
  connectCount: number;
  /** Times the extension triggered a reconnect for it. */
  reconnectCount: number;
  /** Epoch ms the current connection began (0 when disconnected). */
  connectedSince: number;
}

/** Cursor usage info returned by `fetchUsage`. */
export interface UsageData {
  success: boolean;
  error?: string;
  email?: string;
  membershipType?: string;
  isUnlimited?: boolean;
  used?: number;
  limit?: number;
  // The real payload carries more fields; these are the ones the UI reads.
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/* Messages: extension host -> webview                                 */
/* ------------------------------------------------------------------ */

export type InboundMessage =
  | { type: "version"; version: string }
  | { type: "injectedTokenState"; injected: boolean }
  | { type: "queueData"; data: QueueItem[] }
  | { type: "queueCount"; count: number }
  | { type: "showQuestion"; data: QuestionData }
  | { type: "clearQuestion" }
  | { type: "showReply"; data: ReplyData }
  | { type: "historyAppend"; item: HistoryItem }
  | { type: "attachmentAdded"; item: Attachment }
  | { type: "cardState"; data: { active: boolean } }
  | { type: "cardActivated"; data: unknown }
  | { type: "cardError"; error: string }
  | { type: "usageLoading" }
  | { type: "usageData"; data: UsageData }
  | { type: "serverInfo"; data: { port: number; clients: number } }
  | { type: "workflowState"; running: boolean }
  | { type: "workflowOutput"; stream: "stdout" | "stderr"; line: string }
  | { type: "workflowExit"; code: number | null }
  | {
      type: "agentList";
      agents: LiveAgentInfo[];
      selected: string | null;
      autoReconnect: boolean;
    }
  | { type: "agentSelected"; agentId: string | null };

/* ------------------------------------------------------------------ */
/* Messages: webview -> extension host                                 */
/* ------------------------------------------------------------------ */

export type OutboundMessage =
  | { type: "ready" }
  | { type: "sendText"; text: string }
  | { type: "pickAttachment" }
  | { type: "sendImage"; caption: string }
  | { type: "sendPastedImage"; dataUrl: string; caption: string }
  | { type: "sendFile" }
  | { type: "resendFile"; path: string }
  | { type: "submitAnswer"; data: AnswerData }
  | { type: "cancelQuestion" }
  | { type: "ackReply"; timestamp?: string }
  | { type: "activateCard"; code: string }
  | { type: "logoutCard" }
  | { type: "getQueue" }
  | { type: "deleteQueueItem"; id: string }
  | { type: "clearQueue" }
  | { type: "updateQueueItem"; id: string; content: string }
  | { type: "fetchUsage" }
  | { type: "injectToken"; token: string }
  | { type: "clearInjectedToken" }
  | { type: "openConsole" }
  | { type: "getServerInfo" }
  | {
      type: "runWorkflow";
      autoPrompt?: string;
      opusPrompt?: string;
      maxSecs?: number;
      enterInterval?: number;
    }
  | { type: "stopWorkflow" }
  | { type: "getWorkflowState" }
  | { type: "selectAgent"; agentId?: string }
  | { type: "setAutoReconnect"; enabled: boolean }
  | { type: "reconnectAgent"; agentId: string };
