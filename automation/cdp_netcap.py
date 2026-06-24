#!/usr/bin/env python3
"""Capture what the Cursor workbench does at the NETWORK / underlying layer via
CDP, while agents run. Enables the CDP Network domain on the workbench page and
summarizes HTTP requests (by host/type/status) and WebSocket activity.

Privacy: only URLs (host + path, query stripped), methods, statuses, mime/proto,
and WebSocket frame COUNTS/SIZES are recorded — never headers or payload bodies.

Usage:
    python cdp_netcap.py [--secs 20] [--all]
"""
import argparse
import collections
import json
import time
from urllib.parse import urlparse

import websocket  # pip install websocket-client

import cdp


def strip(url):
    try:
        u = urlparse(url)
        if not u.scheme:
            return url[:80]
        path = u.path if len(u.path) <= 60 else u.path[:60] + "…"
        return f"{u.scheme}://{u.netloc}{path}"
    except Exception:
        return url[:80]


def host_of(url):
    try:
        return urlparse(url).netloc or "(relative)"
    except Exception:
        return "?"


def capture(ws_url, secs):
    ws = websocket.create_connection(ws_url, timeout=5, suppress_origin=True, max_size=None)
    mid = [0]

    def send(method, params=None):
        mid[0] += 1
        ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))

    send("Network.enable")

    reqs = {}                       # requestId -> {url, method, type}
    by_host = collections.Counter()
    by_type = collections.Counter()
    statuses = collections.Counter()
    endpoints = collections.Counter()
    protocols = collections.Counter()
    ws_conns = {}                   # requestId -> url
    ws_frames = collections.Counter()   # url -> frames
    ws_bytes = collections.Counter()    # url -> bytes
    errors = []

    deadline = time.time() + secs
    ws.settimeout(1.0)
    while time.time() < deadline:
        try:
            msg = json.loads(ws.recv())
        except websocket.WebSocketTimeoutException:
            continue
        except Exception:
            break
        m = msg.get("method")
        p = msg.get("params", {})
        if m == "Network.requestWillBeSent":
            r = p.get("request", {})
            url = r.get("url", "")
            reqs[p.get("requestId")] = {"url": url, "method": r.get("method"), "type": p.get("type")}
            by_host[host_of(url)] += 1
            by_type[p.get("type") or "?"] += 1
            endpoints[f'{r.get("method")} {strip(url)}'] += 1
        elif m == "Network.responseReceived":
            resp = p.get("response", {})
            statuses[resp.get("status")] += 1
            protocols[resp.get("protocol") or "?"] += 1
        elif m == "Network.loadingFailed":
            rid = p.get("requestId")
            errors.append((reqs.get(rid, {}).get("url", "?"), p.get("errorText")))
        elif m == "Network.webSocketCreated":
            ws_conns[p.get("requestId")] = p.get("url")
        elif m in ("Network.webSocketFrameSent", "Network.webSocketFrameReceived"):
            url = ws_conns.get(p.get("requestId"), "?")
            ws_frames[url] += 1
            ws_bytes[url] += len((p.get("response", {}) or {}).get("payloadData", "") or "")
    ws.close()

    return {
        "by_host": by_host, "by_type": by_type, "statuses": statuses,
        "protocols": protocols, "endpoints": endpoints,
        "ws_conns": ws_conns, "ws_frames": ws_frames, "ws_bytes": ws_bytes,
        "errors": errors, "total_requests": sum(by_host.values()),
    }


def report(title, r):
    print(f"\n===== {title} =====")
    print(f"total HTTP requests: {r['total_requests']}")
    print("by host:", dict(r["by_host"].most_common(12)))
    print("by type:", dict(r["by_type"]))
    print("statuses:", dict(r["statuses"]))
    print("protocols:", dict(r["protocols"]))
    print("top endpoints:")
    for ep, n in r["endpoints"].most_common(15):
        print(f"  {n:4d}  {ep}")
    if r["ws_conns"]:
        print("websockets:")
        for rid, url in r["ws_conns"].items():
            print(f"  {strip(url)}  frames={r['ws_frames'].get(url,0)} bytes~={r['ws_bytes'].get(url,0)}")
    else:
        print("websockets: none observed")
    if r["errors"]:
        print("failures:")
        for url, err in r["errors"][:8]:
            print(f"  {err}  {strip(url)}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=20.0)
    ap.add_argument("--all", action="store_true", help="capture every workbench page")
    args = ap.parse_args()

    if args.all:
        targets = cdp.all_workbench()
        if not targets:
            print("no workbench pages"); return
        for t in targets:
            print(f"# capturing {t.get('title','')[:40]} for {args.secs}s …")
            report(t.get("title", "")[:40], capture(t["webSocketDebuggerUrl"], args.secs))
        return

    ws_url, t = cdp.find_workbench()
    if not ws_url:
        print("no workbench page"); return
    print(f"# capturing '{t.get('title','')[:40]}' network for {args.secs}s …")
    report("workbench", capture(ws_url, args.secs))


if __name__ == "__main__":
    main()
