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
    connected: false,
    connectedSince: 0,
    lastSeen: 0,
    lastReconnectAt: 0,
  };
}

/**
 * Fold the current roster into the persistent stats map (mutating it), and
 * return the panel views plus the ids of agents that have DROPPED (were
 * connected at least once and are now down) and therefore may need reconnecting.
 */
export function reconcile(
  roster: RosterEntry[],
  stats: Map<string, AgentStat>,
  now: number,
): { views: AgentView[]; dropped: string[] } {
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
      }
      s.lastSeen = now;
    } else if (s.connected) {
      s.connected = false;
      s.connectedSince = 0;
    }
  }

  const dropped = roster
    .filter((r) => !r.connected && (stats.get(r.id)?.connectCount ?? 0) > 0)
    .map((r) => r.id);

  const views: AgentView[] = roster.map((r) => {
    const s = stats.get(r.id)!;
    return {
      id: r.id,
      connected: r.connected,
      state: r.state,
      queueCount: r.queueCount,
      connectCount: s.connectCount,
      reconnectCount: s.reconnectCount,
      connectedSince: r.connected ? s.connectedSince : 0,
    };
  });

  return { views, dropped };
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
