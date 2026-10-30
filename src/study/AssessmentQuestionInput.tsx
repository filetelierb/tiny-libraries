import { Fragment, useState, type DragEvent } from 'react';
import { X } from 'lucide-react';
import {
  blankAssessmentResponse,
  matchingAssessmentResponse,
  type PublicAssessmentQuestion,
} from '../../shared/assessments';
import type { T } from '../i18n';

export function AssessmentQuestionInput({
  question,
  response,
  change,
  disabled,
  t,
}: {
  question: PublicAssessmentQuestion;
  response: string;
  change: (value: string) => void;
  disabled: boolean;
  t: T;
}) {
  const q = question;
  if (q.type === 'matching') {
    const values = matchingAssessmentResponse(response),
      used = new Set(Object.values(values));
    return (
      <fieldset className="assessment-matching" disabled={disabled}>
        <legend>{q.prompt}</legend>
        <p className="muted">{t.assessmentMatchingHint}</p>
        <ul className="assessment-term-bank" aria-label={t.assessmentOptions}>
          {q.options.map((o) => (
            <li key={o.id}>
              {o.text}
              {used.has(o.id) ? ` · ${t.assessmentAssigned}` : ''}
            </li>
          ))}
        </ul>
        {q.prompts.map((p, index) => (
          <label key={p.id} className="assessment-match-row">
            <span>
              {index + 1}. {p.text}
            </span>
            <select
              aria-label={`${t.assessmentAnswerFor} ${p.text}`}
              value={values[p.id] || ''}
              onChange={(event) => {
                const next = { ...values };
                if (event.target.value) next[p.id] = event.target.value;
                else delete next[p.id];
                change(Object.keys(next).length ? JSON.stringify(next) : '');
              }}
            >
              <option value="">{t.assessmentUnanswered}</option>
              {q.options.map((o) => (
                <option key={o.id} value={o.id} disabled={used.has(o.id) && values[p.id] !== o.id}>
                  {o.text}
                </option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>
    );
  }
  if (q.type === 'fill_blank')
    return (
      <FillBlanks question={q} response={response} change={change} disabled={disabled} t={t} />
    );
  return (
    <fieldset className="assessment-choice" disabled={disabled}>
      <legend>{q.prompt}</legend>
      {q.options.map((o, index) => (
        <label key={o.id} className={response === o.id ? 'selected' : ''}>
          <input
            type="radio"
            name={`assessment-${q.id}`}
            value={o.id}
            checked={response === o.id}
            onChange={() => change(o.id)}
          />
          <span>
            {q.type === 'true_false' ? '' : `${String.fromCharCode(65 + index)}. `}
            {o.text}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * Blanks filled from a word bank: clicking a word fills the chosen blank (or the next empty one),
 * and words can be dragged onto a blank, between blanks or back to the bank.
 */
function FillBlanks({
  question: q,
  response,
  change,
  disabled,
  t,
}: {
  question: PublicAssessmentQuestion;
  response: string;
  change: (value: string) => void;
  disabled: boolean;
  t: T;
}) {
  const values = blankAssessmentResponse(q, response),
    parts = q.prompt.split('____'),
    [target, setTarget] = useState<number | null>(null),
    [over, setOver] = useState<number | 'bank' | null>(null);
  const word = (id: string) => q.options.find((o) => o.id === id)?.text || '';
  function save(next: string[]) {
    change(next.some(Boolean) ? JSON.stringify(next) : '');
  }
  function place(optionId: string, blank: number) {
    const next = [...values],
      from = next.indexOf(optionId);
    // Dropping a placed word on another blank swaps the two.
    if (from >= 0) next[from] = next[blank];
    next[blank] = optionId;
    save(next);
  }
  function pick(optionId: string) {
    const blank = target !== null && !values[target] ? target : values.indexOf('');
    if (blank < 0) return;
    place(optionId, blank);
    setTarget(null);
  }
  function clear(blank: number) {
    save(values.map((v, i) => (i === blank ? '' : v)));
  }
  const dropProps = (zone: number | 'bank') => ({
    onDragOver: (e: DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      setOver(zone);
    },
    onDragLeave: () => setOver((current) => (current === zone ? null : current)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(null);
      const optionId = e.dataTransfer.getData('text/x-assessment-option');
      if (disabled || !q.options.some((o) => o.id === optionId)) return;
      if (zone === 'bank') {
        const from = values.indexOf(optionId);
        if (from >= 0) clear(from);
      } else place(optionId, zone);
    },
  });
  const dragProps = (optionId: string) => ({
    draggable: !disabled,
    onDragStart: (e: DragEvent) => {
      e.dataTransfer.setData('text/x-assessment-option', optionId);
      e.dataTransfer.effectAllowed = 'move';
    },
  });
  return (
    <div className="assessment-fill" role="group" aria-label={t.assessmentCompleteSentence}>
      <p className="assessment-fill-sentence">
        {parts.map((part, i) => (
          <Fragment key={i}>
            {part}
            {i < values.length &&
              (values[i] ? (
                <span
                  className="assessment-blank filled"
                  data-over={over === i || undefined}
                  {...dropProps(i)}
                  {...dragProps(values[i])}
                >
                  <span>{word(values[i])}</span>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-label={`${t.remove}: ${word(values[i])}`}
                    onClick={() => clear(i)}
                  >
                    <X size={12} />
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="assessment-blank"
                  disabled={disabled}
                  aria-pressed={target === i}
                  aria-label={t.assessmentBlank.replace('{n}', String(i + 1))}
                  data-over={over === i || undefined}
                  onClick={() => setTarget(target === i ? null : i)}
                  {...dropProps(i)}
                />
              ))}
          </Fragment>
        ))}
      </p>
      <div
        className="assessment-word-bank"
        data-over={over === 'bank' || undefined}
        aria-label={t.assessmentWordBank}
        role="group"
        {...dropProps('bank')}
      >
        {q.options.map((o) => {
          const used = values.includes(o.id);
          return (
            <button
              key={o.id}
              type="button"
              className="assessment-word"
              disabled={disabled || used}
              data-used={used || undefined}
              onClick={() => pick(o.id)}
              {...(used ? {} : dragProps(o.id))}
            >
              {o.text}
            </button>
          );
        })}
      </div>
      <p className="muted">{t.assessmentFillHint}</p>
    </div>
  );
}
