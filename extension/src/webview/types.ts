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
  /** Optional caption for image items — also used to carry the message text when
   *  a message has both text and an image (rendered together as one bubble). */
  caption?: string;
  /** Inline image data (data: URL) so the queue can show a thumbnail. */
  dataUrl?: string;
  /** ISO timestamp. */
  timestamp: string;
}

/** One agent's pending queue, for the Queue tab's "all queues" view. */
export interface AgentQueueGroup {
  /** Agent id ("" for the shared root queue). */
  agentId: string;
  /** Short display label (e.g. first 8 chars of the id, or "General · shared"). */
  label: string;
  items: QueueItem[];
  /** True when the agent's heartbeat is fresh. */
  connected: boolean;
  /** True for the agent the MCP currently delivers queued messages to. */
  routing: boolean;
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
  /** Fresh heartbeat within the stale window (or CDP MCP connection). */
  connected: boolean;
  /** Agent state from CDP: mcp_connected, generating, planning, idle; or legacy: waiting, working. */
  state: "waiting" | "working" | "idle" | "mcp_connected" | "generating" | "planning";
  /** True when the MCP loop cut out cleanly (turn ended, "Worked for..." stamp)
   *  and the tile can be reconnected. */
  dropped?: boolean;
  /** True when the MCP loop died abruptly (a "server drop") — no "Worked for…"
   *  stamp; an errored check_messages card or messages stranded in the queue.
   *  Reconnectable in place (re-prime preserves the queue). */
  serverDropped?: boolean;
  /** Pending messages currently queued for this agent. */
  queueCount: number;
  /** Times it came online (first connect + each reconnect). */
  connectCount: number;
  /** Times the extension triggered a reconnect for it. */
  reconnectCount: number;
  /** Epoch ms the current connection began (0 when disconnected). */
  connectedSince: number;
  /** How long the most recent connection lasted before it dropped, in ms.
   *  Captured at drop time so a dropped/server-dropped tile can show
   *  "connected for X" even though connectedSince is back to 0. */
  lastConnectedMs?: number;
  /** How long the spawn/reconnect workflow took to bring this agent online, in
   *  ms (measured once, from workflow start to first successful MCP connect). */
  connectMs?: number;
  /** Model name from CDP (if available). */
  model?: string;
  /** Tile index from CDP (if available). */
  tileIndex?: number;
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

/** One line in the General-tab debug log (host runtime events). */
export interface DebugEntry {
  ts: number;
  level: "info" | "warn" | "error";
  line: string;
}

/* ------------------------------------------------------------------ */
/* Messages: extension host -> webview                                 */
/* ------------------------------------------------------------------ */

export type InboundMessage =
  | { type: "version"; version: string }
  | { type: "injectedTokenState"; injected: boolean }
  | { type: "queueData"; data: QueueItem[] }
  | { type: "allQueues"; data: AgentQueueGroup[] }
  | { type: "queueCount"; count: number }
  | { type: "showQuestion"; data: QuestionData }
  | { type: "clearQuestion" }
  | { type: "showReply"; data: ReplyData }
  | { type: "historyAppend"; item: HistoryItem; agentId?: string }
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
      /** Max agents the UI manages (slot count). */
      targetAgentCount?: number;
      /** True when CDP real-time monitoring is active. */
      cdpConnected?: boolean;
      /** The single agent a running workflow is currently spawning / re-priming.
       *  That tile shows "Connecting…" until the workflow finishes. */
      connectingAgentId?: string | null;
      /** Epoch ms the current spawn/reconnect workflow started — drives the live
       *  "Connecting… {elapsed}" timer on that tile. 0 when no workflow runs. */
      connectingSince?: number;
    }
  | { type: "agentSelected"; agentId: string | null }
  | { type: "debugLog"; entry: DebugEntry }
  | { type: "debugLogSnapshot"; entries: DebugEntry[] };

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
  | { type: "deleteQueueItem"; id: string; agentId?: string }
  | { type: "clearQueue"; agentId?: string }
  | { type: "clearAllQueues" }
  | { type: "updateQueueItem"; id: string; content: string; agentId?: string }
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
      model?: string;
      /** Keep already-open tiles so spawns accumulate agents (default true). */
      keepTiles?: boolean;
    }
  | {
      type: "reconnectWorkflow";
      tile?: number;
      opusPrompt?: string;
      maxSecs?: number;
      enterInterval?: number;
    }
  | { type: "stopWorkflow" }
  | { type: "getWorkflowState" }
  | { type: "getDebugLog" }
  | { type: "clearDebugLog" }
  | { type: "selectAgent"; agentId?: string }
  | { type: "setAutoReconnect"; enabled: boolean }
  | { type: "reconnectAgent"; agentId: string }
  | { type: "addAgent"; model?: string }
  | { type: "addAgents"; count?: number; model?: string }
  | { type: "deleteAgent"; agentId: string }
  | { type: "focusAgent"; agentId: string }
  | { type: "refreshAgents" }
  | { type: "closeDropped" };
