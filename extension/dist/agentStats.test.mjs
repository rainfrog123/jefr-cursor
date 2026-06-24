// src/agentStats.ts
function newStat() {
  return {
    connectCount: 0,
    reconnectCount: 0,
    reconnectsSinceConnect: 0,
    connected: false,
    connectedSince: 0,
    lastSeen: 0,
    lastReconnectAt: 0
  };
}
function reconcile(roster, stats, now, opts) {
  const views = [];
  const dropped = [];
  const prune = [];
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
        s.reconnectsSinceConnect = 0;
      }
      s.lastSeen = now;
    } else if (s.connected) {
      s.connected = false;
      s.connectedSince = 0;
    }
    const lastAlive = r.ts > 0 ? Math.max(r.ts, s.lastSeen) : s.lastSeen;
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
      connectedSince: r.connected ? s.connectedSince : 0
    });
    if (!r.connected && s.connectCount > 0 && s.reconnectsSinceConnect < opts.maxReconnects) {
      dropped.push(r.id);
    }
  }
  return { views, dropped, prune };
}
function pickReconnect(dropped, stats, now, debounceMs) {
  for (const id of dropped) {
    const s = stats.get(id);
    if (!s)
      continue;
    if (s.lastReconnectAt === 0 || now - s.lastReconnectAt >= debounceMs) {
      return id;
    }
  }
  return null;
}
export {
  newStat,
  pickReconnect,
  reconcile
};
