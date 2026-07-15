#!/usr/bin/env python3
"""End-to-end Cursor Agents automation over CDP, with a snapshot at each step.

Stages (spawn):
  1. connect   — find the Cursor workbench page over CDP
  2. prepare   — best-effort collapse of extra tiles back to the base tile
  3. split     — ALWAYS a fresh trusted Ctrl+D split; new tile index detected
                 dynamically (binary split tree — not always last)
  4. phase     — on the new tile: Auto -> stand-by prompt -> wait -> select
                 target model (default Opus 4.8 1M Extra High Fast).
                 With --skip-auto: select the target model immediately, then
                 continue to MCP priming.
  5. type      — type the MCP prompt into the Send follow-up composer
                 (injects agent_id for multi-agent routing; skipped with
                 --single-agent so the agent uses the shared General queue)
  6. hold      — HOLD Enter until MCP connected (planning-clear then MCP-detect;
                 --max-secs default 6000s; Enter released on connect)

Reconnect (--reconnect):
  implies skip-auto — agentId is already known, so Auto stand-by is unnecessary.
  Idle-wait + select --model on the existing tile -> type MCP prompt -> hold Enter.

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
MCP_HOLD_DEFAULT = 6000.0
REFOCUS_SECS = 60

# Auto phase only exists to spin up the tile before we switch to the target
# model — stand by, don't work. Timestamp added in auto_prompt().
AUTO_PROMPTS = [
    "STAND BY. Do NOT do anything yet — don't read, edit, run, or plan anything. Just wait for my next instruction.",
    "STAND BY and do NOTHING. Don't read files, don't run commands, don't make changes. Wait silently for my next message.",
    "IMPORTANT: STAND BY. Take NO action of any kind right now. Just hold and wait for my next instruction.",
    "Just STAND BY. Don't do anything at all — no actions, no analysis. Wait for what I send next.",
]

MCP_PROMPTS = [
    "Directly invoke the mcp. Don't do anything else first, and keep the mcp connection open.",
    "Invoke the mcp right away — don't do anything else beforehand, and keep the mcp connection alive.",
    "Call the mcp directly. Do nothing else first, and keep the mcp connection running.",
    "Start by invoking the mcp directly. Don't do anything else first, and hold the mcp connection open.",
]


# ---------------------------------------------------------------------------
# CDP / JS helpers
# ---------------------------------------------------------------------------

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


def fail(message, payload=None):
    print(f"ERROR: {message}")
    if payload and payload.get("log"):
        for line in payload["log"][-6:]:
            print(" ", line)
    sys.exit(1)


def _mcp_hold_secs(max_secs):
    """Return the Enter-hold cap in seconds (None = unlimited)."""
    if max_secs == 0:
        return None
    return max_secs if max_secs else MCP_HOLD_DEFAULT


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

def auto_prompt():
    """Initial Auto prompt: leading timestamp + strong standby instruction."""
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    return f"[{ts}] {random.choice(AUTO_PROMPTS)}"


def mcp_prompt():
    """Improvised MCP prompt: invoke the mcp directly and keep it connected."""
    return random.choice(MCP_PROMPTS)


def mcp_prompt_with_id(base, agent_id):
    """Append identity so the agent routes to its own per-agent queue.

    A single shared MCP server serves every tile — the agent must pass agent_id
    on every jefr call. The server's systemSuffix echoes it back, so this only
    has to be injected once (at spawn / reconnect).
    """
    if not agent_id:
        return base
    return (
        f"{base} You are jefr agent {agent_id}; pass agent_id:'{agent_id}' on every "
        "jefr MCP call (check_messages / ask_question / send_progress)."
    )


def agent_id_reminder(agent_id):
    """One-line nudge when the tile connected but skipped per-agent routing."""
    return (
        f"Pass agent_id:'{agent_id}' on every jefr MCP call "
        "(check_messages / send_progress / ask_question)."
    )


# Aliases expected by validate_launcher.py
inject_agent_id = mcp_prompt_with_id


# ---------------------------------------------------------------------------
# Agent / tile identity
# ---------------------------------------------------------------------------

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
    """Focus the tile whose fiber agentId matches; return tile index or None."""
    js = cdp.js_bundle("agent_map.js").replace("__AGENT__", agent_id)
    res = eval_js(ws, js, await_promise=False)
    if isinstance(res, dict) and res.get("ok") and isinstance(res.get("focused"), int):
        idx = res["focused"]
        # JS focus() alone often isn't enough with several tiled agents — a real
        # click into the follow-up composer makes keyboard routing stick.
        real_focus_quick(ws, idx)
        return idx
    return None


def find_tile_by_agent(ws, agent_id):
    """Return tile index for agent_id without clicking (read-only map)."""
    if not agent_id:
        return None
    for r in agent_rows(ws):
        if r.get("agentId") == agent_id:
            return r.get("i")
    return None


# Aliases expected by validate_launcher.py
read_agent_id = agent_id_for


def _resolve_tile(ws, idx, agent_id):
    """Re-resolve tile index from agent_id when available."""
    if agent_id:
        ridx = focus_agent(ws, agent_id)
        if ridx is not None:
            return ridx
    return idx


def resolve_agent_and_tile(ws, idx, agent_id=None, preferred=None):
    """Pick agent_id (preferred > given > fiber) and re-resolve tile index."""
    agent_id = preferred or agent_id or agent_id_for(ws, idx)
    if agent_id:
        idx = _resolve_tile(ws, idx, agent_id)
    return idx, agent_id


# ---------------------------------------------------------------------------
# Self-contained stop / focus evals (hold_key cannot rely on page helpers)
# ---------------------------------------------------------------------------

# Fiber walk: given DOM node `n`, return its React-fiber agentId or null.
_FIBER_ID_JS = (
    "const fid=(n)=>{const k=Object.keys(n).find(x=>x.startsWith('__reactFiber$')"
    "||x.startsWith('__reactInternalInstance$'));"
    "let f=k?n[k]:null,s=0;"
    "while(f&&s++<40){const p=f.memoizedProps;"
    "if(p&&typeof p.agentId==='string')return p.agentId;f=f.return;}return null;};"
)

# Tile list + pick by agentId (sets `t`) or by index (sets `t` from `idx`).
_TILES_JS = (
    "const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
)

_PICK_BY_AGENT_JS = (
    _TILES_JS + _FIBER_ID_JS +
    "const t=ts.find(x=>fid(x)===ID);"
)

_PICK_BY_IDX_JS = (
    _TILES_JS +
    "const t=ts.length?ts.at(idx<0?ts.length+idx:idx):document;"
)

# Follow-up composer focus inside already-resolved `t` (or root).
_FOCUS_COMPOSER_JS = (
    "const eds=[...root.querySelectorAll('.tiptap.ProseMirror.ui-prompt-input-editor__input')]"
    ".filter(e=>!e.closest('.prompt-edit-input'));"
    "const isFu=e=>e.closest('.agent-panel-followup-input')||/send follow-?up/i.test("
    "(e.querySelector('[data-placeholder]')?.getAttribute('data-placeholder'))"
    "||e.getAttribute('data-placeholder')||'');"
    "const ed=eds.find(isFu)||eds[eds.length-1];"
    "if(!ed)return false;ed.focus();return true;"
)

# True iff a jefr check_messages tool call is *currently running* in tile `t`.
# Completed "Ran Check Messages" cards and user-bubble spawn text are ignored.
_MCP_RUNNING_JS = (
    "const tc=[...t.querySelectorAll('[data-message-kind=\"tool\"]')];"
    "const connected=tc.some(m=>{const x=m.textContent||'';"
    "if(!/check\\s*messages/i.test(x)||!/jefr/i.test(x))return false;"
    "const st=(m.getAttribute('data-tool-status')||'').toLowerCase();"
    "const cl=typeof m.className==='string'?m.className:'';"
    "return /run|load|pend|progress|stream|active/.test(st)||/with-stop/.test(cl)"
    "||!!m.querySelector('[class*=\"shimmer\"],[class*=\"spinner\"],"
    ".codicon-modifier-spin,[class*=\"with-stop\"]');});"
)

_PLANNING_TRACK_JS = (
    "const sh=t.querySelector('.ui-collapsible-action.ui-collapsible-shimmer')?.textContent||'';"
    "const planning=/planning\\s+next\\s+move/i.test(sh);"
    "if(planning){window.__wfPlanned=true;window.__wfPlanStreak=(window.__wfPlanStreak||0)+1;window.__wfClear=0;}"
    "else{window.__wfPlanStreak=0;"
    "if(window.__wfPlanned&&(window.__wfPlanPeak||0)>=minPlan){window.__wfClear=(window.__wfClear||0)+1;}}"
    "window.__wfPlanPeak=Math.max(window.__wfPlanPeak||0,window.__wfPlanStreak||0);"
)


def tile_focus_eval(idx):
    """JS that focuses the LIVE 'Send follow-up' composer inside tile `idx`."""
    return (
        "(()=>{"
        "const ts=[...document.querySelectorAll('.glass-agent-conversation-tiling__tile')];"
        f"const root=ts.length?ts.at({idx}):document;"
        "if(!root)return false;"
        + _FOCUS_COMPOSER_JS +
        "})()"
    )


def agent_focus_eval(agent_id):
    """Focus follow-up composer of the tile whose fiber agentId matches."""
    return (
        "(()=>{"
        f"const ID={json.dumps(agent_id)};"
        + _TILES_JS + _FIBER_ID_JS +
        "const t=ts.find(x=>fid(x)===ID)||ts[ts.length-1];if(!t)return false;"
        "const root=t;"
        + _FOCUS_COMPOSER_JS +
        "})()"
    )


def _combined_mcp_stop_body(clear_polls, min_planning_polls, mcp_streak_needed):
    """Shared body after `t` is bound: planning must clear, then MCP running."""
    return (
        f"const planNeed={clear_polls},minPlan={min_planning_polls},mcpNeed={mcp_streak_needed};"
        "if(!t){window.__wfMcpStreak=0;return false;}"
        + _PLANNING_TRACK_JS +
        "const planningDone=!!window.__wfPlanned&&!planning&&(window.__wfPlanPeak>=minPlan)&&(window.__wfClear>=planNeed);"
        "if(!planningDone)return false;"
        + _MCP_RUNNING_JS +
        "if(connected){window.__wfMcpStreak=(window.__wfMcpStreak||0)+1;}"
        "else{window.__wfMcpStreak=0;}"
        "return window.__wfMcpStreak>=mcpNeed;"
    )


def combined_mcp_stop_eval_by_agent(agent_id, clear_polls=35, min_planning_polls=5, mcp_streak_needed=12):
    """Single stop_eval: planning clears, then MCP tool call running (by agentId)."""
    return (
        "(()=>{"
        f"const ID={json.dumps(agent_id)};"
        + _PICK_BY_AGENT_JS
        + _combined_mcp_stop_body(clear_polls, min_planning_polls, mcp_streak_needed)
        + "})()"
    )


def combined_mcp_stop_eval(idx, clear_polls=35, min_planning_polls=5, mcp_streak_needed=12):
    """Tile-index version of combined_mcp_stop_eval_by_agent."""
    return (
        "(()=>{"
        f"const idx={idx};"
        + _PICK_BY_IDX_JS
        + _combined_mcp_stop_body(clear_polls, min_planning_polls, mcp_streak_needed)
        + "})()"
    )


def response_stop_eval(idx, clear_polls=35, min_planning_polls=5):
    """Truthy once planning appeared (min streak) then stayed cleared on tile `idx`.

    Used by batch_run-style monitors; hold_key MCP path uses combined_mcp_stop_*.
    """
    return (
        "(()=>{"
        f"const idx={idx},need={clear_polls},minPlan={min_planning_polls};"
        "const t=tiles().length?tileAt(idx):document;"
        "const sh=t?.querySelector('.ui-collapsible-action.ui-collapsible-shimmer')?.textContent||'';"
        "const planning=/planning\\s+next\\s+move/i.test(sh);"
        "if(planning){window.__wfPlanned=true;window.__wfPlanStreak=(window.__wfPlanStreak||0)+1;window.__wfClear=0;}"
        "else{window.__wfPlanStreak=0;"
        "if(window.__wfPlanned&&(window.__wfPlanPeak||0)>=minPlan){window.__wfClear=(window.__wfClear||0)+1;}}"
        "window.__wfPlanPeak=Math.max(window.__wfPlanPeak||0,window.__wfPlanStreak||0);"
        "return !!window.__wfPlanned&&!planning&&(window.__wfPlanPeak>=minPlan)&&(window.__wfClear>=need);})()"
    )


# ---------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Detect / connect / prepare / split
# ---------------------------------------------------------------------------

def detect_dropped_tile(ws):
    """Return index of a tile whose MCP loop has dropped, or None.

    Dropped = idle (not generating, not planning) with a "Worked for ..." stamp.
    Prefers a GPT tile if several qualify (historical keep-connected bias).
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
        "const _mt=[...t.querySelectorAll('.ui-model-picker__trigger-text')].filter(el=>!el.closest('.prompt-edit-input'));"
        "const model=_mt[_mt.length-1]?.textContent?.trim()||'';"
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
    """Fresh Ctrl+D split; return the NEW tile's index (tagged, not last-index)."""
    before = tile_count(ws)
    eval_js(
        ws,
        "(()=>{const ts=[...document.querySelectorAll("
        "'.glass-agent-conversation-tiling__tile')];"
        "ts.forEach(t=>t.setAttribute('data-jefr-pre','1'));return ts.length;})()",
        await_promise=False,
    )
    print(f"split: Ctrl+D to open a new tile (tiles before={before})")
    cdp.send_chord(ws, "Control+d", focus_eval=tile_focus_eval(-1))

    find_new = (
        "(()=>{const ts=[...document.querySelectorAll("
        "'.glass-agent-conversation-tiling__tile')];"
        "const u=[];ts.forEach((t,i)=>{if(!t.hasAttribute('data-jefr-pre'))u.push(i);});"
        "return JSON.stringify({n:ts.length,unmarked:u});})()"
    )
    new_idx = None
    for _ in range(40):
        time.sleep(0.15)
        info = eval_js(ws, find_new, await_promise=False)
        try:
            data = json.loads(info) if isinstance(info, str) else (info or {})
        except Exception:
            data = {}
        unmarked = data.get("unmarked") or []
        if data.get("n", 0) > before and unmarked:
            new_idx = unmarked[-1]
            break
    eval_js(
        ws,
        "(()=>{document.querySelectorAll("
        "'.glass-agent-conversation-tiling__tile[data-jefr-pre]')"
        ".forEach(t=>t.removeAttribute('data-jefr-pre'));return true;})()",
        await_promise=False,
    )
    if new_idx is None:
        new_idx = max(0, tile_count(ws) - 1)
    snap(ws, "after-split")
    print(f"split: new tile index = {new_idx} (tiles now={tile_count(ws)})")
    return new_idx


