/**
 * Chat tab: the scrollable send/reply history plus the composer (input area
 * with staged attachments, attach + send buttons).
 */
import React, { useEffect, useRef, useState } from "react";
import { post } from "../vscode";
import { renderMarkdown } from "../markdown";
import type { Attachment, HistoryItem } from "../types";

export function ChatTab(props: {
  history: HistoryItem[];
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  appendHistory: (item: Omit<HistoryItem, "index">) => void;
}): JSX.Element {
  return (
    <>
      <History items={props.history} />
      <Composer
        attachments={props.attachments}
        setAttachments={props.setAttachments}
        appendHistory={props.appendHistory}
      />
    </>
  );
}

/* ------------------------------- History -------------------------------- */

function History(props: { items: HistoryItem[] }): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the newest message in view whenever the history grows.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.items.length]);

  return (
    <div className="history" ref={listRef}>
      {props.items.map((item) => (
        <HistoryRow key={item.id} item={item} />
      ))}
    </div>
  );
}

function HistoryRow(props: { item: HistoryItem }): JSX.Element {
  const { item } = props;
  const classes =
    "history-item-v2" +
    (item.kind === "reply" ? " ai-reply" : "") +
    (item.kind === "image" ? " hi-image" : "") +
    (item.kind === "file" ? " hi-file" : "");

  return (
    <div className={classes}>
      <span className="hi-idx">{item.index ?? ""}</span>

      {item.kind === "image" && item.dataUrl ? (
        <div className="hi-media">
          <img className="hi-thumb" src={item.dataUrl} alt={item.name || "image"} />
          {item.caption && <span className="hi-caption">{item.caption}</span>}
        </div>
      ) : item.kind === "file" ? (
        <div className="hi-file">
          <span className="hi-file-badge">FILE</span>
          <span className="hi-file-name">{item.name || item.path}</span>
        </div>
      ) : item.kind === "reply" ? (
        // AI replies render Markdown.
        <span
          className="hi-text md-rendered"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text || "") }}
        />
      ) : (
        <span className="hi-text">{item.text}</span>
      )}

      {item.time && <span className="hi-time">{item.time}</span>}

      {/* Files can be re-sent to the agent queue. */}
      {item.kind === "file" && item.path && (
        <button
          className="hi-resend-btn"
          onClick={() => post({ type: "resendFile", path: item.path! })}
        >
          Resend
        </button>
      )}
    </div>
  );
}

/* ------------------------------- Composer ------------------------------- */

function makeId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return "att-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
}

function nowTime(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function Composer(props: {
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  appendHistory: (item: Omit<HistoryItem, "index">) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const taRef = useRef<HTMLTextAreaElement>(null);

  const canSend = text.trim().length > 0 || props.attachments.length > 0;

  // Paste support (Ctrl/Cmd+V): images are staged as attachments and files are
  // read into the composer. Nothing is sent until the user hits Send/Enter so
  // a paste never fires off a message on its own.
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const dt = e.clipboardData;
      if (!dt) return;

      const files: File[] = [];
      if (dt.files && dt.files.length) {
        files.push(...Array.from(dt.files));
      } else if (dt.items) {
        for (const it of Array.from(dt.items)) {
          if (it.kind === "file") {
            const f = it.getAsFile();
            if (f) files.push(f);
          }
        }
      }
      if (!files.length) return; // plain text → let the default paste happen

      e.preventDefault();
      for (const file of files) {
        if (file.type && file.type.startsWith("image/")) {
          const r = new FileReader();
          r.onload = (ev) => {
            const dataUrl = String(ev.target?.result || "");
            if (!dataUrl) return;
            props.setAttachments((list) => [
              ...list,
              {
                id: makeId(),
                type: "image",
                path: "",
                name: file.name || "pasted-image",
                dataUrl,
              },
            ]);
          };
          r.readAsDataURL(file);
        } else {
          const r = new FileReader();
          r.onload = (ev) => {
            const content = String(ev.target?.result || "");
            const preview =
              content.length > 500 ? content.slice(0, 500) + "..." : content;
            const snippet = "[File: " + file.name + "]\n" + preview;
            setText((prev) => (prev ? prev + "\n" + snippet : snippet));
          };
          r.readAsText(file);
        }
      }
    }

    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [props.setAttachments]);

  const send = () => {
    const trimmed = text.trim();
    const time = nowTime();

    if (trimmed) {
      post({ type: "sendText", text: trimmed });
      props.appendHistory({ id: makeId(), kind: "text", text: trimmed, time });
    }

    for (const a of props.attachments) {
      if (a.type === "image" && a.dataUrl) {
        post({ type: "sendPastedImage", dataUrl: a.dataUrl, caption: "" });
        props.appendHistory({
          id: makeId(),
          kind: "image",
          dataUrl: a.dataUrl,
          name: a.name,
          time,
        });
      } else {
        post({ type: "resendFile", path: a.path });
        props.appendHistory({
          id: makeId(),
          kind: "file",
          name: a.name,
          path: a.path,
          time,
        });
      }
    }

    setText("");
    props.setAttachments([]);
    taRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) send();
    }
  };

  return (
    <div className="input-area">
      {props.attachments.length > 0 && (
        <div className="compose-attachments pasted-images">
          {props.attachments.map((a) => (
            <div className="pasted-thumb" key={a.id}>
              {a.type === "image" && a.dataUrl ? (
                <img src={a.dataUrl} alt={a.name} />
              ) : (
                <span className="hi-file-name">{a.name}</span>
              )}
              <button
                className="remove-thumb"
                onClick={() =>
                  props.setAttachments((list) => list.filter((x) => x.id !== a.id))
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <textarea
        ref={taRef}
        className="input-box"
        placeholder="Type a message…  (Enter to send, Shift+Enter newline, paste/drop files & images)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />

      <div className="compose-toolbar">
        <div className="input-actions">
          <button
            className="compose-icon-btn"
            title="Attach file or image"
            onClick={() => post({ type: "pickAttachment" })}
          >
            +
          </button>
        </div>
        <button className="compose-send-btn" disabled={!canSend} onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}
