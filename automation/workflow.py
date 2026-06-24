#!/usr/bin/env python3
"""End-to-end Cursor Agents automation over CDP, with a snapshot at each step.

Stages:
  1. connect   — find the Cursor workbench page over CDP
  2. prepare   — best-effort collapse of extra tiles back to the base tile
  3. split     — ALWAYS a fresh trusted Ctrl+D split; the new tile index is
                 detected dynamically (it mounts at the end of the tile list)
  4. phase     — on the new tile: Auto -> send a "do nothing" prompt -> wait ->
                 select the target model (default Opus 4.8 1M Extra High Fast)
  5. type      — type the MCP prompt (default: an improvised "directly invoke
                 the mcp, don't do anything else first, keep the connection" instruction)
                 into the Send follow-up composer
  6. hold      — focus the composer, HOLD Enter: first until planning clears
                 (120s cap — submit the prompt), then until MCP connected
                 (--max-secs, default 6000s; Enter released on connect)

Requires Cursor launched with:
    --remote-debugging-port=9222 --remote-allow-origins=*

Runs from any working directory (paths are resolved relative to this file):
    python automation/workflow.py
"""
import argparse
import json
import random
import sys
import time

import cdp
import mcp_alive

DEFAULT_MODEL = "Opus 4.8 1M Extra High Fast"

# Enter-hold caps per phase (--max-secs applies to the MCP wait, not planning).
PLANNING_HOLD_CAP = 120.0
MCP_HOLD_DEFAULT = 6000.0


def _planning_hold_secs(_max_secs):
    """Phase 1: spam Enter until planning clears (short cap — just need submit)."""
    return PLANNING_HOLD_CAP


def _mcp_hold_secs(max_secs):
    """Phase 2: hold Enter until MCP loop confirmed (long cap — wait for check_messages)."""
    if max_secs == 0:
        return None
    return max_secs if max_secs else MCP_HOLD_DEFAULT


# Auto phase only exists to spin up the tile before we switch to the target
# model, so we don't want Auto to actually start working — just stand by. Each prompt leads
# with a timestamp (added in auto_prompt()) and then a strongly-emphasized
# standby instruction. Lightly varied so each run looks a little different.
AUTO_PROMPTS = [
    "STAND BY. Do NOT do anything yet — don't read, edit, run, or plan anything. Just wait for my next instruction.",
    "STAND BY and do NOTHING. Don't read files, don't run commands, don't make changes. Wait silently for my next message.",
    "IMPORTANT: STAND BY. Take NO action of any kind right now. Just hold and wait for my next instruction.",
    "Just STAND BY. Don't do anything at all — no actions, no analysis. Wait for what I send next.",
]

# MCP phase prompt: kick the MCP connection immediately and keep it open,
# without doing anything else first. Improvised phrasings, same intent.
MCP_PROMPTS = [
    "Directly invoke the mcp. Don't do anything else first, and keep the mcp connection open.",
    "Invoke the mcp right away — don't do anything else beforehand, and keep the mcp connection alive.",
    "Call the mcp directly. Do nothing else first, and keep the mcp connection running.",
    "Start by invoking the mcp directly. Don't do anything else first, and hold the mcp connection open.",
]


def js_bundle(*names, **subs):
    js = cdp.js_bundle("layout.js", "tile_status.js", "tile_helpers.js", *names)
    for key, val in subs.items():
        js = js.replace(key, str(val))
    return js


def eval_js(ws, js, await_promise=True):
    res, _ = cdp.evaluate(ws, js, await_promise=await_promise, want_console=False)
    exc = res.get("exceptionDetails")
    if exc:
        print("EXCEPTION", json.dumps(exc.get("exception", exc))[:600])
    return res.get("result", {}).get("value")


def snap(ws, label):
    s = eval_js(ws, js_bundle() + "\n; snapshot();", False)
    print(f"CDP [{label}]:", json.dumps(s, indent=2)[:1200])
    return s


def auto_prompt():
    """Initial Auto prompt: a leading timestamp, then a strong standby instruction."""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    return f"[{ts}] {random.choice(AUTO_PROMPTS)}"


def mcp_prompt():
    """Improvised MCP prompt: invoke the mcp directly and keep it connected."""
    return random.choice(MCP_PROMPTS)