# ---------------------------------------------------------------------------
# Phase / reconnect prep
# ---------------------------------------------------------------------------

def run_phase(ws, prompt, idx, model_pattern, skip_auto=False):
    """Optionally Auto + stand-by, then select target model. Returns (idx, agent_id)."""
    phase = eval_js(
        ws,
        js_bundle(
            "workflow.js",
            __TARGET__=idx,
            __PROMPT__=json.dumps(prompt),
            __MODEL__=json.dumps(model_pattern),
            __SKIP_AUTO__="true" if skip_auto else "false",
        ),
    )
    summary = {k: phase.get(k) for k in phase if k not in ("log", "snapshot")} if phase else phase
    print("phase:", json.dumps(summary, indent=2))
    snap(ws, "after-phase")

    if phase and not phase.get("error"):
        return phase.get("idx", idx), phase.get("agentId")

    soft_fails = {"model not found", "no ai response on NEW tile", "tile still generating"}
    if phase and phase.get("error") in soft_fails:
        print(f"WARN: {phase['error']} — continuing Enter spam with current model")
        return phase.get("idx", idx), phase.get("agentId")

    fail("phase failed", phase)


# ---------------------------------------------------------------------------
# Composer focus / type
# ---------------------------------------------------------------------------

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
        eval_js(ws, "document.dispatchEvent(new KeyboardEvent('keydown',"
                    "{key:'Escape',code:'Escape',bubbles:true}));true;", await_promise=False)
        time.sleep(0.15)
        cdp.click_at(ws, pt["x"], pt["y"])
        time.sleep(0.15)
    print(f"real click at {pt}; menu still open: {menu_open(ws)}")


