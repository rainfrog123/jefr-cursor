/**
 * Root component for the jefr side-panel webview.
 *
 * Owns all top-level state and routes inbound messages from the extension
 * host. Layout is a vertical flex column (`.app`): header, optional question
 * panel, then the active tab (Chat / Queue / Usage).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { post, vscode } from "./vscode";
import type {
  AgentQueueGroup,
  DebugEntry,
  Attachment,
  HistoryItem,
  InboundMessage,
  LiveAgentInfo,
  QuestionData,
  QueueItem,
  ReplyData,
  UsageData,
} from "./types";
import { QuestionPanel } from "./components/QuestionPanel";
import { QueueTab } from "./components/QueueTab";
import { GeneralTab, type WorkflowLine } from "./components/GeneralTab";
import { AgentsTab } from "./components/AgentsTab";
import { AgentDetail } from "./components/AgentDetail";
import { applyScale, loadScale } from "./fontScale";

type TabId = "agents" | "queue" | "general";
type AgentView = "list" | "detail";

/** Keep the workflow log bounded so it never grows without limit. */
const MAX_WORKFLOW_LINES = 600;

/** Per-agent chat history, keyed by agent id (or SHARED_KEY for the shared
 *  queue). Each agent's conversation is preserved across switches/reloads. */
type Histories = Record<string, HistoryItem[]>;

/** Map key for the shared ("General") chat. */
const SHARED_KEY = "__shared__";
const keyFor = (id: string | null): string => id ?? SHARED_KEY;

/** Persisted webview state shape (survives reloads via getState/setState). */
interface PersistedState {
  /** Legacy single-history blob (migrated into the shared bucket on load). */
  history?: HistoryItem[];
  histories?: Histories;
}

/** Keep each agent's persisted history bounded so the blob never grows unbounded. */
const MAX_PERSISTED_HISTORY = 300;

function loadPersistedHistories(): Histories {
  const saved = vscode.getState<PersistedState>();
  const stored = saved?.histories ?? {};
  const out: Histories = {};
  for (const [k, items] of Object.entries(stored)) {
    out[k] = items.map((it, i) => ({ ...it, index: i + 1 }));
  }
  // Migrate any legacy single-history blob into the shared bucket.
  if (saved?.history && saved.history.length && !out[SHARED_KEY]) {
    out[SHARED_KEY] = saved.history.map((it, i) => ({ ...it, index: i + 1 }));
  }
  return out;
}

