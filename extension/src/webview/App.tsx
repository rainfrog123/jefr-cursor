/**
 * Root component for the jefr side-panel webview.
 *
 * Owns all top-level state and routes inbound messages from the extension
 * host. Layout is a vertical flex column (`.app`): header, optional question
 * panel, then the active tab (Chat / Queue / Usage).
 */
import React, { useCallback, useEffect, useState } from "react";
import { post, vscode } from "./vscode";
import type {
  Attachment,
  HistoryItem,
  InboundMessage,
  LiveAgentInfo,
  QuestionData,
  QueueItem,
  ReplyData,
  UsageData,
} from "./types";
import { Header } from "./components/Header";
import { QuestionPanel } from "./components/QuestionPanel";
import { ChatTab } from "./components/ChatTab";
import { QueueTab } from "./components/QueueTab";
import { GeneralTab, type WorkflowLine } from "./components/GeneralTab";
import { AgentsTab } from "./components/AgentsTab";

type TabId = "chat" | "queue" | "agents" | "general";

/** Keep the workflow log bounded so it never grows without limit. */
const MAX_WORKFLOW_LINES = 600;

/** Persisted webview state shape (survives reloads via getState/setState). */
interface PersistedState {
  history?: HistoryItem[];
}

/** Keep persisted history bounded so the state blob never grows unbounded. */
const MAX_PERSISTED_HISTORY = 300;

function loadPersistedHistory(): HistoryItem[] {
  const saved = vscode.getState<PersistedState>();
  const items = saved?.history ?? [];
  // Renumber so indices stay sequential after a reload/cap.
  return items.map((it, i) => ({ ...it, index: i + 1 }));
}