def real_focus_quick(ws, idx):
    """Real mouse click into follow-up composer — no sleeps (hold-loop refocus)."""
    pt = editor_center(ws, idx)
    if not pt:
        eval_js(ws, tile_focus_eval(idx), await_promise=True)
        return
    cdp.click_at(ws, pt["x"], pt["y"])


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


# ---------------------------------------------------------------------------
# Enter hold / MCP prime
# ---------------------------------------------------------------------------

def hold_enter_until_mcp_connected(ws, idx, interval, max_secs, agent_id=None, single_agent=False):
    """One continuous Enter hold: planning clears, then MCP loop confirmed.

    With single_agent=True the agent listens on the shared root queue (no
    agent_id in tool calls), so heartbeat checks use the root file even when
    agent_id is known for tile focus.
    """
    idx = _resolve_tile(ws, idx, agent_id)
    cap = f"{max_secs}s cap" if max_secs else "unlimited"
    if single_agent:
        who = f"shared queue (tile {idx}" + (f", agent {agent_id}" if agent_id else "") + ")"
    else:
        who = f"agent {agent_id}" if agent_id else f"tile {idx}"
    print(f"hold Enter continuously until MCP connected on {who} ({cap})")
    real_focus(ws, idx)
    time.sleep(random.uniform(0.3, 0.7))

    eval_js(
        ws,
        "window.__wfPlanned=false;window.__wfPlanStreak=0;"
        "window.__wfClear=0;window.__wfPlanPeak=0;window.__wfMcpStreak=0;true;",
        await_promise=False,
    )
    base = response_state(ws, idx)
    print(f"baseline: generating={base.get('generating')}, planning={base.get('planning')}")

    # CDP/JS focus only during hold — real clicks disrupt Enter autorepeat.
    # Prefer agentId so index shifts mid-hold don't drift to another tile.
    refocus_eval = agent_focus_eval(agent_id) if agent_id else tile_focus_eval(idx)

    # Heartbeat routing: shared root in single-agent mode, else per-agent.
    hb_id = None if single_agent else agent_id
    if agent_id:
        # DOM MCP-running detect still keys off the tile's fiber id.
        stop_eval = combined_mcp_stop_eval_by_agent(agent_id)
        stop_check = lambda: mcp_alive.is_connected(hb_id)
    else:
        stop_eval = combined_mcp_stop_eval(idx)
        stop_check = lambda: mcp_alive.is_connected(None)

    presses, stop_reason = cdp.hold_key(
        ws, "Enter", interval=interval, jitter=0.15,
        focus_eval=refocus_eval,
        stop_eval=stop_eval, stop_check=stop_check,
        max_secs=(max_secs or None), min_hold_secs=5.0,
        release_on_stop=True,
        refocus_secs=REFOCUS_SECS,
    )

    final = response_state(ws, idx)
    if single_agent or not agent_id:
        hb_ok = mcp_alive.is_connected(None)
    else:
        hb_ok = verify_per_agent_heartbeat(agent_id, timeout=8.0)
    if stop_reason in ("stop_eval", "stop_check"):
        hb_ok = True
    print(
        f"hold_presses={presses}; stop_reason={stop_reason}; "
        f"mcp_connected={hb_ok}; planning={final.get('planning')}, "
        f"lastText={final.get('lastText', '')[:80]!r}"
    )
    return hb_ok, stop_reason, idx


