# Cursor Agents Automation over CDP



Drive the **Cursor Agents** window from an external Python process using the Chrome

DevTools Protocol (CDP). No patching of Cursor — input is delivered as **trusted**

events (`isTrusted: true`) so it passes Cursor's strict keybinds (e.g. the Ctrl+D

tile split).



All automation lives in **`jefr-cursor/automation/`** — the jefr extension resolves

`workflow.py` only from this folder (bundled next to the extension or open workspace).



## Requirements



- Cursor launched with the remote debugging port:



  ```powershell

  Stop-Process -Name Cursor -Force; Start-Sleep 2

  Start-Process "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe" `

    -ArgumentList '--remote-debugging-port=9222','--remote-allow-origins=*'

  ```



  Verify: `http://127.0.0.1:9222/json/list` returns a JSON array of targets.



- Python dependency:



  ```bash

  pip install websocket-client

  ```



## Files



| File | Purpose |

|---|---|

| `cdp.py` | Raw CDP client + helpers: `--list`, `--status`, `--eval`, `--file`, `--key`, plus `click_at`, `hold_key`, `send_chord` |

| `workflow.py` | Full end-to-end runner (split → Auto → prompt → Opus Extra High → type MCP prompt → hold Enter until connected) |

| `mcp_alive.py` | Filesystem heartbeat check (`--agent-id` for per-agent MCP loop) |

| `batch_run.py` | Spawn N tiles and log time-to-MCP-connected |

| `tile_helpers.js` | Model picker, tiles(), agentId pinning, Opus tier selection |

| `workflow.js` | In-page phase: Auto → prompt → target model |



## workflow.py



Runs from any directory (imports resolve relative to this file):



```bash

python automation/workflow.py

```



Filtered output:



```bash

python automation/workflow.py 2>&1 \

  | rg "agent_id|targetModel|typed|real click|baseline|mcp_connected|hold_key|menu still"

```



### What it does



1. **connect** — picks the `[CHAT]` workbench page (`.tiptap.ProseMirror`), titled *Cursor Agents*.

2. **prepare** — best-effort collapse of extra tiles back to the base tile (non-fatal).

3. **split** — always a trusted **Ctrl+D**; the new tile's index is detected dynamically (last tile).

4. **phase** — on the new tile: select **Auto**, type + send the **auto prompt**, wait for a response, then switch to **Opus 4.8 1M Extra High Fast** (default; override with `--model`).

5. **type** — types the **MCP prompt** into the live **Send follow-up** composer (injects `agent_id` for multi-agent routing).

6. **hold Enter** — focus composer, hold Enter (never released): **phase 1** stops when planning clears (single-agent submit borrow); **phase 2** stops when the tile is **connected to the jefr MCP loop** (CDP + `agents/<id>/agent-alive.json` heartbeat).



### Options



| Flag | Default | Meaning |

|---|---|---|

| `prompt` (positional) | timestamped *stand-by* prompt | the auto-phase prompt |

| `--model` | `Opus 4.8 1M Extra High Fast` | model to select after Auto phase |

| `--type-text` | improvised *invoke-mcp* prompt | MCP prompt typed before Enter hold |

| `--agent-id` | read from tile fiber | stable Cursor agentId for multi-agent routing |

| `--enter-interval` | `0` | seconds between held Enter autorepeat ticks after 500ms initial delay (0 = OS human ~31ms) |

| `--max-secs` | `600` | safety cap for Enter hold (10 min); `0` = unlimited |

| `--reconnect` | off | re-prime a dropped tile in place (no split) |



### Key design notes



- **Multi-agent:** spawn injects `agent_id` once; each jefr MCP call should pass it back so heartbeats land in `agents/<id>/`.

- **Real mouse click** into the follow-up composer before holding Enter.

- **Hold Enter:** one initial `keyDown`, ~500ms OS repeat delay, then autorepeat
  keyDowns at ~31ms with `text:"\r"`. Phase 2 sends `keyUp` once MCP is connected.

- **Model pick:** prefers the fully-labelled **Extra High Fast** row in the picker; falls back to Edit submenu (1M → Extra High → Fast).



## cdp.py



```bash

cd automation

python cdp.py --list            # page targets; [CHAT] = workbench with composer

python cdp.py --status          # tiles, models, generating/planning state

python cdp.py --eval "1+1"      # evaluate JS in the workbench page

python cdp.py --file script.js  # evaluate a JS file

python cdp.py --key Control+d   # trusted Ctrl+D split only

python mcp_alive.py --agent-id <uuid>  # per-agent MCP heartbeat check

```



## Troubleshooting



- **`no CDP workbench`** — Cursor isn't running with the debug flag, or the Agents window is closed.

- **Wrong workflow script** — extension log should show `.../jefr-cursor/automation/workflow.py`, not any other path.

- **`model not found`** — soft-fail; the run continues with the current model.

- **`MCP connection not confirmed`** — tile never reached `check_messages` with a per-agent heartbeat; check `agent_id` routing.