export function App(): JSX.Element {
  const [version, setVersion] = useState("");
  const [tab, setTab] = useState<TabId>("agents");
  const [agentView, setAgentView] = useState<AgentView>("list");

  const [question, setQuestion] = useState<QuestionData | null>(null);
  const [reply, setReply] = useState<ReplyData | null>(null);

  const [histories, setHistories] = useState<Histories>(loadPersistedHistories);
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  /* The message handler is registered once, so it reads the live selection via a
     ref to route replies/history into the right agent's bucket. */
  const selectedRef = useRef<string | null>(null);

  /** Append an item to a specific agent's history bucket (deduped by id). */
  const appendToHistory = useCallback(
    (key: string, item: HistoryItem) => {
      setHistories((all) => {
        const cur = all[key] ?? [];
        if (cur.some((it) => it.id === item.id)) return all;
        return { ...all, [key]: [...cur, { ...item, index: cur.length + 1 }] };
      });
    },
    [],
  );

  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueCount, setQueueCount] = useState(0);
  const [queueGroups, setQueueGroups] = useState<AgentQueueGroup[]>([]);

  const [usage, setUsage] = useState<UsageData | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [tokenInjected, setTokenInjected] = useState(false);

  const [workflowRunning, setWorkflowRunning] = useState(false);
  const [workflowOutput, setWorkflowOutput] = useState<WorkflowLine[]>([]);
  const [debugLog, setDebugLog] = useState<DebugEntry[]>([]);

  const [agents, setAgents] = useState<LiveAgentInfo[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [autoReconnect, setAutoReconnect] = useState(false);
  const [targetAgentCount, setTargetAgentCount] = useState(5);
  const [cdpConnected, setCdpConnected] = useState<boolean | undefined>(undefined);
  const [connectingAgentId, setConnectingAgentId] = useState<string | null>(null);
  const [connectingSince, setConnectingSince] = useState<number>(0);

  /* Apply the saved font scale on first load. The FontScale control now lives on
     the General tab / chat toolbar, so without this top-level apply the saved zoom
     wouldn't take effect until one of those mounted (the bug where it only kicked
     in after visiting General and switching back). */
  useEffect(() => {
    applyScale(loadScale());
  }, []);

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
        case "allQueues":
          setQueueGroups(msg.data);
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
          appendToHistory(keyFor(selectedRef.current), {
            id: "reply-" + msg.data.timestamp,
            kind: "reply",
            text: msg.data.content,
            time: formatTime(msg.data.timestamp),
          });
          break;
        }
        case "historyAppend":
          appendToHistory(keyFor(selectedRef.current), msg.item);
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
        case "debugLog":
          setDebugLog((l) => {
            const next = [...l, msg.entry];
            return next.length > 600 ? next.slice(next.length - 600) : next;
          });
          break;
        case "debugLogSnapshot":
          setDebugLog(msg.entries);
          break;
        case "agentList":
          setAgents(msg.agents);
          setSelectedAgentId(msg.selected);
          setAutoReconnect(msg.autoReconnect);
          if (msg.targetAgentCount != null) setTargetAgentCount(msg.targetAgentCount);
          if (msg.cdpConnected !== undefined) setCdpConnected(msg.cdpConnected);
          setConnectingAgentId(msg.connectingAgentId ?? null);
          setConnectingSince(msg.connectingSince ?? 0);
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

  /* Auto-select the first agent once, so the panel opens with one already active
     (MCP routes to it). Skips if the host already restored a selection, and only
     fires once so picking "All (shared)" later isn't overridden. Doesn't clear
     history (unlike a manual switch) to preserve the restored chat view. */
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (didAutoSelect.current) return;
    if (selectedAgentId) {
      didAutoSelect.current = true;
      return;
    }
    if (agents.length === 0) return;
    didAutoSelect.current = true;
    const first = [...agents].sort(
      (a, b) => (a.tileIndex ?? 0) - (b.tileIndex ?? 0),
    )[0];
    setSelectedAgentId(first.id);
    post({ type: "selectAgent", agentId: first.id });
  }, [agents, selectedAgentId]);

  /* Keep the selection ref in sync for the (once-registered) message handler. */
  useEffect(() => {
    selectedRef.current = selectedAgentId;
  }, [selectedAgentId]);

  /* When a reply arrives, acknowledge it so the host clears reply.json. */
  useEffect(() => {
    if (reply) post({ type: "ackReply", timestamp: reply.timestamp });
  }, [reply]);

  /* Persist every agent's history (bounded per agent) so each conversation
     survives webview/window reloads. */
  useEffect(() => {
    const prev = vscode.getState<PersistedState>() || {};
    const bounded: Histories = {};
    for (const [k, items] of Object.entries(histories)) {
      if (items.length) bounded[k] = items.slice(-MAX_PERSISTED_HISTORY);
    }
    vscode.setState({ ...prev, histories: bounded, history: undefined });
  }, [histories]);

  const switchTab = useCallback((next: TabId) => {
    setTab(next);
    if (next === "queue") post({ type: "getQueue" });
    if (next === "general") {
      post({ type: "fetchUsage" });
      post({ type: "getWorkflowState" });
      post({ type: "getDebugLog" });
    }
  }, []);

  /* Optimistically record a message the user just sent into the active agent's
     history, since the host doesn't echo sends back as history items. */
  const appendHistory = useCallback(
    (item: Omit<HistoryItem, "index">) => {
      appendToHistory(keyFor(selectedRef.current), item as HistoryItem);
    },
    [appendToHistory],
  );

  /* Clear just the active agent's conversation. */
  const clearHistory = useCallback(() => {
    const key = keyFor(selectedRef.current);
    setHistories((all) => ({ ...all, [key]: [] }));
  }, []);

  /* Switch the target agent. History is per-agent and preserved, so switching
     simply shows that agent's own conversation. */
  const onSelectAgent = useCallback(
    (id: string | null) => {
      setSelectedAgentId(id);
      post({ type: "selectAgent", agentId: id ?? undefined });
    },
    []
  );

  /* The active agent's conversation (derived from the per-agent map). */
  const history = histories[keyFor(selectedAgentId)] ?? [];

  /* Open a target's detail+chat page (null = General/shared). Selecting routes
     MCP here so the detail's chat talks to this agent. */
  const openDetail = useCallback(
    (id: string | null) => {
      onSelectAgent(id);
      setAgentView("detail");
    },
    [onSelectAgent],
  );

  /* If the open agent is deleted/vanishes, fall back to the roster. Shared
     (null) is always valid. */
  useEffect(() => {
    if (agentView !== "detail" || selectedAgentId === null) return;
    if (!agents.some((a) => a.id === selectedAgentId)) setAgentView("list");
  }, [agentView, selectedAgentId, agents]);

  const detailAgent =
    selectedAgentId !== null
      ? agents.find((a) => a.id === selectedAgentId) ?? null
      : null;

  /* Tab badge reflects pending items across every agent's queue, not just the
     routing target — the Queue tab now shows all of them. */
  const totalQueued = queueGroups.reduce((n, g) => n + g.items.length, 0);
  const queueBadge = queueGroups.length ? totalQueued : queueCount;
  /* The General card/detail must show the SHARED ROOT queue specifically — not
     `queueCount`, which tracks the currently-selected agent. Pull the root group
     (empty agentId) straight from the per-agent snapshot so the shared count
     never mirrors a selected agent's own queue. */
  const sharedRootCount =
    queueGroups.find((g) => !g.agentId)?.items.length ?? 0;

  return (
    <div className="app">
      {question && <QuestionPanel question={question} />}

      <div className="tab-bar">
        <TabButton
          id="agents"
          current={tab}
          onClick={switchTab}
          label="Agents"
          badge={
            agents.filter((a) => a.connected && a.id !== connectingAgentId)
              .length
          }
        />
        <TabButton
          id="queue"
          current={tab}
          onClick={switchTab}
          label="Queue"
          badge={queueBadge}
        />
        <TabButton id="general" current={tab} onClick={switchTab} label="General" />
      </div>

      {tab === "agents" && agentView === "list" && (
        <AgentsTab
          agents={agents}
          selectedAgentId={selectedAgentId}
          autoReconnect={autoReconnect}
          targetAgentCount={targetAgentCount}
          cdpConnected={cdpConnected}
          workflowRunning={workflowRunning}
          connectingAgentId={connectingAgentId}
          connectingSince={connectingSince}
          sharedQueueCount={sharedRootCount}
          onSelectAgent={onSelectAgent}
          onOpenDetail={openDetail}
        />
      )}
      {tab === "agents" && agentView === "detail" && (
        <AgentDetail
          agent={detailAgent}
          connectingAgentId={connectingAgentId}
          workflowRunning={workflowRunning}
          sharedQueueCount={sharedRootCount}
          history={history}
          attachments={attachments}
          setAttachments={setAttachments}
          appendHistory={appendHistory}
          onClearHistory={clearHistory}
          onBack={() => setAgentView("list")}
          version={version}
          onOpenConsole={() => post({ type: "openConsole" })}
        />
      )}
      {tab === "queue" && (
        <QueueTab
          groups={queueGroups}
          routingLabel={
            selectedAgentId ? selectedAgentId.slice(0, 8) : "General · shared"
          }
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
          debugLog={debugLog}
          onClearDebugLog={() => {
            setDebugLog([]);
            post({ type: "clearDebugLog" });
          }}
          version={version}
          onOpenConsole={() => post({ type: "openConsole" })}
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


function formatTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
