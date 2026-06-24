#!/usr/bin/env python3
"""Spawn N Cursor Agent tiles, run the workflow on each, and log how long until
each tile connects to the jefr MCP loop (blocked in check_messages).

Phases:
  1. arm     — for each tile: Ctrl+D split -> Auto -> prompt -> Opus Extra High
               -> type MCP prompt (typed, not submitted yet)
  2. monitor — round-robin HOLD Enter on each pending tile and watch for MCP
               connection (planning/generating signals). Global cap (default 6 min).
  3. log     — summary table + JSON log. TIMEOUT = did NOT connect.

Requires Cursor launched with:
    --remote-debugging-port=9222 --remote-allow-origins=*

Run from anywhere:
    python automation/batch_run.py --tiles 6
"""
import argparse
import json
import os
import time
from datetime import datetime

import cdp
import workflow as wf

HERE = os.path.dirname(os.path.abspath(__file__))


def confirm_cleared(ws, idx, checks=4, gap=0.4):
    """Local confirmation that 'Planning next moves' has truly cleared (not a
    flicker): planning must read false on several consecutive quick polls."""
    for _ in range(checks):
        if wf.response_state(ws, idx).get("planning"):
            return False
        time.sleep(gap)
    return True


def arm_tiles(ws, n, prompt_text, type_text):
    """Create N tiles and arm each up to a TYPED (not yet submitted) Opus prompt.

    We deliberately do NOT submit during arming — otherwise an early tile can
    finish before monitoring even starts. The first Enter burst in monitoring
    submits the draft, so all tiles start their timer together and none
    completes unobserved.
    """
    wf.prepare(ws)
    tiles = []
    for i in range(n):
        print(f"\n=== arm tile {i + 1}/{n} ===")
        idx = wf.split(ws)
        prompt = prompt_text or wf.auto_prompt()
        tt = type_text or wf.mcp_prompt()
        idx, _agent_id = wf.run_phase(ws, prompt, idx, wf.DEFAULT_MODEL)
        wf.type_in_composer(ws, idx, tt)
        tiles.append({
            "n": i + 1, "idx": idx, "prompt": prompt,
            "t0": None, "started": False, "done_at": None, "elapsed": None,
        })
        print(f"tile {i + 1}: idx={idx}, opus prompt typed (submit happens in monitor)")
    return tiles


def monitor_tiles(ws, tiles, cap_secs, hold_burst, clear_streak_needed):
    """Round-robin hold Enter on pending tiles until each clears or the cap hits."""
    start = time.time()
    for t in tiles:
        t["t0"] = start  # all tiles' mcp is submitted in the first cycle below
    streak = {t["idx"]: 0 for t in tiles}
    pending = list(tiles)

    print(f"\n=== monitor: {len(pending)} tiles, cap={cap_secs}s ===")
    while pending and (time.time() - start) < cap_secs:
        for t in list(pending):
            idx = t["idx"]
            # burst-hold Enter on this tile (true hold: one keyDown + autorepeat)
            cdp.hold_key(ws, "Enter", duration=hold_burst, focus_eval=wf.tile_focus_eval(idx))
            st = wf.response_state(ws, idx)
            planning = bool(st.get("planning"))
            generating = bool(st.get("generating"))
            if planning or generating:
                t["started"] = True

            if t["started"] and not planning:
                streak[idx] += 1
            else:
                streak[idx] = 0

            elapsed = time.time() - t["t0"]
            if t["started"] and streak[idx] >= clear_streak_needed and confirm_cleared(ws, idx):
                t["done_at"] = time.time()
                t["elapsed"] = round(time.time() - t["t0"], 1)
                pending.remove(t)
                print(f"  tile {t['n']} (idx {idx}): INVOKED mcp in {t['elapsed']}s")
                continue

            # per-tile cap relative to its own submit time
            if elapsed > cap_secs:
                pending.remove(t)
                print(f"  tile {t['n']} (idx {idx}): TIMEOUT after {round(elapsed,1)}s "
                      f"(started={t['started']}, planning={planning})")

    # anything still pending = global-cap timeout
    for t in pending:
        t["elapsed"] = None
    return tiles


def write_log(tiles, cap_secs):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(HERE, f"batch_log_{ts}.json")
    done = [t for t in tiles if t["elapsed"] is not None]
    timed_out = [t for t in tiles if t["elapsed"] is None]
    record = {
        "timestamp": ts,
        "cap_secs": cap_secs,
        "total": len(tiles),
        "invoked": len(done),
        "timed_out": len(timed_out),
        "tiles": [
            {k: t[k] for k in ("n", "idx", "prompt", "started", "elapsed")}
            for t in tiles
        ],
        "timed_out_tiles": [t["n"] for t in timed_out],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(record, f, indent=2)

    print("\n=== SUMMARY ===")
    print(f"{'tile':>4} {'idx':>4} {'result':>10} {'elapsed_s':>10}  prompt")
    for t in tiles:
        result = "INVOKED" if t["elapsed"] is not None else "TIMEOUT"
        el = f"{t['elapsed']}" if t["elapsed"] is not None else "-"
        print(f"{t['n']:>4} {t['idx']:>4} {result:>10} {el:>10}  {t['prompt']}")
    print(f"\ninvoked={len(done)}/{len(tiles)}  timed_out={len(timed_out)}  "
          f"(cap={cap_secs}s)")
    if timed_out:
        print("did NOT invoke mcp within cap: tiles " +
              ", ".join(str(t["n"]) for t in timed_out))
    print(f"\nlog written: {path}")
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tiles", type=int, default=6, help="number of tiles to spawn")
    ap.add_argument("--cap-secs", type=float, default=360.0, help="safety cap per tile (default 360 = 6 min)")
    ap.add_argument("--prompt", default=None,
                    help="auto-phase prompt (default: a timestamped 'stand by / do nothing' instruction)")
    ap.add_argument("--type-text", default=None,
                    help="Opus follow-up text to type/submit "
                         "(default: an improvised 'directly invoke the mcp' instruction)")
    ap.add_argument("--hold-burst", type=float, default=1.2, help="seconds to hold Enter per tile per cycle")
    ap.add_argument("--clear-streak", type=int, default=2, help="consecutive cleared cycles before confirming done")
    args = ap.parse_args()

    ws = wf.connect()
    wf.snap(ws, "initial")

    tiles = arm_tiles(ws, args.tiles, args.prompt, args.type_text)
    monitor_tiles(ws, tiles, args.cap_secs, args.hold_burst, args.clear_streak)
    write_log(tiles, args.cap_secs)


if __name__ == "__main__":
    main()
