/**
 * Live activity panel for the agent chat window.
 *
 * The point of this component is that you should never need to look at the
 * Cursor tile to know what an agent is doing. It shows two things:
 *
 *   • a headline — the action happening right now, with a ticking elapsed
 *     timer so a stall is visually obvious (the timer is the whole reason a
 *     repeated label like "Reading foo.md" is still informative);
 *   • a rolling feed of the preceding actions, newest first.
 *
 * In General / shared mode there is no single agent, so the feed is merged
 * across every live tile and each row is tagged with the agent that did it.
 *
 * Timestamps are *observation* times from the host (Cursor's transcript records
 * carry none). They're accurate for anything that happens while the panel is
 * running, which is the case that matters here.
 */
import React, { useEffect, useMemo, useState } from "react";
import type { AgentActivityStep, LiveAgentInfo } from "../types";
import { fmtAgo } from "../format";

/** A feed row, optionally attributed to an agent (General / shared mode). */
interface FeedRow extends AgentActivityStep {
  agentId?: string;
}

const MAX_ROWS = 6;

function shortId(id: string): string {
  return id.startsWith("tile:") ? id : id.slice(0, 8);
}

/** Rough icon per tool so the feed is scannable without reading every line. */
function toolIcon(tool: string | undefined): string {
  switch (tool) {
    case "Read":
      return "📄";
    case "Write":
      return "✍";
    case "StrReplace":
      return "✎";
    case "Shell":
      return "▸";
    case "Grep":
    case "Glob":
      return "🔍";
    case "CallMcpTool":
    case "GetMcpTools":
      return "⇄";
    case "WebSearch":
    case "WebFetch":
      return "🌐";
    case undefined:
      return "💬";
    default:
      return "•";
  }
}

export function ActivityFeed(props: {
  /** The agent being viewed, or null for General / shared. */
  agent: LiveAgentInfo | null;
  /** Full roster — only used to merge the feed in General mode. */
  agents: LiveAgentInfo[];
}): JSX.Element | null {
  const { agent, agents } = props;
  const isGeneral = agent === null;

  // Re-render every second so the elapsed timer actually counts.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const sources = useMemo(
    () => (isGeneral ? agents.filter((a) => a.activity) : agent ? [agent] : []),
    [isGeneral, agents, agent],
  );

  const rows = useMemo<FeedRow[]>(() => {
    const all: FeedRow[] = [];
    for (const a of sources) {
      for (const s of a.activity?.steps ?? []) {
        all.push(isGeneral ? { ...s, agentId: a.id } : s);
      }
    }
    // Newest first. Ties keep insertion order, which groups a burst of steps
    // observed in the same read by the agent that produced them.
    all.sort((x, y) => y.firstSeen - x.firstSeen);
    return all.slice(0, MAX_ROWS);
  }, [sources, isGeneral]);

  if (rows.length === 0) return null;

  // Headline: in General the newest row across all agents wins; otherwise it's
  // this agent's own summary (which may be a jefr reply rather than a tool).
  const head = rows[0];
  const headline = isGeneral ? head.label : agent?.activity?.summary || head.label;
  const since = isGeneral ? head.firstSeen : agent?.activity?.since ?? head.firstSeen;
  const elapsed = Date.now() - since;
  const stale = elapsed > 60_000;

  const stepCount = isGeneral
    ? sources.reduce((n, a) => n + (a.activity?.stepCount ?? 0), 0)
    : agent?.activity?.stepCount ?? 0;
  const partial = isGeneral
    ? sources.some((a) => a.activity?.stepCountPartial)
    : !!agent?.activity?.stepCountPartial;

  const ended = !isGeneral && !!agent?.activity?.ended;
  const errored = !isGeneral && agent?.activity?.endStatus === "error";

  // Be explicit about latency. A feed that's half a minute behind looks exactly
  // like a live one that's stalled, and confusing the two is how you end up
  // distrusting the whole panel. When several agents are merged, report the
  // weakest source present rather than the best.
  const sourceHint = useMemo(() => {
    const present = new Set(sources.map((a) => a.activity?.source ?? "transcript"));
    if (present.has("transcript")) {
      return {
        text: "last turn",
        title:
          "Only the finished transcript is available. Cursor doesn't write it until a turn ends, so this may not reflect what the agent is doing now.",
      };
    }
    if (present.has("db")) {
      return {
        text: "~30s",
        title:
          "The Agents window isn't open, so this comes from Cursor's own conversation store. Accurate, but it lands about 30 seconds after the action.",
      };
    }
    return {
      text: "live",
      title: "Read straight from the agent tile — updates immediately.",
    };
  }, [sources]);

  return (
    <div className="activity-panel">
      <div
        className={
          "activity-now" +
          (ended ? " is-ended" : "") +
          (errored ? " is-error" : "") +
          (stale && !ended ? " is-stale" : "")
        }
      >
        <span className="activity-now-label">
          {ended ? "Ended" : "Now"}
          {!ended && <span className="activity-pulse" aria-hidden="true" />}
        </span>
        <span className="activity-now-text" title={headline}>
          {isGeneral && head.agentId && (
            <span className="activity-who">{shortId(head.agentId)}</span>
          )}
          {headline}
        </span>
        <span
          className={
            "activity-source " + (sourceHint.text === "live" ? "is-live" : "is-lagged")
          }
          title={sourceHint.title}
        >
          {sourceHint.text}
        </span>
        <span
          className="activity-now-meta"
          title={
            stale
              ? "No new activity for a while — the agent may be on a long step, or stuck"
              : "Time since this action was first seen"
          }
        >
          {fmtAgo(elapsed)}
          {stepCount > 0 && (
            <span
              className="activity-steps"
              title={
                partial
                  ? `At least ${stepCount} tool calls this turn (older ones are past the read window)`
                  : `${stepCount} tool calls this turn`
              }
            >
              {partial ? `${stepCount}+` : stepCount} steps
            </span>
          )}
        </span>
      </div>

      {rows.length > 1 && (
        <ul className="activity-feed">
          {rows.slice(1).map((r) => (
            <li key={(r.agentId ?? "") + r.sig} className="activity-row">
              <span className="activity-icon" aria-hidden="true">
                {toolIcon(r.tool)}
              </span>
              {r.agentId && <span className="activity-who">{shortId(r.agentId)}</span>}
              <span className="activity-label" title={r.label}>
                {r.label}
              </span>
              <span className="activity-ago">{fmtAgo(Date.now() - r.firstSeen)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
