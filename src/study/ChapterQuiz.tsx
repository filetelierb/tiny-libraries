import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react';
import type { Attempt, PublicLearning, Source, Segment } from '../../shared/domain';
import { reviewSummary } from '../../shared/domain';
import { chapterRuns, type StudyChapter } from '../../shared/chapters';
import { api } from '../api';
import { Badge, Button, Modal } from '../design/components';
import type { T } from '../i18n';
import {
  newQuizDraft,
  quizDraftKey,
  readQuizDraft,
  saveQuizDraft,
  type QuizDraft,
} from './quizDrafts';

export type ChapterQuizRequest = {
  source: Source;
  learning: PublicLearning;
  chapter: StudyChapter;
  wasPlaying: boolean;
};
export function ChapterQuiz({
  request,
  sessionId,
  attempts,
  onAttempt,
  close,
  cite,
  t,
}: {
  request: ChapterQuizRequest;
  sessionId: string;
  attempts: Attempt[];
  onAttempt: (attempt: Attempt) => void;
  close: (resume: boolean) => void;
  cite: (segment: Segment) => void;
  t: T;
}) {
  const { source, learning, chapter } = request,
    key = quizDraftKey(sessionId, learning, chapter),
    questions = chapter.questions;
  const [draft, setDraft] = useState<QuizDraft>(() => {
    const saved = readQuizDraft(key);
    const value = saved && !saved.completed ? saved : newQuizDraft(chapter);
    saveQuizDraft(key, value);
    return value;
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [results, setResults] = useState<Attempt[]>(() =>
      attempts.filter((a) => Object.values(draft.requests).includes(a.id)),
    ),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [checking, setChecking] = useState(0);
  const pendingRef = useRef(false);
  useEffect(() => {
    const ids = new Set(Object.values(draft.requests));
    setResults((current) => [
      ...new Map(
        [...current, ...attempts].filter((a) => ids.has(a.id)).map((a) => [a.id, a]),
      ).values(),
    ]);
  }, [attempts, draft.id]);
  const update = (value: QuizDraft) => {
    draftRef.current = value;
    setDraft(value);
    saveQuizDraft(key, value);
  };
  const resultByQuestion = new Map(results.map((a) => [a.questionId, a]));
  const complete = questions.length > 0 && questions.every((q) => resultByQuestion.has(q.id));
  const index = Math.min(draft.index, Math.max(0, questions.length - 1)),
    question = questions[index];
  const allAnswered = questions.every((q) =>
    q.kind === 'short'
      ? typeof draft.answers[q.id] === 'string' && String(draft.answers[q.id]).trim().length > 0
      : typeof draft.answers[q.id] === 'number',
  );
  const finish = async () => {
    if (pendingRef.current || !allAnswered) return;
    pendingRef.current = true;
    setPending(true);
    setError('');
    update({ ...draftRef.current, locked: true });
    try {
      const values = [...results];
      for (const [i, q] of questions.entries()) {
        setChecking(i + 1);
        if (values.some((a) => a.id === draftRef.current.requests[q.id])) continue;
        const answer = draftRef.current.answers[q.id];
        const value = await api<Attempt>('/attempts', 'POST', {
          sourceId: source.id,
          sourceVersion: source.version,
          learningVersion: learning.createdAt,
          chapterId: chapter.id,
          runId: draftRef.current.id,
          questionId: q.id,
          requestId: draftRef.current.requests[q.id],
          ...(q.kind === 'short' ? { answer } : { selected: answer }),
        });
        values.push(value);
        setResults([...values]);
        onAttempt(value);
      }
      update({ ...draftRef.current, completed: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  useEffect(() => {
    if (complete && !draftRef.current.completed) update({ ...draftRef.current, completed: true });
  }, [complete]);
  const ungraded = results.filter((a) => a.pendingReview).length;
  const summary = reviewSummary(results),
    history = chapterRuns(attempts, learning, chapter).filter((run) => run.id !== draft.id);
  return (
    <Modal title={t.quiz} close={() => close(false)} closeLabel={t.closeQuiz}>
      <div className="chapter-quiz-heading">
        <Badge>{source.name}</Badge>
        <h3>{chapter.title}</h3>
      </div>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {complete ? (
        <div className="chapter-quiz-results">
          <h3>
            {summary.percent == null ? t.needsReview : `${summary.percent}% · ${t.quizAccuracy}`}
          </h3>
          <p>
            {summary.correct} / {summary.count} {t.gradedAnswers}
            {ungraded ? ` · ${ungraded} ${t.needsReview}` : ''}
          </p>
          {questions.map((q, i) => {
            const result = resultByQuestion.get(q.id)!;
            return (
              <section className="quiz-card" key={q.id}>
                <h4>
                  {i + 1}. {q.prompt}
                </h4>
                <p>
                  <strong>{t.yourAnswer}:</strong>{' '}
                  {q.kind === 'short' ? result.answer : q.choices[result.selected]}
                </p>
                <div
                  className={`quiz-result ${result.pendingReview ? 'pending' : result.correct ? 'correct' : 'incorrect'}`}
                >
                  <strong>
                    {result.pendingReview
                      ? t.needsReview
                      : result.correct
                        ? t.correct
                        : t.incorrect}
                  </strong>
                  <p>{result.explanation}</p>
                </div>
                <div className="citations" aria-label={t.sources}>
                  {q.segmentIds.map((id) => {
                    const s = learning.segments.find((s) => s.id === id);
                    return (
                      s && (
                        <button key={id} onClick={() => cite(s)}>
                          {s.page
                            ? `${t.page} ${s.page}`
                            : s.start != null
                              ? `${Math.floor(s.start)}s`
                              : id}
                        </button>
                      )
                    );
                  })}
                </div>
              </section>
            );
          })}
          <div className="modal-actions">
            <Button variant="primary" onClick={() => close(true)}>
              {t.continueStudying}
            </Button>
            <Button
              onClick={() => {
                const value = newQuizDraft(chapter);
                update(value);
                setResults([]);
                setError('');
              }}
            >
              {t.repeatQuiz}
            </Button>
          </div>
        </div>
      ) : question ? (
        <>
          <p className="muted">
            {t.quizQuestion} {index + 1} {t.of} {questions.length}
          </p>
          <progress className="quiz-progress" value={index + 1} max={questions.length} />
          <fieldset className="chapter-question" disabled={draft.locked || pending}>
            <legend>{question.prompt}</legend>
            {question.kind === 'short' ? (
              <textarea
                aria-label={t.writtenAnswer}
                maxLength={4000}
                value={String(draft.answers[question.id] || '')}
                onChange={(e) =>
                  update({
                    ...draftRef.current,
                    answers: { ...draftRef.current.answers, [question.id]: e.target.value },
                  })
                }
              />
            ) : (
              <div className="quiz-options">
                {question.choices.map((choice, i) => (
                  <label className={draft.answers[question.id] === i ? 'chosen' : ''} key={i}>
                    <input
                      type="radio"
                      name={`quiz-${draft.id}-${question.id}`}
                      checked={draft.answers[question.id] === i}
                      onChange={() =>
                        update({
                          ...draftRef.current,
                          answers: { ...draftRef.current.answers, [question.id]: i },
                        })
                      }
                    />
                    <span>
                      {String.fromCharCode(65 + i)}. {choice}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="chapter-quiz-navigation">
            <Button
              variant="ghost"
              disabled={!index || pending}
              onClick={() => update({ ...draftRef.current, index: index - 1 })}
            >
              <ChevronLeft size={14} />
              {t.quizPrevious}
            </Button>
            {index < questions.length - 1 ? (
              <Button
                disabled={pending}
                onClick={() => update({ ...draftRef.current, index: index + 1 })}
              >
                {t.quizNext}
                <ChevronRight size={14} />
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={pending || !allAnswered}
                onClick={() => void finish()}
              >
                {pending && <LoaderCircle size={14} className="spin" />}
                {pending
                  ? `${t.checkingAnswers} ${checking}/${questions.length}`
                  : draft.locked
                    ? t.retryFinish
                    : t.finishQuiz}
              </Button>
            )}
          </div>
          {draft.locked && !pending && <p className="muted">{t.quizRetryNotice}</p>}
          <Button variant="ghost" disabled={pending} onClick={() => close(true)}>
            {t.skipQuiz}
          </Button>
        </>
      ) : (
        <p>{t.noQuestions}</p>
      )}
      {!!history.length && (
        <details className="quiz-history">
          <summary>
            {t.previousQuizAttempts} ({history.length})
          </summary>
          {history.map((run) => {
            const summary = reviewSummary(run.attempts);
            return (
              <section className="quiz-history-run" key={run.id}>
                <h4>
                  {t.quizAttempt} · {new Date(run.createdAt).toLocaleString()}
                </h4>
                <p>
                  <strong>
                    {!run.complete
                      ? t.quizIncomplete
                      : summary.percent == null
                        ? t.needsReview
                        : `${summary.percent}% · ${t.quizAccuracy}`}
                  </strong>{' '}
                  · {summary.correct}/{summary.count} {t.gradedAnswers}
                </p>
                {run.attempts.map((a) => (
                  <div key={a.id}>
                    <strong>{a.question?.prompt || a.concept}</strong>
                    <p>
                      {t.yourAnswer}:{' '}
                      {a.answer ??
                        a.question?.choices[a.selected] ??
                        String.fromCharCode(65 + a.selected)}
                    </p>
                    <p>
                      {a.pendingReview ? t.needsReview : a.correct ? t.correct : t.incorrect} ·{' '}
                      {a.explanation}
                    </p>
                  </div>
                ))}
              </section>
            );
          })}
        </details>
      )}
    </Modal>
  );
}