def enter_until_response(ws, idx, interval, max_secs, agent_id=None, single_agent=False):
    """Type prompt already done — hold Enter until MCP loop confirmed."""
    hold_cap = _mcp_hold_secs(max_secs)
    connected, _, idx = hold_enter_until_mcp_connected(
        ws, idx, interval, hold_cap, agent_id=agent_id, single_agent=single_agent,
    )
    # Multi-agent only: nudge agent_id routing if the tile connected without
    # writing a per-agent heartbeat. Single-agent mode intentionally omits id.
    if agent_id and not single_agent and not connected:
        print("WARN: MCP loop not confirmed on per-agent heartbeat — re-nudging agent_id routing")
        idx = _resolve_tile(ws, idx, agent_id)
        type_in_composer(ws, idx, agent_id_reminder(agent_id))
        connected, _, _ = hold_enter_until_mcp_connected(
            ws, idx, interval, hold_cap, agent_id=agent_id, single_agent=False,
        )
    snap(ws, "done")
    if not connected:
        print("ERROR: tile never reached a confirmed MCP connection")
        return False
    print("workflow: MCP connected — Enter released, workflow done")
    return True


def prime_mcp(ws, idx, type_text, interval, max_secs, agent_id=None, preferred_id=None,
              single_agent=False):
    """Resolve agent/tile, optionally inject id into prompt, type, hold Enter.

    Shared by spawn and reconnect. Returns (ok, agent_id, idx).

    single_agent=True: leave agent_id out of the prompt so the agent uses the
    shared root queue (General). Tile focus still uses the fiber id when known.
    """
    idx, agent_id = resolve_agent_and_tile(ws, idx, agent_id, preferred=preferred_id)
    if single_agent:
        text = type_text
        print(f"# single-agent: shared queue (no agent_id in prompt); tile: {idx}")
        if agent_id:
            print(f"# tile agent_id (focus only): {agent_id}")
    else:
        text = mcp_prompt_with_id(type_text, agent_id)
        print(f"# agent_id: {agent_id}; tile: {idx}")
    print(f"# mcp prompt: {text!r}")
    type_in_composer(ws, idx, text)
    ok = enter_until_response(
        ws, idx, interval, max_secs, agent_id=agent_id, single_agent=single_agent,
    )
    return ok, agent_id, idx