export function App(): JSX.Element {
  const [version, setVersion] = useState("");
  const [tab, setTab] = useState<TabId>("chat");

  const [question, setQuestion] = useState<QuestionData | null>(null);
  const [reply, setReply] = useState<ReplyData | null>(null);

  const [history, setHistory] = useState<HistoryItem[]>(loadPersistedHistory);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueCount, setQueueCount] = useState(0);

  const [usage, setUsage] = useState<UsageData | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [tokenInjected, setTokenInjected] = useState(false);

  const [workflowRunning, setWorkflowRunning] = useState(false);
  const [workflowOutput, setWorkflowOutput] = useState<WorkflowLine[]>([]);

  const [agents, setAgents] = useState<LiveAgentInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [autoReconnect, setAutoReconnect] = useState(false);
  const [targetAgentCount, setTargetAgentCount] = useState(5);
  const [cdpConnected, setCdpConnected] = useState<boolean | undefined>(undefined);

  /* Route messages coming from the extension host. */
  useEffect(() => {
    function onMessage(event: MessageEvent<InboundMessage>) {
      const msg = event.data;
      switch (msg.type) {
        case "version":
          setVersion(msg.version);
          break;
        case "injectedTokenState":
          setTokenInjected(msg.injected);
          break;
        case "queueData":
          setQueue(msg.data);
          setQueueCount(msg.data.length);
          break;
        case "queueCount":
          setQueueCount(msg.count);
          break;
        case "showQuestion":
          setQuestion(msg.data);
          break;
        case "clearQuestion":
          setQuestion(null);
          break;
        case "showReply": {
          setReply(msg.data);
          const replyId = "reply-" + msg.data.timestamp;
          setHistory((h) =>
            h.some((it) => it.id === replyId)
              ? h
              : [
                  ...h,
                  {
                    id: replyId,
                    kind: "reply",
                    index: h.length + 1,
                    text: msg.data.content,
                    time: formatTime(msg.data.timestamp),
                  },
                ],
          );
          break;
        }
        case "historyAppend":
          setHistory((h) =>
            h.some((it) => it.id === msg.item.id)
              ? h
              : [...h, { ...msg.item, index: h.length + 1 }],
          );
          break;
        case "attachmentAdded":
          setAttachments((a) => [...a, msg.item]);
          break;
        case "usageLoading":
          setUsageLoading(true);
          break;
        case "usageData":
          setUsage(msg.data);
          setUsageLoading(false);
          break;
        case "workflowState":
          setWorkflowRunning(msg.running);
          break;
        case "workflowOutput":
          setWorkflowOutput((lines) => {
            const next = [...lines, { stream: msg.stream, line: msg.line }];
            return next.length > MAX_WORKFLOW_LINES
              ? next.slice(next.length - MAX_WORKFLOW_LINES)
              : next;
          });
          break;
        case "workflowExit":
          setWorkflowRunning(false);
          break;
        case "agentList":
          setAgents(msg.agents);
          setSelectedAgentId(msg.selected);
          setAutoReconnect(msg.autoReconnect);
          if (msg.targetAgentCount != null) setTargetAgentCount(msg.targetAgentCount);
          if (msg.cdpConnected !== undefined) setCdpConnected(msg.cdpConnected);
          break;
        case "agentSelected":
          setSelectedAgentId(msg.agentId);
          break;
        // cardState / cardActivated / cardError / serverInfo are accepted but
        // the local build keeps licensing disabled (checkCard() === true).
        default:
          break;
      }
    }
    window.addEventListener("message", onMessage);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  /* When a reply arrives, acknowledge it so the host clears reply.json. */
  useEffect(() => {
    if (reply) post({ type: "ackReply", timestamp: reply.timestamp });
  }, [reply]);

  /* Persist chat history so it survives webview/window reloads. */
  useEffect(() => {
    const prev = vscode.getState<PersistedState>() || {};
    vscode.setState({ ...prev, history: history.slice(-MAX_PERSISTED_HISTORY) });
  }, [history]);

  const switchTab = useCallback((next: TabId) => {
    setTab(next);
    if (next === "queue") post({ type: "getQueue" });
    if (next === "general") {
      post({ type: "fetchUsage" });
      post({ type: "getWorkflowState" });
    }
  }, []);

  /* Optimistically record a message the user just sent into the history,
     since the extension host does not echo sends back as history items. */
  const appendHistory = useCallback((item: Omit<HistoryItem, "index">) => {
    setHistory((h) => [...h, { ...item, index: h.length + 1 }]);
  }, []);

  /* Wipe the chat history (the persist effect clears stored state too). */
  const clearHistory = useCallback(() => setHistory([]), []);

  /* Switch the target agent. Clearing history keeps each agent's view clean,
     since replies/questions are scoped to the selected agent by the host. */
  const onSelectAgent = useCallback(
    (id: string | null) => {
      setSelectedAgentId(id);
      setHistory([]);
      post({ type: "selectAgent", agentId: id ?? undefined });
    },
    []
  );

  return (
    <div className="app">
      <Header version={version} onOpenConsole={() => post({ type: "openConsole" })} />

      {question && <QuestionPanel question={question} />}

      <div className="tab-bar">
        <TabButton id="chat" current={tab} onClick={switchTab} label="Chat" />
        <TabButton
          id="queue"
          current={tab}
          onClick={switchTab}
          label="Queue"
          badge={queueCount}
        />
        <TabButton
          id="agents"
          current={tab}
          onClick={switchTab}
          label="Agents"
          badge={agents.filter((a) => a.connected).length}
        />
        <TabButton id="general" current={tab} onClick={switchTab} label="General" />
      </div>

      <AgentPicker agents={agents} selected={selectedAgentId} onSelect={onSelectAgent} />

      {tab === "chat" && (
        <ChatTab
          history={history}
          attachments={attachments}
          setAttachments={setAttachments}
          appendHistory={appendHistory}
          onClearHistory={clearHistory}
        />
      )}
      {tab === "queue" && <QueueTab queue={queue} />}
      {tab === "agents" && (
        <AgentsTab
          agents={agents}
          selectedAgentId={selectedAgentId}
          autoReconnect={autoReconnect}
          targetAgentCount={targetAgentCount}
          cdpConnected={cdpConnected}
          workflowRunning={workflowRunning}
          onSelectAgent={onSelectAgent}
        />
      )}
      {tab === "general" && (
        <GeneralTab
          usage={usage}
          loading={usageLoading}
          tokenInjected={tokenInjected}
          workflowRunning={workflowRunning}
          workflowOutput={workflowOutput}
          onClearWorkflowOutput={() => setWorkflowOutput([])}
        />
      )}
    </div>
  );
}

function TabButton(props: {
  id: TabId;
  current: TabId;
  onClick: (id: TabId) => void;
  label: string;
  badge?: number;
}): JSX.Element {
  const active = props.id === props.current;
  return (
    <button
      className={"tab-btn" + (active ? " active" : "")}
      onClick={() => props.onClick(props.id)}
    >
      {props.label}
      {props.badge ? <span className="tab-badge">{props.badge}</span> : null}
    </button>
  );
}

/** Top strip that lists live agents and lets the user pick which one to talk
 *  to. "All (shared)" routes to the legacy shared queue. */
function AgentPicker(props: {
  agents: LiveAgentInfo[];
  selected: string | null;
  onSelect: (id: string | null) => void;
}): JSX.Element | null {
  const { agents, selected, onSelect } = props;

  // Hide entirely until at least one addressable agent shows up, so the legacy
  // single-listener setup looks unchanged.
  if (agents.length === 0 && !selected) {
    return null;
  }

  const shortId = (id: string) => id.slice(0, 8);
  const connectedCount = agents.filter((a) => a.connected).length;

  return (
    <div className="agent-picker">
      <span className="agent-picker-label">Agent</span>
      <select
        className="agent-picker-select"
        value={selected ?? ""}
        onChange={(e) => onSelect(e.target.value || null)}
      >
        <option value="">All (shared)</option>
        {agents.map((a) => (
          <option key={a.id} value={a.id}>
            {shortId(a.id)} · {a.connected ? a.state : "down"}
            {a.queueCount ? ` · ${a.queueCount} queued` : ""}
          </option>
        ))}
      </select>
      <span className="agent-picker-count">
        {connectedCount} live
      </span>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