def mcp_prompt_with_id(base, agent_id):
    """Append a one-line identity instruction so the agent routes to its own
    per-agent queue. A single shared MCP server process serves every tile, so it
    cannot tell callers apart — the agent must pass agent_id on every jefr call.
    The systemSuffix the server appends to each delivered message then echoes the
    id back, so this only ever has to be injected ONCE (here, at spawn)."""
    if not agent_id:
        return base
    return (
        f"{base} You are jefr agent {agent_id}; pass agent_id:'{agent_id}' on every "
        "jefr MCP call (check_messages / ask_question / send_progress)."
    )


def agent_rows(ws):
    """List tiles with their stable agentId (read from the React fiber)."""
    res = eval_js(ws, cdp.js_bundle("agent_map.js"), await_promise=False)
    return res.get("rows", []) if isinstance(res, dict) else []


def agent_id_for(ws, idx):
    """The real Cursor agentId for tile `idx`, or None."""
    for r in agent_rows(ws):
        if r.get("i") == idx:
            return r.get("agentId")
    return None


def focus_agent(ws, agent_id):
    """Focus the tile whose fiber agentId matches `agent_id`; return its tile
    index, or None if no tile carries that id."""
    js = cdp.js_bundle("agent_map.js").replace("__AGENT__", agent_id)
    res = eval_js(ws, js, await_promise=False)
    if isinstance(res, dict) and res.get("ok") and isinstance(res.get("focused"), int):
        return res["focused"]
    return None


def tile_focus_eval(idx):
    """JS that focuses the LIVE 'Send follow-up' composer inside tile `idx`.

    Ignores inline edit boxes (.prompt-edit-input); prefers the follow-up input,
    falling back to the last real composer. Negatives count from the end.
    """
    return (
        "(()=>{"
        "const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        f"const root=ts.length?ts.at({idx}):document;"
        "if(!root)return false;"
        "const eds=[...root.querySelectorAll('.tiptap.ProseMirror.ui-prompt-input-editor__input')]"
        ".filter(e=>!e.closest('.prompt-edit-input'));"
        "const isFu=e=>e.closest('.agent-panel-followup-input')||/send follow-?up/i.test("
        "(e.querySelector('[data-placeholder]')?.getAttribute('data-placeholder'))"
        "||e.getAttribute('data-placeholder')||'');"
        "const ed=eds.find(isFu)||eds[eds.length-1];"
        "if(!ed)return false;ed.focus();return true;})()"
    )


