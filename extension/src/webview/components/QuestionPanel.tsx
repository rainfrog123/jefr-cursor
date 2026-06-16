/**
 * AI question panel. Shown when the agent calls `ask_question`.
 *
 * Renders each question with single- or multi-select options plus an optional
 * free-text "Other" field, then submits an `AnswerData` payload.
 *
 * Note: pressing Enter to submit is handled by an appended runtime script in
 * the built bundle; the Submit button here is the canonical action.
 */
import React, { useMemo, useState } from "react";
import { post } from "../vscode";
import type { AnswerData, QuestionData } from "../types";

export function QuestionPanel(props: { question: QuestionData }): JSX.Element {
  const { question } = props;

  // selected[questionId] = array of chosen option ids
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  // other[questionId] = free text
  const [other, setOther] = useState<Record<string, string>>({});

  const toggle = (qid: string, oid: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qid] || [];
      if (multi) {
        return {
          ...prev,
          [qid]: cur.includes(oid) ? cur.filter((x) => x !== oid) : [...cur, oid],
        };
      }
      return { ...prev, [qid]: [oid] };
    });
  };

  const submit = () => {
    const data: AnswerData = {
      id: question.id,
      answers: question.questions.map((qi) => ({
        questionId: qi.id,
        selected: selected[qi.id] || [],
        other: (other[qi.id] || "").trim(),
      })),
    };
    post({ type: "submitAnswer", data });
  };

  const cancel = () => post({ type: "cancelQuestion" });

  // Enter submits (Shift+Enter makes a newline inside the textarea, which we
  // never use here, so plain Enter anywhere in the panel submits).
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="question-panel" onKeyDown={onKeyDown}>
      <h4>AI question</h4>
      {question.questions.map((qi) => {
        const multi = !!qi.allow_multiple;
        return (
          <div className="question-item" key={qi.id}>
            <div className="question-text">{qi.question}</div>
            <div className="options">
              {qi.options.map((opt) => {
                const isOn = (selected[qi.id] || []).includes(opt.id);
                return (
                  <label className="option" key={opt.id}>
                    <input
                      type={multi ? "checkbox" : "radio"}
                      name={qi.id}
                      checked={isOn}
                      onChange={() => toggle(qi.id, opt.id, multi)}
                    />
                    <span>{opt.label}</span>
                  </label>
                );
              })}
            </div>
            <input
              className="other-input"
              placeholder="Additional notes (optional)"
              value={other[qi.id] || ""}
              onChange={(e) => setOther((p) => ({ ...p, [qi.id]: e.target.value }))}
            />
          </div>
        );
      })}
      <div className="question-actions">
        <button className="btn btn-secondary btn-small" onClick={cancel}>
          Cancel
        </button>
        <button className="btn btn-primary btn-small" onClick={submit}>
          Submit answer
        </button>
      </div>
    </div>
  );
}
