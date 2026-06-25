/**
 * Header pieces. The brand + version + font controls + Console now live on the
 * General tab (see BrandHeader); HeaderControls stays available inline in the
 * chat composer toolbar. FontScale is the shared A− / % / A+ control.
 */
import React, { useEffect, useState } from "react";
import {
  applyScale,
  clampScale,
  FONT_STEP,
  loadScale,
} from "../fontScale";

/** Segmented font-size control: A− · % · A+. Shared by the brand header and the
 *  chat composer toolbar so they stay visually identical. */
export function FontScale(): JSX.Element {
  const [scale, setScale] = useState<number>(() => loadScale());

  useEffect(() => {
    applyScale(scale);
  }, [scale]);

  const bump = (delta: number) => setScale((s) => clampScale(s + delta));

  return (
    <div className="fs-seg" role="group" aria-label="Font size">
      <button
        className="fs-seg-btn"
        title="Decrease font size"
        onClick={() => bump(-FONT_STEP)}
      >
        {"A\u2212"}
      </button>
      <button
        className="fs-seg-btn fs-pct"
        title="Reset font size"
        onClick={() => setScale(1)}
      >
        {Math.round(scale * 100) + "%"}
      </button>
      <button
        className="fs-seg-btn"
        title="Increase font size"
        onClick={() => bump(FONT_STEP)}
      >
        A+
      </button>
    </div>
  );
}

/** Controls cluster (font zoom + version + Console) — used inline in the chat
 *  composer toolbar. */
export function HeaderControls(props: {
  version: string;
  onOpenConsole: () => void;
}): JSX.Element {
  return (
    <div className="header-right">
      <FontScale />
      {props.version && <span className="version-tag">v{props.version}</span>}
      <button className="btn-console" onClick={props.onOpenConsole}>
        Console
      </button>
    </div>
  );
}

/** Branded header for the General tab: wordmark + version, font control, and the
 *  Console button — the home for the controls that used to sit in the footer. */
export function BrandHeader(props: {
  version: string;
  onOpenConsole: () => void;
}): JSX.Element {
  return (
    <div className="general-brand">
      <div className="general-brand-left">
        <span className="general-brand-mark" aria-hidden="true" />
        <span className="general-brand-name">jefr</span>
        {props.version && (
          <span className="general-brand-version">v{props.version}</span>
        )}
      </div>
      <div className="general-brand-actions">
        <FontScale />
        <button className="btn-console" onClick={props.onOpenConsole}>
          Console
        </button>
      </div>
    </div>
  );
}
