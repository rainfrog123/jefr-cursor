/**
 * Top header: brand title, version tag, font-size controls (A- / % / A+),
 * and a button to open the local console.
 */
import React, { useEffect, useState } from "react";
import {
  applyScale,
  clampScale,
  FONT_STEP,
  loadScale,
} from "../fontScale";

export function Header(props: {
  version: string;
  onOpenConsole: () => void;
}): JSX.Element {
  const [scale, setScale] = useState<number>(() => loadScale());

  // Apply the scale to the document whenever it changes.
  useEffect(() => {
    applyScale(scale);
  }, [scale]);

  const bump = (delta: number) => setScale((s) => clampScale(s + delta));

  return (
    <div className="header">
      <h3>jefr</h3>
      <div className="header-right">
        <div className="jefr-fs-ctrl">
          <button
            className="jefr-fs-btn"
            title="Decrease font size"
            onClick={() => bump(-FONT_STEP)}
          >
            {"A\u2212"}
          </button>
          <button
            className="jefr-fs-label"
            title="Reset font size"
            onClick={() => setScale(1)}
          >
            {Math.round(scale * 100) + "%"}
          </button>
          <button
            className="jefr-fs-btn"
            title="Increase font size"
            onClick={() => bump(FONT_STEP)}
          >
            A+
          </button>
        </div>
        {props.version && <span className="version-tag">v{props.version}</span>}
        <button className="btn-console" onClick={props.onOpenConsole}>
          Console
        </button>
      </div>
    </div>
  );
}
