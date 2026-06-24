#!/usr/bin/env python3
"""Validate the launcher's agentId logic against the LIVE Cursor window.

Read-only: reads each tile's fiber agentId, checks the agentId->tile mapping,
and the prompt injection. Does NOT split tiles, type, or press Enter, so the
running connection is never touched.
"""
import sys
import workflow  # noqa: E402  (imports cdp internally)

pass_n = 0
fail_n = 0


def ok(name, cond, extra=""):
    global pass_n, fail_n
    if cond:
        pass_n += 1
    else:
        fail_n += 1
    print(f"{'PASS' if cond else 'FAIL'}  {name}{('  — ' + extra) if extra else ''}")


def main():
    ws = workflow.connect()
    n = workflow.tile_count(ws)
    ok("at least one tile present", n >= 1, f"{n} tiles")

    ids = [workflow.read_agent_id(ws, i) for i in range(n)]
    print("agentIds:", ids)
    ok("every tile exposes an agentId", all(isinstance(x, str) and len(x) >= 8 for x in ids))
    ok("agentIds are distinct", len(set(ids)) == len(ids))

    # agentId -> tile mapping must be exact and stable
    map_ok = True
    for i, aid in enumerate(ids):
        found = workflow.find_tile_by_agent(ws, aid)
        if found != i:
            map_ok = False
            print(f"  mismatch: agent {aid} expected tile {i}, got {found}")
    ok("find_tile_by_agent maps each agentId to its own tile", map_ok)

    ok("unknown agentId -> None", workflow.find_tile_by_agent(ws, "does-not-exist") is None)

    # injection must embed the real id and the agent_id directive
    injected = workflow.inject_agent_id("INVOKE THE MCP", ids[0])
    ok("inject embeds the agentId", ids[0] in injected)
    ok("inject tells the agent to pass agent_id", f"agent_id:'{ids[0]}'" in injected)
    ok("inject preserves the base prompt", injected.startswith("INVOKE THE MCP"))
    ok("inject is a no-op for empty id", workflow.inject_agent_id("X", None) == "X")

    print(f"\n{'ALL PASS' if fail_n == 0 else 'FAILURES'}: {pass_n} passed, {fail_n} failed")
    sys.exit(0 if fail_n == 0 else 1)


if __name__ == "__main__":
    main()
