import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, Download, LoaderCircle, Play } from 'lucide-react';
import {
  validAssessmentResponse,
  type AssessmentDetail,
  type AssessmentSummary,
  type AssessmentAnswer,
  type Confidence,
} from '../../shared/assessments';
import type { Catalog, Segment } from '../../shared/domain';
import { api, ApiResponseError } from '../api';
import { Button } from '../design/components';
import { AttachmentInspector } from '../tutor/AttachmentInspector';
import type { T } from '../i18n';
import { AssessmentQuestionInput } from './AssessmentQuestionInput';
import { AssessmentCitations, AssessmentScope } from './AssessmentScope';
import {
  acknowledgeAssessmentAnswer,
  readAssessmentDraft,
  saveAssessmentDraft,
  type AssessmentDraft,
} from './assessmentDrafts';

export function AssessmentRun({
  id,
  sessionId,
  t,
  catalog,
  navigate,
  bookmark,
  changed,
  followup,
  summaryChanged,
  back,
}: {
  id: string;
  sessionId: string;
  t: T;
  catalog: Catalog;
  navigate: (sourceId: string, segment: Segment) => void;
  bookmark: (id: string) => void;
  changed: () => void;
  followup: (detail: AssessmentDetail) => void;
  summaryChanged: () => void;
  back: () => void;
}) {
  const storageKey = `tl:assessment-draft:${id}`;
  const [detail, setDetail] = useState<AssessmentDetail | null>(null),
    [draft, setDraft] = useState<AssessmentDraft>(
      () =>
        readAssessmentDraft(storageKey) || {
          step: 0,
          responses: {},
          operation: null,
          conflict: false,
        },
    ),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirmCancel, setConfirmCancel] = useState(false),
    [inspectedEvidence, setInspectedEvidence] = useState<{ id: string; imageId?: string } | null>(
      null,
    );
  const inspectEvidence = (id: string, imageId?: string) => setInspectedEvidence({ id, imageId });
  const local = useRef(draft),
    alive = useRef(true),
    pending = useRef(false),
    completed = useRef(false),
    signature = useRef('');
  function commit(value: AssessmentDraft) {
    local.current = value;
    saveAssessmentDraft(storageKey, value);
    if (alive.current) setDraft(value);
  }
  function accept(value: AssessmentDetail) {
    if (!alive.current) return;
    setDetail((current) => {
      if (!current) return value;
      const answers = new Map(value.answers.map((a) => [a.questionId, a]));
      for (const a of current.answers)
        if (a.revision > (answers.get(a.questionId)?.revision || 0)) answers.set(a.questionId, a);
      return { ...value, answers: [...answers.values()] };
    });
    if (value.status === 'completed' && !completed.current) {
      completed.current = true;
      changed();
    }
    signature.current = JSON.stringify([
      value.status,
      value.updatedAt,
      value.completedBatches,
      value.workActive,
    ]);
  }
  async function load() {
    const value = await api<AssessmentDetail>(`/assessments/${id}`);
    if (value.sessionId !== sessionId) throw new Error(t.assessmentWrongSession);
    if (alive.current) {
      accept(value);
      if (value.status === 'ready' && value.plan && !readAssessmentDraft(storageKey)) {
        const first = value.plan.questions.findIndex(
          (q) => !value.answers.some((a) => a.questionId === q.id),
        );
        commit({ ...local.current, step: first < 0 ? value.plan.questions.length - 1 : first });
      }
    }
    return value;
  }
  useEffect(() => {
    alive.current = true;
    void load().catch((e) => {
      if (alive.current) setError((e as Error).message);
    });
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!detail?.workActive && !['preparing', 'grading'].includes(detail?.status || '')) return;
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const summary = await api<AssessmentSummary>(`/assessments/${id}?view=summary`);
        const next = JSON.stringify([
          summary.status,
          summary.updatedAt,
          summary.completedBatches,
          summary.workActive,
        ]);
        if (live && next !== signature.current) {
          await load();
          summaryChanged();
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
      if (live) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 1500);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [detail?.status, detail?.workActive]);
  const questions = detail?.plan?.questions || [],
    step = Math.min(draft.step, Math.max(0, questions.length - 1)),
    question = questions[step],
    saved = detail?.answers.find((a) => a.questionId === question?.id),
    readOnly = detail?.status === 'cancelled',
    response = question
      ? readOnly
        ? saved?.response || ''
        : (draft.responses[question.id] ?? saved?.response ?? '')
      : '';
  const unsaved = readOnly
    ? 0
    : Object.entries(draft.responses).filter(
        ([id, value]) =>
          value !== (detail?.answers.find((a) => a.questionId === id)?.response || ''),
      ).length;
  const allAnswered =
    questions.length > 0 &&
    questions.every((q) => detail?.answers.some((a) => a.questionId === q.id));
  async function answer(confidence: Confidence) {
    if (!detail || !question || pending.current || draft.conflict) return;
    const operation = local.current.operation || {
      requestId: crypto.randomUUID(),
      questionId: question.id,
      expectedRevision: saved?.revision || 0,
      response: confidence === 'unknown' ? '' : response,
      confidence,
    };
    commit({ ...local.current, operation });
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<AssessmentAnswer>(`/assessments/${id}/answers`, 'POST', operation);
      if (alive.current)
        setDetail((current) => {
          if (!current) return current;
          const old = current.answers.find((a) => a.questionId === result.questionId);
          return old && old.revision > result.revision
            ? current
            : {
                ...current,
                answers: [
                  ...current.answers.filter((a) => a.questionId !== result.questionId),
                  result,
                ],
              };
        });
      const latest = readAssessmentDraft(storageKey) || local.current;
      const at = questions.findIndex((q) => q.id === result.questionId);
      commit(
        acknowledgeAssessmentAnswer(
          latest,
          operation.requestId,
          result,
          Math.min(at + 1, questions.length - 1),
        ),
      );
    } catch (e) {
      if (e instanceof ApiResponseError && [400, 404, 409].includes(e.status))
        commit({ ...local.current, conflict: true });
      if (alive.current) setError((e as Error).message);
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function action(value: 'finish' | 'retry' | 'cancel') {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api<AssessmentDetail>(`/assessments/${id}`, 'POST', { action: value });
      accept(result);
      setConfirmCancel(false);
      summaryChanged();
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  }
  if (!detail)
    return (
      <div className="assessment-loading">
        {error ? (
          <p role="alert" className="notice">
            {error}
          </p>
        ) : (
          <LoaderCircle className="spin" />
        )}
        <Button
          onClick={() => {
            setError('');
            void load().catch((e) => setError((e as Error).message));
          }}
        >
          {t.retry}
        </Button>
      </div>
    );
  const report = detail.report;
  return (
    <div className="assessment-run">
      <div className="assessment-run-header">
        <Button variant="ghost" size="sm" onClick={back}>
          <ChevronLeft size={14} />
          {t.assessmentHistory}
        </Button>
        <span className="assessment-history-status">{t[`assessmentStatus_${detail.status}`]}</span>
        {!['completed', 'cancelled'].includes(detail.status) && !confirmCancel && (
          <Button
            variant="ghost"
            size="sm"
            className="assessment-run-cancel"
            disabled={busy}
            onClick={() => setConfirmCancel(true)}
          >
            {t.assessmentCancel}
          </Button>
        )}
      </div>
      {confirmCancel && !['completed', 'cancelled'].includes(detail.status) && (
        <div className="notice assessment-cancel">
          <p>{t.assessmentCancelConfirm}</p>
          <Button variant="danger" disabled={busy} onClick={() => void action('cancel')}>
            {t.assessmentCancel}
          </Button>
          <Button disabled={busy} onClick={() => setConfirmCancel(false)}>
            {t.assessmentKeepWorking}
          </Button>
        </div>
      )}
      <div className="assessment-run-title">
        <h3>{detail.title || t.assessmentPreparing}</h3>
        <p className="muted">
          {new Date(detail.createdAt).toLocaleString()} · {detail.config.count}{' '}
          {t.assessmentQuestions} · {t[`assessmentDifficulty_${detail.config.difficulty}`]}
        </p>
      </div>
      {error && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      <AssessmentScope context={detail.context} t={t} inspect={inspectEvidence} />
      {detail.status === 'preparing' || detail.status === 'grading' ? (
        <div className="assessment-working" role="status">
          <LoaderCircle size={32} className="spin" />
          <p>{detail.status === 'preparing' ? t.assessmentPreparing : t.assessmentGrading}</p>
          {detail.status === 'preparing' && (
            <>
              <progress value={detail.completedBatches} max={detail.config.count / 12} />
              <p>
                {detail.completedBatches * 12} / {detail.config.count}{' '}
                {t.assessmentQuestionsPrepared}
              </p>
            </>
          )}
          <p className="muted">{t.assessmentCanClose}</p>
        </div>
      ) : detail.status === 'failed' || detail.status === 'interrupted' ? (
        <div className="notice">
          <p>{detail.error || t.error}</p>
          <Button disabled={busy} onClick={() => void action('retry')}>
            {t.retry}
          </Button>
        </div>
      ) : detail.status === 'cancelled' ? (
        <div className="notice">
          <h4>{t.assessmentCancelled}</h4>
          <p>{t.assessmentCancelledHint}</p>
          {detail.workActive && <p>{t.assessmentCancelInFlight}</p>}
        </div>
      ) : null}
      {detail.plan && (
        <details className="assessment-compiled">
          <summary>{t.assessmentTopicGuide}</summary>
          <div className="assessment-topic-grid">
            {detail.plan.topics.map((topic) => (
              <section key={topic.id}>
                <h4>{topic.title}</h4>
                <p>{topic.summary}</p>
                <ul>
                  {topic.concepts.map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ul>
                <AssessmentCitations
                  citations={topic.citations}
                  context={detail.context}
                  t={t}
                  navigate={navigate}
                  inspect={inspectEvidence}
                />
              </section>
            ))}
          </div>
          {detail.plan.coverageNotes.map((text, i) => (
            <p className="muted" key={i}>
              {text}
            </p>
          ))}
        </details>
      )}
      {['ready', 'cancelled'].includes(detail.status) && question && (
        <section className="assessment-answer-sheet">
          <div className="assessment-question-meta">
            <span>
              {t.quizQuestion} {step + 1} {t.of} {questions.length} ·{' '}
              {detail.plan?.topics.find((topic) => topic.id === question.topicId)?.title}
            </span>
            <span>
              {detail.answers.length} {t.assessmentSavedAnswers}
            </span>
          </div>
          <progress value={detail.answers.length} max={questions.length} />
          <p className="muted">
            {t[`assessmentType_${question.type}`]} ·{' '}
            {t[`assessmentDifficulty_${question.difficulty}`]}
          </p>
          <AssessmentQuestionInput
            question={question}
            response={response}
            change={(value) =>
              commit({
                ...local.current,
                responses: { ...local.current.responses, [question.id]: value },
              })
            }
            disabled={readOnly || busy || !!draft.operation}
            t={t}
          />
          <AssessmentCitations
            citations={question.citations}
            context={detail.context}
            t={t}
            navigate={navigate}
            inspect={inspectEvidence}
          />
          {readOnly ? (
            <p className="muted">{t.assessmentReadOnly}</p>
          ) : draft.operation ? (
            <div className="notice">
              <p>{draft.conflict ? t.assessmentAnswerConflict : t.assessmentPendingAnswer}</p>
              {draft.conflict ? (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    void load()
                      .then(() => {
                        commit({ ...local.current, operation: null, conflict: false });
                        setError('');
                      })
                      .catch((e) => setError((e as Error).message))
                      .finally(() => setBusy(false));
                  }}
                >
                  {t.assessmentReloadAnswer}
                </Button>
              ) : (
                <Button disabled={busy} onClick={() => void answer(draft.operation!.confidence)}>
                  {busy ? t.saving : t.assessmentRetryAnswer}
                </Button>
              )}
            </div>
          ) : (
            <div className="assessment-confidence">
              <Button
                disabled={busy || !validAssessmentResponse(question, response)}
                onClick={() => void answer('sure')}
              >
                {t.assessmentSure}
              </Button>
              <Button
                disabled={busy || !validAssessmentResponse(question, response)}
                onClick={() => void answer('unsure')}
              >
                {t.assessmentUnsure}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => void answer('unknown')}>
                {t.assessmentUnknown}
              </Button>
            </div>
          )}
          {saved ? (
            <p className="muted">
              <Check size={13} /> {t.assessmentAnswerSaved}:{' '}
              {t[`assessmentConfidence_${saved.confidence}`]} · v{saved.revision}
            </p>
          ) : readOnly ? (
            <p className="muted">{t.assessmentUnanswered}</p>
          ) : null}
          <nav className="assessment-question-nav" aria-label={t.assessmentQuestionNavigation}>
            {questions.map((q, i) => (
              <button
                key={q.id}
                type="button"
                aria-current={i === step ? 'step' : undefined}
                aria-label={`${t.assessmentGoQuestion} ${i + 1}`}
                className={detail.answers.some((a) => a.questionId === q.id) ? 'answered' : ''}
                disabled={busy || (!readOnly && !!draft.operation)}
                onClick={() => commit({ ...draft, step: i })}
              >
                {i + 1}
              </button>
            ))}
          </nav>
          {unsaved > 0 && (
            <p className="muted">
              {unsaved} {t.assessmentUnsavedChanges}
            </p>
          )}
          {!readOnly && allAnswered && (
            <Button
              variant="primary"
              disabled={busy || !!draft.operation || unsaved > 0}
              onClick={() => void action('finish')}
            >
              {t.assessmentFinish}
            </Button>
          )}
        </section>
      )}
      {detail.status === 'completed' && report && (
        <div className="assessment-report">
          <div className="assessment-report-score">
            <div>
              <strong>{report.score}%</strong>
              <p>
                {report.count} {t.assessmentQuestions} · {t.assessmentRecordedSample}
              </p>
              <a href={`/api/assessments/${id}/export-html`} download>
                {t.assessmentDownloadImages}
              </a>
            </div>
            <a className="button button-default" href={`/api/assessments/${id}/export`} download>
              <Download size={15} />
              {t.assessmentDownload}
            </a>
          </div>
          <p>{report.analysis}</p>
          <div className="assessment-topic-grid assessment-report-topics">
            {report.topics.map((topic) => (
              <section key={topic.topicId}>
                <h4>
                  {topic.title} · {topic.score}%
                </h4>
                <p className="muted">
                  {topic.count} {t.assessmentQuestions} · {t.assessmentSureErrors}:{' '}
                  {topic.sureErrors} · {t.assessmentUnsureCorrect}: {topic.unsureCorrect} ·{' '}
                  {t.assessmentConfidence_unknown}: {topic.unknown}
                </p>
                <p>{topic.analysis}</p>
              </section>
            ))}
          </div>
          <section className="assessment-report-card">
            <h4>{t.assessmentRecommendedSteps}</h4>
            {report.recommendations.map((rec, i) => (
              <section className="assessment-recommendation" key={i}>
                <h4>{rec.title}</h4>
                <p>{rec.reason}</p>
                <AssessmentCitations
                  citations={rec.citations}
                  context={detail.context}
                  t={t}
                  navigate={navigate}
                  inspect={inspectEvidence}
                />
                {rec.bookmarkId && (
                  <button
                    type="button"
                    className="assessment-recommendation-link"
                    onClick={() => bookmark(rec.bookmarkId!)}
                  >
                    <Play size={16} />
                    {t.assessmentOpenBookmark}
                  </button>
                )}
              </section>
            ))}
          </section>
          <Button variant="primary" onClick={() => followup(detail)}>
            {t.assessmentFollowup}
          </Button>
          <details className="assessment-report-card assessment-grades">
            <summary>
              {t.assessmentAnswerReport} ({detail.grades.length})
            </summary>
            {detail.grades.map((grade, i) => (
              <article className="assessment-grade" key={grade.questionId}>
                <h4>
                  <span
                    className={`assessment-grade-mark ${grade.score >= 1 ? 'correct' : grade.score > 0 ? 'partial' : grade.confidence === 'unknown' ? 'skipped' : 'incorrect'}`}
                    aria-hidden="true"
                  >
                    {grade.score >= 1
                      ? '✓'
                      : grade.score > 0
                        ? '½'
                        : grade.confidence === 'unknown'
                          ? '—'
                          : '✕'}
                  </span>
                  {i + 1}. {grade.prompt} · {Math.round(grade.score * 100)}%
                </h4>
                <p className="muted">
                  {t[`assessmentType_${grade.type}`]} ·{' '}
                  {t[`assessmentDifficulty_${grade.difficulty}`]} ·{' '}
                  {t[`assessmentConfidence_${grade.confidence}`]}
                </p>
                <p>
                  <strong>{t.yourAnswer}:</strong>{' '}
                  {grade.responseText || t.assessmentConfidence_unknown}
                </p>
                <p>
                  <strong>{t.assessmentCorrectAnswer}:</strong> {grade.correctAnswer}
                </p>
                <p>{grade.feedback}</p>
                {grade.pairs.map((pair, j) => (
                  <section key={j} className={pair.correct ? 'correct' : 'incorrect'}>
                    <h4>
                      <span aria-hidden="true">{pair.correct ? '✓' : '✕'}</span> {pair.prompt} ·{' '}
                      {pair.correct ? t.correct : t.recordedIncorrect}
                    </h4>
                    <p>
                      {t.yourAnswer}: {pair.response || t.assessmentUnanswered}
                    </p>
                    <p>
                      {t.assessmentCorrectAnswer}: {pair.correctAnswer}
                    </p>
                    <p>{pair.feedback}</p>
                    <AssessmentCitations
                      citations={pair.citations}
                      context={detail.context}
                      t={t}
                      navigate={navigate}
                      inspect={inspectEvidence}
                    />
                  </section>
                ))}
                <AssessmentCitations
                  citations={grade.citations}
                  context={detail.context}
                  t={t}
                  navigate={navigate}
                  inspect={inspectEvidence}
                />
              </article>
            ))}
          </details>
        </div>
      )}
      {inspectedEvidence && (
        <AttachmentInspector
          id={inspectedEvidence.id}
          initialImageId={inspectedEvidence.imageId}
          t={t}
          catalog={catalog}
          close={() => setInspectedEvidence(null)}
          cite={navigate}
          notice={t.assessmentSavedEvidenceNotice}
        />
      )}
    </div>
  );
}
