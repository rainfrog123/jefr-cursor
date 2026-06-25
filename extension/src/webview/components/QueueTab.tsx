/**
 * Queue tab: pending items queued for the agents. Shows EVERY agent's queue
 * (connected or not) grouped per agent, and marks the one the MCP currently
 * routes to. Supports inline editing of text items, deleting one item, or
 * clearing a single agent's queue.
 */
import React, { useState } from "react";
import { post } from "../vscode";
import type { AgentQueueGroup, QueueItem } from "../types";

export function QueueTab(props: {
  groups: AgentQueueGroup[];
  routingLabel: string;
}): JSX.Element {
  const { groups, routingLabel } = props;
  const totalItems = groups.reduce((n, g) => n + g.items.length, 0);

  // Only agents that actually hold messages are shown; idle ones are just a count.
  const withMessages = groups
    .filter((g) => g.items.length > 0)
    .sort((a, b) => {
      // Routing target first, then shared root, then by id — stable.
      if (a.routing !== b.routing) return a.routing ? -1 : 1;
      if (!a.agentId !== !b.agentId) return a.agentId ? 1 : -1;
      return a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0;
    });
  const idleCount = groups.length - withMessages.length;

  return (
    <div className="queue-tab">
      <div
        className="queue-routing"
        title="Queued messages are delivered to the routing agent"
      >
        <span className="queue-routing-label">Routing to</span>
        <span className="queue-routing-target">{routingLabel}</span>
        {idleCount > 0 && (
          <span className="queue-routing-idle">
            {idleCount} idle queue{idleCount === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {totalItems === 0 ? (
        <div className="queue-empty">
          <div className="queue-empty-icon">∅</div>
          <div className="queue-empty-title">No messages queued</div>
          <div className="queue-empty-hint">
            Messages waiting for an agent show up here.
          </div>
        </div>
      ) : (
        <>
          <div className="queue-tab-toolbar">
            <span className="queue-tab-count">
              {totalItems} message{totalItems === 1 ? "" : "s"} ·{" "}
              {withMessages.length} agent{withMessages.length === 1 ? "" : "s"}
            </span>
            <button
              className="btn-danger-outline"
              onClick={() => post({ type: "clearAllQueues" })}
              title="Clear every queue — the shared root and all agents"
            >
              Clear all
            </button>
          </div>
          <div className="queue-tab-list">
            {withMessages.map((group) => (
              <QueueGroupSection key={group.agentId || "__root__"} group={group} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function QueueGroupSection(props: { group: AgentQueueGroup }): JSX.Element {
  const { group } = props;
  return (
    <section className={"queue-group" + (group.routing ? " routing" : "")}>
      <div className="queue-group-header">
        <div className="queue-group-id">
          <span
            className={
              "queue-group-dot " + (group.connected ? "online" : "offline")
            }
            title={group.connected ? "Connected" : "Disconnected"}
          />
          <span className="queue-group-label">{group.label}</span>
          {group.routing && <span className="queue-group-routes">routes here</span>}
        </div>
        <div className="queue-group-meta">
          <span className="queue-group-count">{group.items.length}</span>
          <button
            className="btn-danger-outline btn-small"
            onClick={() => post({ type: "clearQueue", agentId: group.agentId })}
            title="Clear this agent's queue"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="queue-group-items">
        {group.items.map((item, idx) => (
          <QueueRow
            key={item.id}
            item={item}
            agentId={group.agentId}
            index={idx + 1}
          />
        ))}
      </div>
    </section>
  );
}

function QueueRow(props: {
  item: QueueItem;
  agentId: string;
  index: number;
}): JSX.Element {
  const { item, agentId, index } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.content || "");

  const save = () => {
    post({ type: "updateQueueItem", id: item.id, content: draft, agentId });
    setEditing(false);
  };

  return (
    <div className={"queue-tab-item" + (editing ? " editing" : "")}>
      <div className="queue-tab-item-top">
        <span className="queue-tab-num" title={`Message ${index} in this queue`}>
          {index}
        </span>
        <span className={"queue-type-badge type-" + item.type}>
          {item.type.toUpperCase()}
        </span>
        <span className="queue-tab-time">{formatTime(item.timestamp)}</span>
      </div>

      <div className="queue-tab-item-body">
        {editing ? (
          <textarea
            className="queue-edit-textarea"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        ) : item.type === "image" ? (
          <div className="queue-img">
            {item.dataUrl ? (
              <img className="queue-img-thumb" src={item.dataUrl} alt={item.caption || item.name || "image"} />
            ) : (
              <span className="queue-img-name">{item.name || (item.path || "").split(/[\\/]/).pop()}</span>
            )}
            {item.caption && <div className="queue-img-caption">{item.caption}</div>}
          </div>
        ) : item.type === "file" ? (
          <div className="queue-tab-item-content">
            {item.name || (item.path || "").split(/[\\/]/).pop()}
          </div>
        ) : (
          <div className="queue-tab-item-content">{item.content}</div>
        )}
      </div>

      <div className="queue-tab-item-actions">
        {item.type === "text" &&
          (editing ? (
            <button className="btn btn-primary btn-small" onClick={save}>
              Save
            </button>
          ) : (
            <button
              className="btn btn-secondary btn-small"
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          ))}
        <button
          className="btn btn-secondary btn-small"
          onClick={() => post({ type: "deleteQueueItem", id: item.id, agentId })}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
