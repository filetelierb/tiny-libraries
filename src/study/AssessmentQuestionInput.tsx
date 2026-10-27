import {
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
  if (q.type === 'fill_blank' && q.difficulty !== 'easy') {
    const [before, after] = q.prompt.split('____');
    return (
      <div className="assessment-fill">
        <label>
          {before}
          {q.difficulty === 'hard' ? (
            <input
              aria-label={t.assessmentCompleteSentence}
              disabled={disabled}
              value={response}
              maxLength={300}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => change(e.target.value)}
            />
          ) : (
            <select
              aria-label={t.assessmentCompleteSentence}
              disabled={disabled}
              value={response}
              onChange={(e) => change(e.target.value)}
            >
              <option value="">{t.assessmentChooseTerm}</option>
              {q.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.text}
                </option>
              ))}
            </select>
          )}
          {after}
        </label>
        {q.difficulty === 'hard' && (
          <>
            <p className="muted">{t.assessmentTermBank}</p>
            <ul className="assessment-term-bank">
              {q.options.map((o) => (
                <li key={o.id}>{o.text}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }
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
