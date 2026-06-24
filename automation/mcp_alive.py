#!/usr/bin/env python3
"""MCP-connection detector — root or per-agent heartbeat.

Reads the heartbeat the jefr MCP server writes every ~2.5s:
  ~/.moyu-message/agent-alive.json                     (legacy root)
  ~/.moyu-message/agents/<agent_id>/agent-alive.json   (multi-agent)

Ground truth from the server process:
  fresh + pid alive => MCP loop is LIVE
  state "waiting"   => blocked in check_messages
  state "working"   => mid-task (send_progress / active turn)
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time

DATA_DIR = os.environ.get("MESSENGER_DATA_DIR") or os.path.join(
    os.path.expanduser("~"), ".moyu-message"
)
STALE_MS = int(os.environ.get("MCP_STALE_MS", "8000"))


def sanitize_agent_id(agent_id: str | None) -> str:
    if not agent_id or not isinstance(agent_id, str):
        return ""
    return re.sub(r"[^A-Za-z0-9._-]", "", agent_id.strip())[:64]


def heartbeat_path(agent_id: str | None = None) -> str:
    aid = sanitize_agent_id(agent_id)
    if aid:
        return os.path.join(DATA_DIR, "agents", aid, "agent-alive.json")
    return os.path.join(DATA_DIR, "agent-alive.json")


def pid_alive(pid: int) -> bool:
    if not pid:
        return False
    try:
        if os.name == "nt":
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                capture_output=True,
                text=True,
                timeout=5,
            )
            return str(pid) in out.stdout
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def check(agent_id: str | None = None, stale_ms: int = STALE_MS) -> dict:
    """Return liveness info for the root or a per-agent heartbeat file."""
    path = heartbeat_path(agent_id)
    try:
        with open(path, "r", encoding="utf-8") as f:
            hb = json.load(f)
    except FileNotFoundError:
        return {
            "alive": False,
            "reason": "no heartbeat file",
            "path": path,
            "agent_id": sanitize_agent_id(agent_id) or None,
        }
    except Exception as e:
        return {
            "alive": False,
            "reason": f"unreadable: {e}",
            "path": path,
            "agent_id": sanitize_agent_id(agent_id) or None,
        }

    now = int(time.time() * 1000)
    age = now - int(hb.get("ts", 0))
    pid = int(hb.get("pid", 0))
    state = hb.get("state")
    proc_up = pid_alive(pid)
    fresh = age <= stale_ms
    alive = fresh and proc_up

    return {
        "alive": alive,
        "state": state,
        "age_ms": age,
        "fresh": fresh,
        "pid": pid,
        "pid_alive": proc_up,
        "path": path,
        "agent_id": sanitize_agent_id(agent_id) or hb.get("agentId"),
        "verdict": ("LIVE (" + str(state) + ")") if alive
        else ("PROCESS GONE" if not proc_up else "STALE / cut out"),
    }


def is_connected(agent_id: str | None = None, stale_ms: int = STALE_MS) -> bool:
    """True when the agent's MCP loop heartbeat is fresh."""
    return bool(check(agent_id, stale_ms=stale_ms).get("alive"))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--agent-id",
        dest="agent_id",
        default=None,
        help="Per-agent id (Cursor agentId). Omit for legacy root heartbeat.",
    )
    ap.add_argument(
        "--stale-ms",
        type=int,
        default=STALE_MS,
        help=f"Max heartbeat age in ms (default {STALE_MS})",
    )
    args = ap.parse_args()
    info = check(args.agent_id, stale_ms=args.stale_ms)
    print(json.dumps(info))
    return 0 if info.get("alive") else 2


if __name__ == "__main__":
    sys.exit(main())
