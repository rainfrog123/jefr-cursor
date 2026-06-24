/**
 * Pure agent connection-tracking logic (no vscode imports), so it can be unit
 * tested directly. The extension host feeds it the current roster each poll; it
 * maintains connect/reconnect counters and decides which dropped agent to
 * re-prime, while the host owns the side effects (spawning the workflow).
 */

export interface AgentStat {
  /** Times the agent came online (first connect + each reconnect landing). */
  connectCount: number;
  /** Times the host triggered a reconnect for it. */
  reconnectCount: number;
  /** Reconnect attempts since the last successful landing (resets on connect).
   *  Used to cap futile reconnects so a dead tile can't be re-primed forever. */
  reconnectsSinceConnect: number;
  connected: boolean;
  /** Epoch ms the current connection began (0 when disconnected). */
  connectedSince: number;
  lastSeen: number;
  lastReconnectAt: number;
}

export interface RosterEntry {
  id: string;
  connected: boolean;
  state: "waiting" | "working" | "idle";
  queueCount: number;
  /** Epoch ms of this agent's last heartbeat (0 when none). Survives extension
   *  restarts, so it's the source of truth for how long an agent has been gone. */
  ts: number;
}

export interface ReconcileOpts {
  /** Forget (drop from the roster) disconnected agents whose last heartbeat is
   *  older than this — they're tombstones from closed tabs / past sessions. */
  forgetMs: number;
  /** Max auto-reconnect attempts between successful landings before giving up. */
  maxReconnects: number;
}

export interface AgentView extends RosterEntry {
  connectCount: number;
  reconnectCount: number;
  connectedSince: number;
}

export function newStat(): AgentStat {
  return {
    connectCount: 0,
    reconnectCount: 0,
    reconnectsSinceConnect: 0,
    connected: false,
    connectedSince: 0,
    lastSeen: 0,
    lastReconnectAt: 0,
  };
}

/**
 * Fold the current roster into the persistent stats map (mutating it), and
 * return:
 *  - `views`:   the agents to show — connected ones plus *recently* dropped ones.
 *  - `dropped`: ids eligible for auto-reconnect (recently dropped, connected at
 *               least once, and under the attempt cap).
 *  - `prune`:   tombstone ids to forget — disconnected past the forget window or
 *               junk dirs that never produced a heartbeat. The host removes their
 *               stats (and optionally their on-disk dir) so they stop lingering
 *               and stop driving reconnects.
 */
export function reconcile(
  roster: RosterEntry[],
  stats: Map<string, AgentStat>,
  now: number,
  opts: ReconcileOpts,
): { views: AgentView[]; dropped: string[]; prune: string[] } {
  const views: AgentView[] = [];
  const dropped: string[] = [];
  const prune: string[] = [];

  for (const r of roster) {
    let s = stats.get(r.id);
    if (!s) {
      s = newStat();
      stats.set(r.id, s);
    }
    if (r.connected) {
      if (!s.connected) {
        s.connected = true;
        s.connectCount++;
        s.connectedSince = now;
        s.reconnectsSinceConnect = 0; // a fresh landing clears the attempt cap
      }
      s.lastSeen = now;
    } else if (s.connected) {
      s.connected = false;
      s.connectedSince = 0;
    }

    // Best estimate of when this agent was last alive: its heartbeat timestamp
    // (survives extension restarts) or the last time we saw it fresh.
    const lastAlive = r.ts > 0 ? Math.max(r.ts, s.lastSeen) : s.lastSeen;

    // Tombstone: disconnected and either never had a heartbeat or has been gone
    // longer than the forget window. Drop it from the roster and report it for
    // cleanup so it stops being shown and stops being reconnected.
    if (!r.connected && (lastAlive === 0 || now - lastAlive > opts.forgetMs)) {
      prune.push(r.id);
      continue;
    }

    views.push({
      id: r.id,
      connected: r.connected,
      state: r.state,
      queueCount: r.queueCount,
      connectCount: s.connectCount,
      reconnectCount: s.reconnectCount,
      connectedSince: r.connected ? s.connectedSince : 0,
    });

    // Eligible for auto-reconnect: recently dropped, has connected before, and
    // hasn't exhausted the attempt cap since its last successful landing.
    if (
      !r.connected &&
      s.connectCount > 0 &&
      s.reconnectsSinceConnect < opts.maxReconnects
    ) {
      dropped.push(r.id);
    }
  }

  return { views, dropped, prune };
}

/** Pick the first dropped agent whose last reconnect attempt is older than the
 *  debounce window, or null when none are due. */
export function pickReconnect(
  dropped: string[],
  stats: Map<string, AgentStat>,
  now: number,
  debounceMs: number,
): string | null {
  for (const id of dropped) {
    const s = stats.get(id);
    if (!s) continue;
    // lastReconnectAt === 0 means we've never attempted one -> always eligible.
    if (s.lastReconnectAt === 0 || now - s.lastReconnectAt >= debounceMs) {
      return id;
    }
  }
  return null;
}
