/** Models shown in Cursor's agent model picker (full-menu row labels).
 *
 *  These must match rows that actually exist in *this* account's picker — the
 *  workflow selects a model by matching this label against the live menu, so a
 *  label with no matching row silently falls back to the current model. The set
 *  below was validated against the live picker via `cdp.py --models`. If your
 *  enabled models change (Cursor's "Add Models"), update this list to match.
 */
export const WORKFLOW_MODELS = [
  "Composer 2.5 Fast",
  "GPT-5.5 Extra High Fast",
  "Opus 4.5",
  "Opus 4.8 1M Extra High Fast",
] as const;

export type WorkflowModel = (typeof WORKFLOW_MODELS)[number];

export const DEFAULT_WORKFLOW_MODEL: WorkflowModel = "Opus 4.8 1M Extra High Fast";
