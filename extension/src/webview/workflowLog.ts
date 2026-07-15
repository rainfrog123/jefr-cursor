/**
 * Pretty-print / filter the raw workflow.py stdout for the Agent workflow panel.
 * Python stays verbose; this only changes what the UI shows by default.
 */

export interface WorkflowLine {
  stream: "stdout" | "stderr";
  line: string;
}

export interface WorkflowDisplayLine {
  stream: "stdout" | "stderr";
  /** Human-readable stage / summary line. */
  text: string;
  /** Visual weight for CSS. */
  kind: "stage" | "ok" | "warn" | "err" | "meta" | "detail";
}

/** True for continuation lines of a pretty-printed JSON dump. */
function isJsonDumpContinuation(line: string): boolean {
  const t = line.trimStart();
  if (!t) return false;
  // Indented object/array guts from `json.dumps(..., indent=2)`.
  if (/^\s{2,}/.test(line) && /^["[{}\]\d-]/.test(t)) return true;
  if (/^\s*[}\]],?\s*$/.test(line)) return true;
  return false;
}

/** Shorten a model / agent id for the narrow panel. */
function shortId(id: string): string {
  const m = id.trim();
  if (m.length <= 10) return m;
  return m.slice(0, 8);
}

function cleanModel(s: string): string {
  return s.replace(/[\u200b\u200c\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Map one raw workflow line to zero or more display lines.
 * Returns null to hide the line entirely.
 */
export function formatWorkflowLine(
  stream: "stdout" | "stderr",
  line: string,
): WorkflowDisplayLine[] | null {
  const raw = line.replace(/\r$/, "");
  const t = raw.trim();
  if (!t) return null;

  // Hide JSON dump bodies / CDP snapshots entirely.
  if (isJsonDumpContinuation(raw)) return null;
  if (/^CDP \[/.test(t)) return null;
  if (/^phase:\s*\{/.test(t)) return null;
  if (/^prepare:\s*\{/.test(t)) return null;
  if (/^reconnect prep:\s*\{/.test(t)) return null;
  if (/^detect:\s*\[/.test(t)) return null;

  // Low-level CDP / hold noise.
  if (/^real click at /.test(t)) return null;
  if (/^hold_key:/.test(t)) return null;
  if (/^baseline:/.test(t)) return null;
  if (/^typed /.test(t)) return null;
  if (/^hold Enter continuously/.test(t)) {
    return [{ stream, text: "Holding Enter until MCP connects…", kind: "stage" }];
  }
  if (/^hold_presses=/.test(t)) return null;
  if (/^mcp heartbeat:/.test(t)) {
    const live = /"verdict":\s*"LIVE/i.test(t) || /"alive":\s*true/i.test(t);
    if (live) {
      return [{ stream, text: "MCP heartbeat live", kind: "ok" }];
    }
    return null;
  }
  if (/^mcp heartbeat timeout/.test(t)) {
    return [{ stream, text: "MCP heartbeat timed out", kind: "warn" }];
  }

  // Host / jefr chrome.
  if (/^\[jefr\] workflow script:/.test(t)) return null;
  if (/^\[jefr\] \$ /.test(t)) return null;
  if (/^\[jefr\] refreshed \d+ models/.test(t)) {
    return [{ stream, text: t.replace(/^\[jefr\]\s*/, ""), kind: "meta" }];
  }
  if (/^\[jefr\] workflow exited with code/.test(t)) {
    const code = t.match(/code\s+(\S+)/)?.[1] ?? "?";
    const ok = code === "0";
    return [
      {
        stream,
        text: ok ? "Done" : `Exited with code ${code}`,
        kind: ok ? "ok" : "err",
      },
    ];
  }
  if (/^\[jefr\] agent .+ connected in /.test(t)) {
    const m = t.match(/agent\s+(\S+)\s+connected in\s+([\d.]+s)/i);
    if (m) {
      return [
        {
          stream,
          text: `Agent ${shortId(m[1])} connected in ${m[2]}`,
          kind: "ok",
        },
      ];
    }
  }
  if (/^\[jefr\]/.test(t)) {
    return [{ stream, text: t.replace(/^\[jefr\]\s*/, ""), kind: stream === "stderr" ? "err" : "meta" }];
  }

  // Stage markers from workflow.py
  if (/^# skip-auto:/.test(t) || /^# reconnect: skip-auto/.test(t)) {
    return [{ stream, text: "Skip Auto — select target model directly", kind: "stage" }];
  }
  if (/^# single-agent: implying skip-auto/.test(t)) {
    return [
      {
        stream,
        text: "Single agent — skip Auto (direct MCP)",
        kind: "stage",
      },
    ];
  }
  if (/^# single-agent:/.test(t)) {
    return [
      {
        stream,
        text: "Single agent — shared General queue (no agent_id in prompt)",
        kind: "stage",
      },
    ];
  }
  if (/^# auto prompt:/.test(t)) {
    return [{ stream, text: "Phase 1 · Auto stand-by", kind: "stage" }];
  }
  if (/^# page:/.test(t)) {
    return [{ stream, text: `Workbench · ${t.slice(8).trim()}`, kind: "meta" }];
  }
  if (/^# reconnect mode/.test(t)) {
    const id = t.match(/agent_id:\s*([^;]+)/)?.[1]?.trim();
    return [
      {
        stream,
        text: id ? `Reconnect · ${shortId(id)}` : "Reconnect",
        kind: "stage",
      },
    ];
  }
  if (/^# agent_id:/.test(t)) {
    const id = t.match(/agent_id:\s*([^;]+)/)?.[1]?.trim();
    const tile = t.match(/tile:\s*(\d+)/)?.[1];
    const parts = [
      id ? `Agent ${shortId(id)}` : null,
      tile != null ? `tile ${tile}` : null,
    ].filter(Boolean);
    return [{ stream, text: parts.join(" · "), kind: "detail" }];
  }
  if (/^# mcp prompt:/.test(t)) {
    return [{ stream, text: "Phase 2 · MCP prime", kind: "stage" }];
  }

  if (/^keep-tiles:/.test(t)) {
    return [{ stream, text: "Keep existing agents", kind: "detail" }];
  }
  if (/^split: Ctrl\+D/.test(t)) {
    return [{ stream, text: "Splitting new tile…", kind: "stage" }];
  }
  if (/^split: new tile index/.test(t)) {
    const idx = t.match(/index\s*=\s*(\d+)/)?.[1];
    const n = t.match(/tiles now=(\d+)/)?.[1];
    return [
      {
        stream,
        text: `New tile ${idx ?? "?"}${n ? ` (${n} total)` : ""}`,
        kind: "ok",
      },
    ];
  }

  if (/^\[t\+/.test(t)) {
    // "[t+19.0s] auto phase + model select done"
    const m = t.match(/^\[t\+([\d.]+)s\]\s*(.+)$/);
    if (m) {
      const secs = m[1];
      let msg = m[2];
      if (/connected to workbench/i.test(msg)) msg = "Connected to workbench";
      else if (/split done/i.test(msg)) {
        const tile = msg.match(/tile\s+(\d+)/)?.[1];
        msg = tile ? `Split done · tile ${tile}` : "Split done";
      } else if (/reconnect skip-auto model select done/i.test(msg)) {
        msg = "Reconnect · model selected (skipped Auto)";
      } else if (/skip-auto model select done/i.test(msg)) {
        msg = "Model selected (skipped Auto)";
      } else if (/auto phase \+ model select done/i.test(msg)) {
        msg = "Auto stand-by + model select done";
      }
      return [{ stream, text: `${msg} · ${secs}s`, kind: "ok" }];
    }
  }

  if (/^workflow: MCP connected in /.test(t) || /^workflow: reconnected MCP in /.test(t)) {
    const shared = t.match(/in\s+([\d.]+)s\s+\(shared queue\)/i);
    if (shared) {
      return [
        {
          stream,
          text: `MCP connected in ${shared[1]}s · shared queue`,
          kind: "ok",
        },
      ];
    }
    const m = t.match(/in\s+([\d.]+)s\s+\(agent\s+([^)]+)\)/i);
    if (m) {
      return [
        {
          stream,
          text: `MCP connected in ${m[1]}s · ${shortId(m[2])}`,
          kind: "ok",
        },
      ];
    }
    return [{ stream, text: t.replace(/^workflow:\s*/, ""), kind: "ok" }];
  }
  if (/^workflow: MCP connected/.test(t)) {
    return [{ stream, text: "MCP connected — Enter released", kind: "ok" }];
  }

  if (/^reconnect:/.test(t)) {
    return [{ stream, text: t, kind: "detail" }];
  }
  if (/^WARN:/.test(t)) {
    return [{ stream, text: t.replace(/^WARN:\s*/, ""), kind: "warn" }];
  }
  if (/^ERROR:/.test(t) || stream === "stderr") {
    return [{ stream, text: t.replace(/^ERROR:\s*/, ""), kind: "err" }];
  }

  // Fallback: show non-JSON leftovers as detail (still quieter than raw).
  if (t.startsWith("{") || t.startsWith("[")) return null;
  return [{ stream, text: t, kind: "detail" }];
}

/** Convert a raw log buffer into display lines (clean mode). */
export function formatWorkflowLog(raw: WorkflowLine[]): WorkflowDisplayLine[] {
  const out: WorkflowDisplayLine[] = [];
  for (const l of raw) {
    const mapped = formatWorkflowLine(l.stream, l.line);
    if (!mapped) continue;
    out.push(...mapped);
  }
  return out;
}

/** Optional: extract model from a spawn command line for a header (unused helper). */
export function modelFromCommandLine(line: string): string | null {
  const m = line.match(/--model\s+"([^"]+)"|--model\s+(\S+)/);
  if (!m) return null;
  return cleanModel(m[1] || m[2] || "");
}
