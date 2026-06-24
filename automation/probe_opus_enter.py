#!/usr/bin/env python3
"""Instrument the Opus "Planning next moves" stuck phase in ONE CDP session
(no connection contention). Types a prompt into a target tile, performs ONE
submit action (default: a direct submit-button click), then samples the tile's
underlying DOM/state every ~250ms and logs every transition — to learn what
unsticks Opus without the Enter-spam.

Usage:
    python probe_opus_enter.py --tile 1 --action click   --secs 90
    python probe_opus_enter.py --tile 1 --action enter1  --secs 90
    python probe_opus_enter.py --tile 1 --action domclick --secs 90
    python probe_opus_enter.py --tile 1 --action none    --secs 90   # just submit nothing, observe
"""
import argparse
import json
import time

import cdp


def state_expr(idx):
    return (
        "(()=>{const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        f"const t=ts[{idx}];if(!t)return null;"
        "const s=t.querySelector('.ui-prompt-input-submit-button');"
        "const sh=t.querySelector('.ui-collapsible-action.ui-collapsible-shimmer')?.textContent||'';"
        "const ai=[...t.querySelectorAll('[data-message-role=\"ai\"]')];"
        "const last=ai[ai.length-1];const txt=last?(last.innerText||'').trim():'';"
        "return {ss:s?.getAttribute('data-state')||null,sa:s?.getAttribute('aria-label')||null,"
        "sh:sh.replace(/\\s+/g,' ').trim().slice(0,40),"
        "planning:/planning\\s+next\\s+move/i.test(sh),"
        "gen:s?.getAttribute('data-state')==='stop',"
        "ai:ai.length,len:txt.length,tail:txt.slice(-40),"
        "jefr:/(Ran|Running) Check Messages in jefr/i.test(t.innerText||'')};})()"
    )


def editor_center_expr(idx):
    return (
        "(()=>{const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        f"const t=ts[{idx}];if(!t)return null;"
        "const ed=t.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');"
        "if(!ed)return null;const r=ed.getBoundingClientRect();"
        "return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()"
    )


def submit_rect_expr(idx):
    return (
        "(()=>{const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        f"const t=ts[{idx}];if(!t)return null;"
        "const s=t.querySelector('.ui-prompt-input-submit-button');if(!s)return null;"
        "const r=s.getBoundingClientRect();"
        "return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()"
    )


def type_expr(idx, text):
    return (
        "(()=>{const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        f"const t=ts[{idx}];if(!t)return {{ok:false}};"
        "const ed=t.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');"
        "if(!ed)return {ok:false};ed.focus();document.execCommand('selectAll',false,null);"
        f"document.execCommand('insertText',false,{json.dumps(text)});"
        "return {ok:true,txt:(ed.textContent||'').slice(0,40)};})()"
    )


def domclick_expr(idx):
    return (
        "(()=>{const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        f"const t=ts[{idx}];if(!t)return {{ok:false}};"
        "const s=t.querySelector('.ui-prompt-input-submit-button');if(!s)return {ok:false};"
        "s.click();return {ok:true,ss:s.getAttribute('data-state')};})()"
    )


def ev(s, expr):
    resp, _ = s.call("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
    return resp.get("result", {}).get("result", {}).get("value")


def click(s, x, y):
    """Trusted left-click via the SAME session (no extra connection)."""
    s.call("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
    s.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1})
    s.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1})


def enter(s):
    """Single trusted Enter via the SAME session."""
    for kind in ("rawKeyDown", "keyUp"):
        s.call("Input.dispatchKeyEvent", {"type": kind, "key": "Enter", "code": "Enter",
                                          "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tile", type=int, default=1)
    ap.add_argument("--action", default="click", choices=["click", "domclick", "enter1", "none", "rapidclick"])
    ap.add_argument("--click-ms", type=int, default=120, help="in-page rapidclick interval (ms)")
    ap.add_argument("--secs", type=float, default=90.0)
    ap.add_argument("--text", default=None)
    ap.add_argument("--interval", type=float, default=0.25)
    args = ap.parse_args()

    ws_url, page = cdp.find_workbench()
    if not ws_url:
        print("no workbench"); return
    print(f"# page: {page.get('title','')[:40]}  tile={args.tile}  action={args.action}")

    s = cdp.Session(ws_url)
    s.call("Runtime.enable")

    idx = args.tile
    text = args.text or (
        "Call the mcp directly. Do nothing else first, and keep the mcp connection running."
    )

    # baseline
    base = ev(s, state_expr(idx))
    print("baseline:", json.dumps(base))

    # focus (real click into the editor) + type
    ec = ev(s, editor_center_expr(idx))
    if ec:
        click(s, ec["x"], ec["y"]); time.sleep(0.2)
    typed = ev(s, type_expr(idx, text))
    print("typed:", json.dumps(typed))
    time.sleep(0.3)

    # ONE submit action, timestamped
    t0 = time.time()
    action_note = args.action
    if args.action == "click":
        rect = ev(s, submit_rect_expr(idx))
        if rect:
            click(s, rect["x"], rect["y"])
            action_note = f"trusted click @ {rect}"
        else:
            action_note = "click: no submit rect"
    elif args.action == "domclick":
        r = ev(s, domclick_expr(idx)); action_note = f"dom .click() -> {r}"
    elif args.action == "enter1":
        enter(s)
        action_note = "single trusted Enter"
    elif args.action == "rapidclick":
        # Install an IN-PAGE loop that clicks the submit button ONLY when it is
        # 'active' (ready to submit), so it re-kicks after each drop but never
        # hits the Stop button mid-generation. Zero CDP round-trips per click.
        install = (
            "(()=>{const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
            f"const t=ts[{idx}];if(!t)return false;window.__rsCount=0;"
            "if(window.__rs)clearInterval(window.__rs);"
            "window.__rs=setInterval(()=>{const b=t.querySelector('.ui-prompt-input-submit-button');"
            "if(b&&b.getAttribute('data-state')==='active'){b.click();window.__rsCount++;}"
            f"}},{args.click_ms});return true;}})()"
        )
        ev(s, install)
        action_note = f"in-page rapidclick loop @ {args.click_ms}ms (active-only)"
    print(f"ACTION @ t0: {action_note}")

    # sample loop — log only transitions + periodic heartbeat
    prev = None
    started_at = None
    deadline = time.time() + args.secs
    last_hb = 0
    while time.time() < deadline:
        st = ev(s, state_expr(idx))
        now = time.time() - t0
        key = None if not st else (st["ss"], st["planning"], st["gen"], st["ai"], st["len"] // 50, st["jefr"])
        if key != prev:
            print(f"  +{now:6.2f}s  {json.dumps(st)}")
            prev = key
            if st and (st["gen"] or st["jefr"] or (st["ai"] > base.get("ai", 0))):
                if started_at is None:
                    started_at = now
        elif time.time() - last_hb > 5:
            print(f"  +{now:6.2f}s  (no change) ss={st and st['ss']} planning={st and st['planning']} jefr={st and st['jefr']}")
            last_hb = time.time()
        if st and st["jefr"]:
            print(f"  >>> CONNECTED (running check_messages) at +{now:.2f}s")
            break
        time.sleep(args.interval)

    # Stop any in-page rapidclick loop and report how many submits it fired.
    clicks = ev(s, "(()=>{const n=window.__rsCount||0;if(window.__rs){clearInterval(window.__rs);window.__rs=null;}return n;})()")
    s.close()
    print(f"\nsummary: action='{args.action}', first-activity at {started_at}s, in-page submits fired={clicks}")


if __name__ == "__main__":
    main()
