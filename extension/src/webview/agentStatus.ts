/**
 * Shared status model for agents, used by both the Agents tab tiles and the
 * agent detail header so they always display the same set of states.
 *
 *   connecting      — a workflow is actively spawning / re-priming THIS tile
 *   mcp_connected   — parked in the MCP loop (held-open check_messages / waiting)
 *   working         — alive but busy: generating a reply or planning. Shown as a
 *                     distinct LABEL, but it still counts as connected (see note)
 *                     so the agent count doesn't drop to 0 while it's working.
 *   cutoff          — it WAS connected, then the loop was cut off cleanly (turn
 *                     ended — a "Worked for…" stamp is present — without the user
 *                     ending it): the accidental turn cut-out. Re-primeable.
 *   server_dropped  — it WAS connected, then the loop died ABRUPTLY with no clean
 *                     "Worked for…" stamp: an errored check_messages card, or
 *                     messages stranded in the queue. The true "server dropped"
 *                     case — without this it would masquerade as plain "down".
 *                     Re-primeable in place so the stranded queue drains.
 *   down            — never connected (fresh / closed tile), nothing in progress
 *
 * IMPORTANT: `working` is only a display distinction. The connected COUNT is
 * driven by the agent's `connected` flag (any live state), NOT by this status —
 * so a busy agent stays counted (badge stays 1) even while it shows "Working".
 *
 * Precedence: connecting > mcp_connected > working > cutoff > server_dropped > down.
 */
export type LiveState =
  | "waiting"
  | "working"
  | "idle"
  | "mcp_connected"
  | "generating"
  | "planning";

export type AgentStatus =
  | "down"
  | "connecting"
  | "mcp_connected"
  | "working"
  | "cutoff"
  | "server_dropped";

export function agentStatus(
  state: LiveState,
  connecting: boolean,
  dropped = false,
  serverDropped = false,
): AgentStatus {
  if (connecting) return "connecting";
  if (state === "mcp_connected" || state === "waiting") return "mcp_connected";
  if (state === "generating" || state === "planning" || state === "working") {
    return "working";
  }
  if (dropped) return "cutoff";
  if (serverDropped) return "server_dropped";
  return "down";
}

export function stateLabel(status: AgentStatus): string {
  switch (status) {
    case "mcp_connected":
      return "MCP connected";
    case "connecting":
      return "Connecting…";
    case "working":
      return "Working";
    case "cutoff":
      return "Dropped";
    case "server_dropped":
      return "Server dropped";
    default:
      return "Down";
  }
}

export function stateClass(status: AgentStatus): string {
  switch (status) {
    case "mcp_connected":
      return "on mcp";
    case "connecting":
      return "connecting";
    case "working":
      return "on working";
    case "cutoff":
      return "cutoff";
    case "server_dropped":
      return "server-dropped";
    default:
      return "off";
  }
}
