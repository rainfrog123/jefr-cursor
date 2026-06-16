/**
 * Font-size scaling for the panel.
 *
 * Scales the root `--text-*` CSS variables by a factor and persists the choice
 * in localStorage. Used by the A- / % / A+ controls in the header.
 */
const BASE: Record<string, number> = {
  "--text-xs": 12,
  "--text-sm": 13,
  "--text-base": 14,
  "--text-md": 15,
  "--text-lg": 16,
};

export const FONT_MIN = 0.8;
export const FONT_MAX = 2.0;
export const FONT_STEP = 0.1;
const KEY = "jefrFontScale";

export function loadScale(): number {
  try {
    const s = parseFloat(localStorage.getItem(KEY) || "");
    if (s && !isNaN(s)) return clampScale(s);
  } catch {
    /* ignore */
  }
  return 1;
}

export function clampScale(v: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(v * 100) / 100));
}

export function applyScale(scale: number): void {
  const root = document.documentElement;
  for (const k of Object.keys(BASE)) {
    root.style.setProperty(k, (BASE[k] * scale).toFixed(2) + "px");
  }
  try {
    localStorage.setItem(KEY, String(scale));
  } catch {
    /* ignore */
  }
}
