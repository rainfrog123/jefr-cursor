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
  QuestionData,
  QueueItem,
  ReplyData,
  UsageData,
} from "./types";
import { Header } from "./components/Header";
import { QuestionPanel } from "./components/QuestionPanel";
import { ChatTab } from "./components/ChatTab";
import { QueueTab } from "./components/QueueTab";
import { UsageTab } from "./components/UsageTab";

type TabId = "chat" | "queue" | "usage";

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
    if (next === "usage") post({ type: "fetchUsage" });
  }, []);

  /* Optimistically record a message the user just sent into the history,
     since the extension host does not echo sends back as history items. */
  const appendHistory = useCallback((item: Omit<HistoryItem, "index">) => {
    setHistory((h) => [...h, { ...item, index: h.length + 1 }]);
  }, []);

  /* Wipe the chat history (the persist effect clears stored state too). */
  const clearHistory = useCallback(() => setHistory([]), []);

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
        <TabButton id="usage" current={tab} onClick={switchTab} label="Usage" />
      </div>

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
      {tab === "usage" && (
        <UsageTab usage={usage} loading={usageLoading} tokenInjected={tokenInjected} />
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

function formatTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