def reconnect(ws, idx, type_text, interval, max_secs, agent_id=None, single_agent=False):
    """Re-prime an EXISTING dropped tile in place (no Ctrl+D split)."""
    idx = _resolve_tile(ws, idx, agent_id)
    if agent_id:
        print(f"reconnect: targeting agent {agent_id} -> tile {idx}")
    else:
        print(f"reconnect: targeting tile {idx}")
    type_in_composer(ws, idx, type_text)
    return enter_until_response(
        ws, idx, interval, max_secs, agent_id=agent_id, single_agent=single_agent,
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _pick_reconnect_tile(ws, args):
    """Resolve which tile to reconnect: --agent-id > --tile > auto-detect."""
    idx = None
    if args.agent_id:
        idx = focus_agent(ws, args.agent_id)
        if idx is not None:
            print(f"reconnect: matched agent {args.agent_id} -> tile {idx}")
        else:
            print(
                f"WARN: agent-id {args.agent_id} not found among tiles — "
                "falling back to --tile / auto-detect"
            )
    if idx is None:
        idx = args.tile
    if idx is None:
        idx = detect_dropped_tile(ws)
    if idx is None:
        fail("no dropped tile detected (nothing to reconnect)")
    return idx


def run_reconnect_flow(ws, args, type_text, elapsed):
    """Reconnect: skip-auto phase (select --model, no Auto) -> prime MCP.

    AgentId is already known on a dropped tile — Auto's only job on spawn was
    minting a trustworthy fiber id, so reconnect always implies skip-auto.
    """
    idx = _pick_reconnect_tile(ws, args)
    agent_id = args.agent_id or agent_id_for(ws, idx)
    if not agent_id:
        fail("no agentId for reconnect tile", {"idx": idx})

    print(
        f"# reconnect: skip-auto (agent id known); selecting model {args.model!r}"
    )
    # Empty prompt — skip-auto never sends the Auto stand-by turn.
    idx, phase_id = run_phase(ws, "", idx, args.model, skip_auto=True)
    agent_id = args.agent_id or phase_id or agent_id
    print(f"[t+{elapsed():.1f}s] reconnect skip-auto model select done")

    ok, agent_id, _ = prime_mcp(
        ws, idx, type_text, args.enter_interval, args.max_secs,
        agent_id=agent_id, preferred_id=args.agent_id,
        single_agent=args.single_agent,
    )
    if not ok:
        fail("MCP connection not confirmed on reconnect", {"agent_id": agent_id})
    route = "shared queue" if args.single_agent else f"agent {agent_id}"
    print(f"workflow: reconnected MCP in {elapsed():.1f}s ({route})")


def run_spawn_flow(ws, args, type_text, elapsed):
    """Spawn: prepare/split -> phase -> prime MCP."""
    # Single-agent always skips Auto stand-by — go straight to target model + MCP.
    skip_auto = bool(args.skip_auto or args.single_agent)
    prompt = args.prompt or auto_prompt()
    if args.single_agent and not args.skip_auto:
        print("# single-agent: implying skip-auto (no Auto stand-by phase)")
    if skip_auto:
        print("# skip-auto: skipping Auto stand-by phase; selecting target model directly")
    else:
        print(f"# auto prompt: {prompt!r}")
    if args.single_agent:
        print("# single-agent: MCP prompt will omit agent_id (shared General queue)")

    if args.keep_tiles:
        print("keep-tiles: leaving existing agent tiles intact — accumulating a new agent")
    else:
        prepare(ws)

    idx = split(ws)
    print(f"[t+{elapsed():.1f}s] split done — new tile {idx}")
    idx, agent_id = run_phase(ws, prompt, idx, args.model, skip_auto=skip_auto)
    print(
        f"[t+{elapsed():.1f}s] "
        + ("skip-auto model select done" if skip_auto else "auto phase + model select done")
    )

    ok, agent_id, _ = prime_mcp(
        ws, idx, type_text, args.enter_interval, args.max_secs,
        agent_id=agent_id, preferred_id=args.agent_id,
        single_agent=args.single_agent,
    )
    if not ok:
        fail("MCP connection not confirmed", {"agent_id": agent_id})
    route = "shared queue" if args.single_agent else f"agent {agent_id}"
    print(f"workflow: MCP connected in {elapsed():.1f}s ({route})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt", nargs="?")
    ap.add_argument("--enter-interval", type=float, default=0,
                    help="seconds between held Enter autorepeat ticks after the "
                         "initial 500ms delay (0 = OS human rate ~31ms; set e.g. "
                         "0.12 to pace slower)")
    ap.add_argument("--max-secs", type=float, default=6000.0,
                    help="safety cap for the continuous Enter hold in seconds "
                         "(default 6000; 0 = unlimited)")
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
    ap.add_argument("--skip-auto", dest="skip_auto", action="store_true",
                    help="Skip phase 1 (select Auto + stand-by turn). Select the "
                         "target --model immediately, then go straight to MCP "
                         "priming. Implied by --reconnect (agent id already known).")
    ap.add_argument("--reconnect", action="store_true",
                    help="Reconnect mode: re-prime a dropped ('worked') tile in "
                         "place (no Ctrl+D split). Implies skip-auto: select "
                         "--model on the existing tile, then MCP prime.")
    ap.add_argument("--tile", type=int, default=None,
                    help="Target tile index for --reconnect (default: auto-detect "
                         "the dropped tile)")
    ap.add_argument("--agent-id", dest="agent_id", default=None,
                    help="Stable Cursor agentId for this tile. On spawn it's "
                         "injected into the MCP prompt so the agent passes it back "
                         "on every jefr call (auto-read from the tile's React fiber "
                         "if omitted). On --reconnect it selects which tile to "
                         "re-prime (preferred over --tile / auto-detect). "
                         "Ignored for prompt injection when --single-agent is set.")
    ap.add_argument("--single-agent", dest="single_agent", action="store_true",
                    help="Single-agent / shared-queue mode: do NOT inject agent_id "
                         "into the MCP prompt. The agent uses the shared General "
                         "queue (omit agent_id on jefr tool calls). Heartbeat "
                         "checks use the root agent-alive.json. Implies "
                         "--skip-auto (no Auto stand-by — select --model then "
                         "MCP-prime immediately). Tile focus still uses the "
                         "fiber id when known.")
    args = ap.parse_args()

    t0 = time.time()

    def elapsed():
        return time.time() - t0

    type_text = args.type_text or mcp_prompt()

    ws = connect()
    print(f"[t+{elapsed():.1f}s] connected to workbench")
    snap(ws, "initial")

    if args.reconnect:
        run_reconnect_flow(ws, args, type_text, elapsed)
    else:
        run_spawn_flow(ws, args, type_text, elapsed)


if __name__ == "__main__":
    main()