def agent_focus_eval(agent_id):
    """Self-contained JS that focuses the LIVE follow-up composer of the tile
    whose React-fiber agentId matches `agent_id` (falls back to the last tile).
    Used as hold_key's focus_eval so the 10-min Enter hold can't drift to another
    tile if indices shift."""
    return (
        "(()=>{"
        f"const ID={json.dumps(agent_id)};"
        "const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        "const fid=(n)=>{const k=Object.keys(n).find(x=>x.startsWith('__reactFiber$')||x.startsWith('__reactInternalInstance$'));"
        "let f=k?n[k]:null,s=0;while(f&&s++<40){const p=f.memoizedProps;if(p&&typeof p.agentId==='string')return p.agentId;f=f.return;}return null;};"
        "const t=ts.find(x=>fid(x)===ID)||ts[ts.length-1];if(!t)return false;"
        "const eds=[...t.querySelectorAll('.tiptap.ProseMirror.ui-prompt-input-editor__input')].filter(e=>!e.closest('.prompt-edit-input'));"
        "const isFu=e=>e.closest('.agent-panel-followup-input')||/send follow-?up/i.test("
        "(e.querySelector('[data-placeholder]')?.getAttribute('data-placeholder'))||e.getAttribute('data-placeholder')||'');"
        "const ed=eds.find(isFu)||eds[eds.length-1];if(!ed)return false;ed.focus();return true;})()"
    )


# Shared JS: given an element `t`, set `const connected` to true iff a jefr
# check_messages tool call is *currently running* in that tile. We look for a
# tool message ([data-message-kind="tool"]) that names "check messages … jefr"
# AND still carries a running indicator (data-tool-status loading/running, the
# "--with-stop" card, or a spinner/shimmer). Completed "Ran Check Messages"
# cards in scrollback are ignored — and crucially the spawn prompt text (which
# literally contains "check_messages") lives in a USER bubble, not a tool card,
# so it can no longer cause a premature false "connected".
_MCP_RUNNING_JS = (
    "const tc=[...t.querySelectorAll('[data-message-kind=\"tool\"]')];"
    "const connected=tc.some(m=>{const x=m.textContent||'';"
    "if(!/check\\s*messages/i.test(x)||!/jefr/i.test(x))return false;"
    "const st=(m.getAttribute('data-tool-status')||'').toLowerCase();"
    "const cl=typeof m.className==='string'?m.className:'';"
    "return /run|load|pend|progress|stream|active/.test(st)||/with-stop/.test(cl)"
    "||!!m.querySelector('[class*=\"shimmer\"],[class*=\"spinner\"],.codicon-modifier-spin,[class*=\"with-stop\"]');});"
)


def mcp_connected_stop_eval_by_agent(agent_id, streak_needed=12):
    """JS: truthy once THIS agent's tile is blocked in the jefr MCP loop — a
    Check Messages in jefr tool call is *currently running*. Debounced with a
    streak counter."""
    return (
        "(()=>{"
        f"const ID={json.dumps(agent_id)},need={streak_needed};"
        "const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        "const fid=(n)=>{const k=Object.keys(n).find(x=>x.startsWith('__reactFiber$')||x.startsWith('__reactInternalInstance$'));"
        "let f=k?n[k]:null,s=0;while(f&&s++<40){const p=f.memoizedProps;if(p&&typeof p.agentId==='string')return p.agentId;f=f.return;}return null;};"
        "const t=ts.find(x=>fid(x)===ID);"
        "if(!t){window.__wfMcpStreak=0;return false;}"
        + _MCP_RUNNING_JS +
        "if(connected){window.__wfMcpStreak=(window.__wfMcpStreak||0)+1;}"
        "else{window.__wfMcpStreak=0;}"
        "return window.__wfMcpStreak>=need;})()"
    )


def mcp_connected_stop_eval(idx, streak_needed=12):
    """Tile-index version of mcp_connected_stop_eval_by_agent (self-contained)."""
    return (
        "(()=>{const idx=" + str(idx) + ",need=" + str(streak_needed) + ";"
        "const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        "const t=ts.length?ts.at(idx<0?ts.length+idx:idx):document;"
        "if(!t){window.__wfMcpStreak=0;return false;}"
        + _MCP_RUNNING_JS +
        "if(connected){window.__wfMcpStreak=(window.__wfMcpStreak||0)+1;}"
        "else{window.__wfMcpStreak=0;}"
        "return window.__wfMcpStreak>=need;})()"
    )


def agent_id_reminder(agent_id):
    """One-line nudge when the tile connected but skipped per-agent routing."""
    return (
        f"Pass agent_id:'{agent_id}' on every jefr MCP call "
        "(check_messages / send_progress / ask_question)."
    )


def verify_per_agent_heartbeat(agent_id, timeout=45.0):
    """Poll until agents/<id>/agent-alive.json is fresh, or timeout."""
    if not agent_id:
        return mcp_alive.is_connected(None)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if mcp_alive.is_connected(agent_id):
            info = mcp_alive.check(agent_id)
            print(f"mcp heartbeat: {json.dumps(info)}")
            return True
        time.sleep(0.4)
    info = mcp_alive.check(agent_id)
    print(f"mcp heartbeat timeout: {json.dumps(info)}")
    return False


def response_stop_eval_by_agent(agent_id, clear_polls=35, min_planning_polls=5):
    """Self-contained agentId-pinned version of response_stop_eval: truthy once
    'Planning next moves' has appeared (min streak) and then stayed cleared on
    THIS agent's tile for `clear_polls` consecutive polls."""
    return (
        "(()=>{"
        f"const ID={json.dumps(agent_id)},need={clear_polls},minPlan={min_planning_polls};"
        "const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        "const fid=(n)=>{const k=Object.keys(n).find(x=>x.startsWith('__reactFiber$')||x.startsWith('__reactInternalInstance$'));"
        "let f=k?n[k]:null,s=0;while(f&&s++<40){const p=f.memoizedProps;if(p&&typeof p.agentId==='string')return p.agentId;f=f.return;}return null;};"
        "const t=ts.find(x=>fid(x)===ID);"
        "const sh=(t||document).querySelector('.ui-collapsible-action.ui-collapsible-shimmer')?.textContent||'';"
        "const planning=/planning\\s+next\\s+move/i.test(sh);"
        "if(planning){window.__wfPlanned=true;window.__wfPlanStreak=(window.__wfPlanStreak||0)+1;window.__wfClear=0;}"
        "else{window.__wfPlanStreak=0;"
        "if(window.__wfPlanned&&(window.__wfPlanPeak||0)>=minPlan){window.__wfClear=(window.__wfClear||0)+1;}}"
        "window.__wfPlanPeak=Math.max(window.__wfPlanPeak||0,window.__wfPlanStreak||0);"
        "return !!window.__wfPlanned&&!planning&&(window.__wfPlanPeak>=minPlan)&&(window.__wfClear>=need);})()"
    )


def fail(message, payload=None):
    print(f"ERROR: {message}")
    if payload and payload.get("log"):
        for line in payload["log"][-6:]:
            print(" ", line)
    sys.exit(1)


def detect_dropped_tile(ws):
    """Return the index of a tile whose MCP loop has dropped, or None.

    A dropped ("worked") tile is idle: NOT generating (no stop-state submit
    button), NOT showing the "Planning next moves" shimmer, and carrying a
    "Worked for ..." completion stamp in its conversation tail. That is the
    signature of a turn that ended — i.e. the perpetual check_messages loop
    fell out. Prefers an Opus tile if several qualify.
    """
    js = (
        "(()=>{"
        "const tiles=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        "const out=tiles.map((t,i)=>{"
        "const submit=t.querySelector('.ui-prompt-input-submit-button');"
        "const generating=submit?.getAttribute('data-state')==='stop';"
        "const sh=t.querySelector('.ui-collapsible-action.ui-collapsible-shimmer')?.textContent||'';"
        "const planning=/planning\\s+next\\s+move/i.test(sh);"
        "const tail=(t.innerText||'').replace(/\\s+/g,' ').trim().slice(-400);"
        "const worked=/worked for\\s+[\\dhms ]+/i.test(tail);"
        "const model=t.querySelector('.ui-model-picker__trigger-text')?.textContent?.trim()||'';"
        "return {i,generating,planning,worked,model,dropped:(!generating&&!planning&&worked)};"
        "});"
        "return out;})()"
    )
    rows = eval_js(ws, js, await_promise=False) or []
    print("detect:", json.dumps(rows))
    dropped = [r for r in rows if r.get("dropped")]
    if not dropped:
        return None
    gpt = [r for r in dropped if "gpt" in (r.get("model") or "").lower()]
    chosen = (gpt or dropped)[0]
    return chosen.get("i")


def reconnect(ws, idx, type_text, interval, max_secs, agent_id=None):
    """Re-prime an EXISTING dropped tile in place (no Ctrl+D split).

    Types the invoke-mcp prompt into the tile's live follow-up composer and holds
    Enter until the jefr MCP loop is confirmed connected."""
    print(f"reconnect: targeting tile {idx}")
    type_in_composer(ws, idx, type_text)
    return enter_until_response(ws, idx, interval, max_secs, agent_id=agent_id)


def connect():
    ws, page = cdp.find_workbench()
    if not ws:
        print("ERROR: no CDP workbench"); sys.exit(3)
    print(f"# page: {page.get('title', '')[:60]}")
    return ws


def tile_count(ws):
    return eval_js(
        ws, "document.querySelectorAll('.glass-agent-conversation-tiling__tile').length",
        await_promise=False,
    ) or 0


def prepare(ws):
    """Best-effort collapse of extra tiles back to the base tile (non-fatal)."""
    prep = eval_js(ws, js_bundle("prepare_one_tile.js"))
    print("prepare:", json.dumps(prep, indent=2)[:800])
    if not prep or prep.get("error"):
        print("WARN: prepare/collapse did not fully succeed — continuing (Ctrl+D will add a new tile)")
    return prep


def split(ws):
    """Always start with a fresh trusted Ctrl+D split; return the NEW tile's index.

    The new tile mounts at the end of the tile list, so its index is the last one.
    We detect it dynamically rather than assuming index 1, which keeps the workflow
    robust no matter how many tiles already exist.
    """
    before = tile_count(ws)
    print(f"split: Ctrl+D to open a new tile (tiles before={before})")
    cdp.send_chord(ws, "Control+d", focus_eval=tile_focus_eval(-1))

    new_idx = max(0, before)  # fallback if count never grows (single-pane -> tile 1)
    for _ in range(40):
        time.sleep(0.15)
        count = tile_count(ws)
        if count > before:
            new_idx = count - 1
            break
    snap(ws, "after-split")
    print(f"split: new tile index = {new_idx} (tiles now={tile_count(ws)})")
    return new_idx


def run_phase(ws, prompt, idx, model_pattern):
    """On the NEW tile `idx`: select Auto, type+send prompt, wait, then switch to
    the target model (addressed by the tile's agentId). Returns (idx, agent_id)
    where idx is re-resolved from the agentId and agent_id is read from the page."""
    phase = eval_js(ws, js_bundle("workflow.js", __TARGET__=idx, __PROMPT__=json.dumps(prompt), __MODEL__=json.dumps(model_pattern)))
    summary = {k: phase.get(k) for k in phase if k not in ("log", "snapshot")} if phase else phase
    print("phase:", json.dumps(summary, indent=2))
    snap(ws, "after-phase")

    if phase and not phase.get("error"):
        return phase.get("idx", idx), phase.get("agentId")

    soft_fails = {"model not found", "no ai response on NEW tile"}
    if phase and phase.get("error") in soft_fails:
        print(f"WARN: {phase['error']} — continuing Enter spam with current model")
        return phase.get("idx", idx), phase.get("agentId")

    fail("phase failed", phase)


def editor_center(ws, idx):
    """Viewport center of tile `idx`'s LIVE follow-up composer, or None."""
    js = js_bundle() + (
        f"\n;(()=>{{const ed=editorIn({idx});if(!ed)return null;"
        "const r=ed.getBoundingClientRect();"
        "return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()"
    )
    return eval_js(ws, js, await_promise=False)


def menu_open(ws):
    """True if any popover menu/option (e.g. the model picker) is visible."""
    return bool(eval_js(
        ws,
        "[...document.querySelectorAll('[role=\"option\"],[role^=\"menuitem\"]')]"
        ".some(e=>e.offsetParent)",
        await_promise=False,
    ))


def real_focus(ws, idx):
    """Mimic a real click into the tile's text area (closes open popovers)."""
    pt = editor_center(ws, idx)
    if not pt:
        print("WARN: editor not found for real click — falling back to focus()")
        eval_js(ws, tile_focus_eval(idx), await_promise=True)
        return
    cdp.click_at(ws, pt["x"], pt["y"])
    time.sleep(0.25)
    if menu_open(ws):
        # lingering popover (e.g. model picker) — dismiss with Escape, then re-click
        eval_js(ws, "document.dispatchEvent(new KeyboardEvent('keydown',"
                    "{key:'Escape',code:'Escape',bubbles:true}));true;", await_promise=False)
        time.sleep(0.15)
        cdp.click_at(ws, pt["x"], pt["y"])
        time.sleep(0.15)
    print(f"real click at {pt}; menu still open: {menu_open(ws)}")


def type_in_composer(ws, idx, text):
    """Real-click the follow-up composer, then insert `text` (replacing any draft)."""
    real_focus(ws, idx)
    tmpl = (
        "\n;(()=>{const ed=editorIn(__IDX__);if(!ed)return {ok:false};"
        "ed.focus();document.execCommand('selectAll',false,null);"
        "document.execCommand('insertText',false,__TEXT__);"
        "return {ok:true,text:(ed.textContent||'').slice(0,40)};})()"
    )
    js = js_bundle() + tmpl.replace("__IDX__", str(idx)).replace("__TEXT__", json.dumps(text))
    r = eval_js(ws, js)
    print(f"typed {text!r} into composer: {r}")
    return r


def response_state(ws, idx):
    """Current AI-response state of tile `idx`: count, planning flag, last text."""
    tmpl = (
        "\n;(()=>{const idx=__IDX__;"
        "const t=tiles().length?tileAt(idx):document;"
        "const sh=t?.querySelector('.ui-collapsible-action.ui-collapsible-shimmer')?.textContent||'';"
        "const text=latestAiText(idx)||'';"
        "return {aiCount:aiMessagesInTile(idx).length,"
        "planning:/planning\\s+next\\s+move/i.test(sh),"
        "generating:!!stopInIdx(idx),lastText:text.slice(0,120)};})()"
    )
    return eval_js(ws, js_bundle() + tmpl.replace("__IDX__", str(idx)), await_promise=False) or {}


def response_stop_eval(idx, clear_polls=35, min_planning_polls=5):
    """JS: truthy once the 'Planning next moves' indicator has APPEARED (for at
    least `min_planning_polls` consecutive polls) and then stayed CLEARED for
    `clear_polls` consecutive polls on tile `idx`.

    Works around the Cursor bug where the agent gets stuck on 'Planning next
    moves'; we hold Enter to nudge it, and stop once that indicator is gone for
    good (the response has rendered). The shimmer flickers on/off while the agent
    works, so a single cleared poll is not enough — we debounce with a streak
    counter and only stop after a sustained clear. Requiring a minimum planning
    visibility streak avoids exiting early when interval=0 spam submits before
    planning ever really sticks."""
    return (
        "(()=>{const idx=" + str(idx)
        + ",need=" + str(clear_polls)
        + ",minPlan=" + str(min_planning_polls) + ";"
        "const t=tiles().length?tileAt(idx):document;"
        "const sh=t?.querySelector('.ui-collapsible-action.ui-collapsible-shimmer')?.textContent||'';"
        "const planning=/planning\\s+next\\s+move/i.test(sh);"
        "if(planning){window.__wfPlanned=true;window.__wfPlanStreak=(window.__wfPlanStreak||0)+1;window.__wfClear=0;}"
        "else{window.__wfPlanStreak=0;"
        "if(window.__wfPlanned&&(window.__wfPlanPeak||0)>=minPlan){window.__wfClear=(window.__wfClear||0)+1;}}"
        "window.__wfPlanPeak=Math.max(window.__wfPlanPeak||0,window.__wfPlanStreak||0);"
        "return !!window.__wfPlanned&&!planning&&(window.__wfPlanPeak>=minPlan)&&(window.__wfClear>=need);})()"
    )


def _resolve_tile(ws, idx, agent_id):
    """Re-resolve tile index from agent_id when available."""
    if agent_id:
        ridx = focus_agent(ws, agent_id)
        if ridx is not None:
            return ridx
    return idx


def enter_spam_until_planning_clears(ws, idx, interval, max_secs, agent_id=None):
    """Single-agent enter spam (borrowed): focus composer, hold Enter until
    'Planning next moves' has appeared and then cleared on this tile."""
    idx = _resolve_tile(ws, idx, agent_id)
    cap = f"{max_secs}s cap" if max_secs else "unlimited"
    who = f"agent {agent_id}" if agent_id else f"tile {idx}"
    print(f"hold Enter until planning clears on {who} ({cap})")
    real_focus(ws, idx)
    time.sleep(random.uniform(0.3, 0.7))

    eval_js(
        ws,
        "window.__wfPlanned=false;window.__wfPlanStreak=0;"
        "window.__wfClear=0;window.__wfPlanPeak=0;true;",
        await_promise=False,
    )
    base = response_state(ws, idx)
    print(f"baseline: generating={base.get('generating')}, planning={base.get('planning')}")

    focus_eval = agent_focus_eval(agent_id) if agent_id else tile_focus_eval(idx)
    stop_eval = (
        response_stop_eval_by_agent(agent_id)
        if agent_id
        else response_stop_eval(idx)
    )

    presses, stop_reason = cdp.hold_key(
        ws, "Enter", interval=interval, jitter=0.15,
        focus_eval=focus_eval, stop_eval=stop_eval,
        max_secs=(max_secs or None), min_hold_secs=0.0,
    )

    cleared = stop_reason == "stop_eval"
    final = response_state(ws, idx)
    print(
        f"enter_presses={presses}; planning_cleared={cleared}; "
        f"stop_reason={stop_reason}; planning={final.get('planning')}, "
        f"lastText={final.get('lastText', '')[:80]!r}"
    )
    return cleared, idx, stop_reason


def hold_until_mcp_connected(ws, idx, interval, max_secs, agent_id=None):
    """Phase 2: after submit, hold Enter until the tile is in the jefr MCP loop.

    Stop when either:
      - CDP: tile shows a running Check Messages in jefr tool call (debounced)
      - Filesystem: agents/<agent_id>/agent-alive.json is fresh (via stop_check)
    """
    idx = _resolve_tile(ws, idx, agent_id)
    cap = f"{max_secs}s cap" if max_secs else "unlimited"
    who = f"agent {agent_id}" if agent_id else f"tile {idx}"
    print(f"hold Enter until MCP connected on {who} ({cap})")
    real_focus(ws, idx)
    time.sleep(random.uniform(0.3, 0.7))

    eval_js(ws, "window.__wfMcpStreak=0;true;", await_promise=False)
    base = response_state(ws, idx)
    print(f"mcp-wait baseline: generating={base.get('generating')}, planning={base.get('planning')}")

    focus_eval = agent_focus_eval(agent_id) if agent_id else tile_focus_eval(idx)
    if agent_id:
        stop_eval = mcp_connected_stop_eval_by_agent(agent_id)
        stop_check = lambda: mcp_alive.is_connected(agent_id)
    else:
        stop_eval = mcp_connected_stop_eval(idx)
        stop_check = lambda: mcp_alive.is_connected(None)

    presses, stop_reason = cdp.hold_key(
        ws, "Enter", interval=interval, jitter=0.15,
        focus_eval=focus_eval, stop_eval=stop_eval, stop_check=stop_check,
        max_secs=(max_secs or None), min_hold_secs=5.0,
        release_on_stop=True,
    )

    final = response_state(ws, idx)
    hb_ok = (
        verify_per_agent_heartbeat(agent_id, timeout=8.0)
        if agent_id
        else mcp_alive.is_connected(None)
    )
    snap(ws, "done")
    print(
        f"mcp_hold_presses={presses}; stop_reason={stop_reason}; "
        f"mcp_connected={hb_ok}; planning={final.get('planning')}, "
        f"lastText={final.get('lastText', '')[:80]!r}"
    )
    return hb_ok, stop_reason, idx


def enter_until_mcp_connected(ws, idx, interval, max_secs, agent_id=None):
    """Alias kept for callers/tests: planning-clear spam, then MCP-connected hold."""
    _, idx, _ = enter_spam_until_planning_clears(
        ws, idx, interval, _planning_hold_secs(max_secs), agent_id=agent_id,
    )
    if agent_id and mcp_alive.is_connected(agent_id):
        return True, "stop_check"
    if not agent_id and mcp_alive.is_connected(None):
        return True, "stop_check"
    connected, stop_reason, _ = hold_until_mcp_connected(
        ws, idx, interval, _mcp_hold_secs(max_secs), agent_id=agent_id,
    )
    return connected, stop_reason


def enter_until_response(ws, idx, interval, max_secs, agent_id=None):
    """Submit via single-agent enter spam, then wait for MCP loop confirmation."""
    cleared, idx, _ = enter_spam_until_planning_clears(
        ws, idx, interval, _planning_hold_secs(max_secs), agent_id=agent_id,
    )
    if not cleared:
        print("WARN: planning did not clear during enter spam — continuing to MCP wait")

    if agent_id and mcp_alive.is_connected(agent_id):
        print("MCP loop confirmed immediately after enter spam")
        cdp.release_key(ws, "Enter")
        print("workflow: MCP connected — Enter released, workflow done")
        return True
    if not agent_id and mcp_alive.is_connected(None):
        print("MCP loop confirmed immediately after enter spam")
        cdp.release_key(ws, "Enter")
        print("workflow: MCP connected — Enter released, workflow done")
        return True

    connected, _, idx = hold_until_mcp_connected(
        ws, idx, interval, _mcp_hold_secs(max_secs), agent_id=agent_id,
    )
    if agent_id and not connected:
        print("WARN: MCP loop not confirmed on per-agent heartbeat — re-nudging agent_id routing")
        idx = _resolve_tile(ws, idx, agent_id)
        type_in_composer(ws, idx, agent_id_reminder(agent_id))
        _, idx, _ = enter_spam_until_planning_clears(
            ws, idx, interval, _planning_hold_secs(max_secs), agent_id=agent_id,
        )
        connected, _, _ = hold_until_mcp_connected(
            ws, idx, interval, _mcp_hold_secs(max_secs), agent_id=agent_id,
        )
    if not connected:
        print("ERROR: tile never reached a confirmed MCP connection")
        return False
    print("workflow: MCP connected — Enter released, workflow done")
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt", nargs="?")
    ap.add_argument("--enter-interval", type=float, default=0,
                    help="seconds between held Enter autorepeat ticks after the "
                         "initial 500ms delay (0 = OS human rate ~31ms; set e.g. "
                         "0.12 to pace slower)")
    ap.add_argument("--max-secs", type=float, default=6000.0,
                    help="safety cap for MCP-wait Enter hold in seconds "
                         f"(planning-clear cap is fixed at {PLANNING_HOLD_CAP:.0f}s; "
                         "default 6000; 0 = unlimited)")
    ap.add_argument("--type-text", default=None,
                    help="MCP prompt to type into the composer before Enter spam "
                         "(default: an improvised 'directly invoke the mcp' instruction)")
    ap.add_argument("--model", default=DEFAULT_MODEL,
                    help="Model name/pattern to select after Auto phase "
                         f"(default: {DEFAULT_MODEL!r}; also supports 'Opus 4.8 1M High Fast')")
    ap.add_argument("--keep-tiles", dest="keep_tiles", action="store_true",
                    help="Do NOT collapse existing tiles before splitting. Leaves "
                         "every already-open agent tile intact and just adds a new "
                         "one — required to keep multiple agents online at once "
                         "(repeated spawns accumulate instead of replacing).")
    ap.add_argument("--reconnect", action="store_true",
                    help="Reconnect mode: skip split/Auto/GPT; detect a dropped "
                         "('worked') tile and re-prime its MCP loop in place")
    ap.add_argument("--tile", type=int, default=None,
                    help="Target tile index for --reconnect (default: auto-detect "
                         "the dropped tile)")
    ap.add_argument("--agent-id", dest="agent_id", default=None,
                    help="Stable Cursor agentId for this tile. On spawn it's "
                         "injected into the MCP prompt so the agent passes it back "
                         "on every jefr call (auto-read from the tile's React fiber "
                         "if omitted). On --reconnect it selects which tile to "
                         "re-prime (preferred over --tile / auto-detect).")
    args = ap.parse_args()

    # Wall-clock anchor so we can log how long the connect actually takes.
    t0 = time.time()

    def elapsed():
        return time.time() - t0

    type_text = args.type_text or mcp_prompt()

    if args.reconnect:
        ws = connect()
        print(f"[t+{elapsed():.1f}s] connected to workbench")
        snap(ws, "initial")
        idx = None
        if args.agent_id:
            idx = focus_agent(ws, args.agent_id)
            if idx is not None:
                print(f"reconnect: matched agent {args.agent_id} -> tile {idx}")
            else:
                print(f"WARN: agent-id {args.agent_id} not found among tiles — "
                      "falling back to --tile / auto-detect")
        if idx is None:
            idx = args.tile
        if idx is None:
            idx = detect_dropped_tile(ws)
        if idx is None:
            fail("no dropped tile detected (nothing to reconnect)")
        # Re-priming must re-assert the agent's id so its loop rejoins its own
        # queue (the id == this tile's real agentId).
        agent_id = args.agent_id or agent_id_for(ws, idx)
        rtext = mcp_prompt_with_id(type_text, agent_id)
        print(f"# reconnect mode; agent_id: {agent_id}; mcp prompt: {rtext!r}")
        if not reconnect(ws, idx, rtext, args.enter_interval, args.max_secs, agent_id=agent_id):
            fail("MCP connection not confirmed on reconnect", {"agent_id": agent_id})
        print(f"workflow: reconnected MCP in {elapsed():.1f}s (agent {agent_id})")
        return

    prompt = args.prompt or auto_prompt()
    print(f"# auto prompt: {prompt!r}")

    ws = connect()
    print(f"[t+{elapsed():.1f}s] connected to workbench")
    snap(ws, "initial")

    if args.keep_tiles:
        print("keep-tiles: leaving existing agent tiles intact — accumulating a new agent")
    else:
        prepare(ws)
    idx = split(ws)
    print(f"[t+{elapsed():.1f}s] split done — new tile {idx}")
    idx, agent_id = run_phase(ws, prompt, idx, args.model)
    print(f"[t+{elapsed():.1f}s] auto phase + model select done")
    # Inject this tile's real agentId ONCE so the agent partitions to its own
    # queue; the server's systemSuffix echoes it back on every later turn.
    agent_id = args.agent_id or agent_id or agent_id_for(ws, idx)
    # Re-resolve the tile from the agentId for the remaining steps (index can
    # have shifted while the model picker was open).
    if agent_id:
        ridx = focus_agent(ws, agent_id)
        if ridx is not None:
            idx = ridx
    mcp_text = mcp_prompt_with_id(type_text, agent_id)
    print(f"# agent_id: {agent_id}; tile: {idx}")
    print(f"# mcp prompt: {mcp_text!r}")
    type_in_composer(ws, idx, mcp_text)
    if not enter_until_response(ws, idx, args.enter_interval, args.max_secs, agent_id=agent_id):
        fail("MCP connection not confirmed", {"agent_id": agent_id})
    print(f"workflow: MCP connected in {elapsed():.1f}s (agent {agent_id})")


if __name__ == "__main__":
    main()
