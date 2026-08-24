/** Human-friendly duration helpers shared across the Agents UI. */

/** Coarse uptime: `1h 4m` / `4m 12s` / `12s`. */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return "—";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** Compact, sub-second-aware duration for the one-shot "time to connect" stat. */
export function fmtConnect(ms: number): string {
  if (ms <= 0) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Very short elapsed label for the activity feed: `3s` / `2m` / `1h`. */
export function fmtAgo(ms: number): string {
  if (ms < 1000) return "now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
