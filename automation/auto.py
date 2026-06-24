#!/usr/bin/env python3
"""One-shot: split a Cursor Agents tile to the right, set the new tile's model to
Auto, send a prompt, let it run, then stop it.

Requires Cursor launched with --remote-debugging-port=9222 --remote-allow-origins=*

Usage:
    python auto.py                 # prompt "123", run 5s before stopping
    python auto.py "do the thing"  # custom prompt
    python auto.py "hello" 8       # custom prompt, run 8s before stopping

The split uses a TRUSTED Ctrl+D (only way to fire Cursor's native split keybind);
everything else is plain DOM, driven over CDP.
"""
import os, sys, time
import cdp

HERE = os.path.dirname(os.path.abspath(__file__))


def jval(res):
    return res.get("result", {}).get("value")


def main():
    prompt = sys.argv[1] if len(sys.argv) > 1 else "123"
    run_s = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0

    ws, t = cdp.find_workbench()
    if not ws:
        print("ERROR: no workbench page (is Cursor up with the debug port?)"); sys.exit(3)
    print(f"# page: {t.get('title','')[:60]}")

    count_js = "document.querySelectorAll('.glass-agent-conversation-tiling__tile').length"
    res, _ = cdp.evaluate(ws, count_js, await_promise=False, want_console=False)
    before = jval(res) or 0

    # 1) trusted Ctrl+D split — focus the active/last tile's composer first
    cdp.send_chord(ws, "Control+d", focus_eval=(
        "(()=>{const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        "const t=ts.at(-1);"
        "const ed=t?.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input')"
        "||document.querySelector('.tiptap.ProseMirror.ui-prompt-input-editor__input');"
        "ed&&ed.focus();return {focused:!!ed,tiles:ts.length};})()"
    ))

    # 2) wait for the new tile to mount
    after = before
    for _ in range(40):
        time.sleep(0.15)
        res, _ = cdp.evaluate(ws, count_js, await_promise=False, want_console=False)
        after = jval(res) or 0
        if after > before:
            break
    print(f"split: {after > before}  (tiles {before} -> {after})")

    # 3) model -> Auto, type, send, run, stop  (single awaited evaluate)
    with open(os.path.join(HERE, "run_after_split.js"), "r", encoding="utf-8") as f:
        js = cdp.js_bundle("tile_status.js", "run_after_split.js")
        js = js.replace("__RUNMS__", str(int(run_s * 1000))).replace("__PROMPT__", prompt)
    res, console = cdp.evaluate(ws, js, await_promise=True, want_console=False)
    print("RESULT", cdp._render(res.get("result", {})))
    exc = res.get("exceptionDetails")
    if exc:
        import json
        print("EXCEPTION", json.dumps(exc.get("exception", exc))[:1000])


if __name__ == "__main__":
    main()
