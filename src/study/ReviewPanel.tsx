import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, RefreshCw, Sparkles } from 'lucide-react';
import {
  reviewSummary,
  type Attempt,
  type Catalog,
  type Segment,
  type Source,
  type StudySession,
} from '../../shared/domain';
import {
  reviewGroups,
  reviewSources,
  type PublicReinforcement,
  type ReviewScope,
} from '../../shared/review';
import { api } from '../api';
import { Badge, Button, Modal } from '../design/components';
import { GeneratedArtifact } from '../GeneratedArtifact';
import type { T } from '../i18n';

type Parameters = { frequency: number; sampling: number; amplitude: number };
export function ReviewPanel({
  catalog,
  session,
  active,
  t,
  practice,
  cite,
  practiceReinforcement,
  persist,
  refresh,
  assess,
}: {
  catalog: Catalog;
  session: StudySession;
  active: Source | null;
  t: T;
  practice: (id: string) => void;
  cite: (id: string, segment: Segment) => void;
  practiceReinforcement: (record: PublicReinforcement) => void;
  persist: (key: string, parameters: Parameters) => void;
  refresh: () => Promise<unknown>;
  assess: () => void;
}) {
  const [scope, setScope] = useState<ReviewScope>(() => {
    try {
      const saved = localStorage.getItem(`tl:review-scope:${session.id}`);
      return saved === 'source' || saved === 'library' ? saved : 'session';
    } catch {
      return 'session';
    }
  });
  const [records, setRecords] = useState<PublicReinforcement[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [inspect, setInspect] = useState<Attempt | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  const [target, setTarget] = useState<ReturnType<typeof reviewGroups>[number] | null>(null),
    [chosen, setChosen] = useState<string[]>([]);
  const request = useRef<{ id: string; fingerprint: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const sources = reviewSources(catalog, session, scope, active?.id),
    sourceIds = new Set(sources.map((s) => s.id));
  const attempts = catalog.attempts.filter((a) => sourceIds.has(a.sourceId)),
    summary = reviewSummary(attempts),
    pending = attempts.filter((a) => a.pendingReview).length;
  const visibleRecords = records.filter((r) => sourceIds.has(r.sourceId)),
    record = visibleRecords.find((r) => r.id === selected);
  useEffect(() => {
    root.current?.closest('.study-content')?.scrollTo({ top: 0 });
  }, [selected, scope]);
  useEffect(() => {
    try {
      localStorage.setItem(`tl:review-scope:${session.id}`, scope);
    } catch {}
  }, [scope, session.id]);
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const values = await api<PublicReinforcement[]>('/reinforcements');
        if (live) setRecords(values);
      } catch (e) {
        if (live) setError((e as Error).message);
      }
      if (live) timer = setTimeout(load, 3000);
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tick]);
  async function create(sourceId: string, attemptIds: string[], id?: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    const fingerprint = JSON.stringify({ sourceId, attemptIds: [...attemptIds].sort() });
    if (!id && request.current?.fingerprint !== fingerprint)
      request.current = { id: crypto.randomUUID(), fingerprint };
    try {
      const value = await api<PublicReinforcement>('/reinforcements', 'POST', {
        requestId: id || request.current!.id,
        sessionId: session.id,
        sourceId,
        attemptIds,
      });
      setRecords((current) => [value, ...current.filter((r) => r.id !== value.id)]);
      setSelected(value.id);
      setTarget(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function startTarget(group: ReturnType<typeof reviewGroups>[number]) {
    request.current = null;
    setTarget(group);
    setChosen(
      group.attempts
        .filter((a) => !a.correct && !a.pendingReview)
        .slice(-20)
        .map((a) => a.id),
    );
    setError('');
  }
  function details(attempt: Attempt) {
    return (
      <>
        <p>{attempt.question?.prompt || attempt.questionId}</p>
        <p>
          <strong>{t.yourAnswer}:</strong>{' '}
          {attempt.answer ||
            attempt.question?.choices[attempt.selected] ||
            String(attempt.selected)}
        </p>
        <p>
          {attempt.pendingReview
            ? t.needsReview
            : attempt.correct
              ? t.correct
              : t.recordedIncorrect}
        </p>
        <p>{attempt.explanation}</p>
        <small>
          {new Date(attempt.createdAt).toLocaleString()} · {t.sourceVersion} {attempt.sourceVersion}
        </small>
        <p className="muted">
          {t.preparationRevision}: {attempt.learningVersion || t.unknownPreparation}
        </p>
        {attempt.reinforcementId && (
          <Badge>
            {t.reinforcementPractice} · v{attempt.reinforcementVersion}
          </Badge>
        )}
        <p className="review-attempt-id">
          {t.quizAttempt}: {attempt.id}
        </p>
      </>
    );
  }
  return (
    <div className="review-panel" ref={root}>
      <Button variant="primary" onClick={assess}>
        {t.assessments}
      </Button>
      <div className="section-label">
        <Activity size={16} />
        {t.review}
        <Button
          variant="ghost"
          aria-label={t.refreshReview}
          onClick={() => {
            setTick((v) => v + 1);
            void refresh().catch((e) => setError((e as Error).message));
          }}
        >
          <RefreshCw size={14} />
        </Button>
      </div>
      <label className="review-scope">
        {t.reviewScope}
        <select
          value={scope}
          onChange={(e) => {
            setScope(e.target.value as ReviewScope);
            setSelected(null);
          }}
        >
          <option value="source" disabled={!active}>
            {t.currentResource}
          </option>
          <option value="session">{t.sessionFiles}</option>
          <option value="library">{t.entireLibrary}</option>
        </select>
      </label>
      <p className="muted">
        {scope === 'session' ? t.reviewSessionScope : t.reviewFileScope} {sources.length}{' '}
        {t.files.toLowerCase()}
      </p>
      {error && !target && (
        <p className="notice" role="alert">
          {error}
        </p>
      )}
      {record ? (
        <>
          <Button variant="ghost" onClick={() => setSelected(null)}>
            <ArrowLeft size={14} />
            {t.backToReview}
          </Button>
          <div className="review-report-heading">
            <Badge>v{record.version}</Badge>
            <h3>{record.plan?.title || record.concept}</h3>
            <p>{record.sourceName}</p>
            <small>{new Date(record.createdAt).toLocaleString()}</small>
          </div>
          <p className="muted">
            {t.reinforcementEvidenceLimit} {record.attempts.length}{' '}
            {record.attempts.length === 1 ? t.observedIncorrectAnswer : t.observedIncorrectAnswers}
          </p>
          {record.status === 'running' ? (
            <p role="status">{t.creatingReinforcement}</p>
          ) : record.status !== 'ready' || !record.plan ? (
            <>
              <p className="notice">{record.error || t.error}</p>
              <Button
                disabled={busy}
                onClick={() =>
                  void create(
                    record.sourceId,
                    record.attempts.map((a) => a.id),
                    record.id,
                  )
                }
              >
                {t.retry}
              </Button>
            </>
          ) : (
            <>
              <p>{record.plan.introduction}</p>
              <h4>{t.learningObjectives}</h4>
              <ul>
                {record.plan.objectives.map((text, i) => (
                  <li key={i}>{text}</li>
                ))}
              </ul>
              <h4>{t.observedFindings}</h4>
              {record.plan.findings.map((finding, i) => (
                <section key={i}>
                  <p>{finding.explanation}</p>
                  <div className="citations">
                    {finding.attemptIds.map((id) => (
                      <button
                        key={id}
                        onClick={() => setInspect(record.attempts.find((a) => a.id === id) || null)}
                      >
                        {t.quizAttempt} {id.slice(0, 8)}
                      </button>
                    ))}
                    {finding.segmentIds.map((id) => {
                      const segment = record.segments.find((s) => s.id === id);
                      return segment ? (
                        <button key={id} onClick={() => cite(record.sourceId, segment)}>
                          {t.source} {id}
                        </button>
                      ) : null;
                    })}
                  </div>
                </section>
              ))}
              {record.plan.lessons.map((lesson, i) => (
                <section className="reinforcement-lesson" key={i}>
                  <h4>{lesson.title}</h4>
                  <p>{lesson.body}</p>
                  {lesson.evidence.map((e, j) => {
                    const segment = record.segments.find((s) => s.id === e.segmentId);
                    return (
                      <div key={j}>
                        <blockquote>{e.quote}</blockquote>
                        {segment && (
                          <Button variant="ghost" onClick={() => cite(record.sourceId, segment)}>
                            {t.openSource} · {e.segmentId}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </section>
              ))}
              {record.plan.artifact && (
                <GeneratedArtifact
                  key={record.id}
                  artifact={record.plan.artifact}
                  t={t}
                  segments={record.segments}
                  onCite={(segment) => cite(record.sourceId, segment)}
                  storageKey={`tl:reinforcement:${record.id}:v${record.version}`}
                  saved={session.artifacts[`reinforcement:${record.id}`]}
                  persist={(value) => persist(`reinforcement:${record.id}`, value)}
                />
              )}
              <Button variant="primary" onClick={() => practiceReinforcement(record)}>
                {t.practiceReinforcement} · {record.plan.questions.length}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  request.current = null;
                  void create(
                    record.sourceId,
                    record.attempts.map((a) => a.id),
                  );
                }}
              >
                {t.newReinforcementRevision}
              </Button>
              <details>
                <summary>{t.recordedEvidence}</summary>
                {record.attempts.map((a) => (
                  <div className="review-evidence-attempt" key={a.id}>
                    {details(a)}
                  </div>
                ))}
              </details>
            </>
          )}
        </>
      ) : (
        <>
          {!attempts.length ? (
            <div className="small-empty">
              <Activity size={26} />
              <p>{t.noAttempts}</p>
              <p className="muted">{t.reviewNoEvidence}</p>
              {active && <Button onClick={() => practice(active.id)}>{t.practice}</Button>}
            </div>
          ) : (
            <>
              <div className="review-score">
                <strong>{summary.percent == null ? '—' : `${summary.percent}%`}</strong>
                <span>
                  {summary.correct} / {summary.count} {t.gradedAnswers}
                </span>
              </div>
              <p className="muted">{t.limited}</p>
              {pending > 0 && (
                <p>
                  {pending} {t.needsReview} · {t.pendingExcluded}
                </p>
              )}
              <h3>{t.observedConcepts}</h3>
              {reviewGroups(attempts).map((group) => {
                const stats = reviewSummary(group.attempts),
                  incorrect = group.attempts.filter((a) => !a.correct && !a.pendingReview);
                return (
                  <section
                    className="review-concept-group"
                    key={`${group.sourceId}:${group.concept}`}
                  >
                    <h4>{group.concept}</h4>
                    <small>{sources.find((s) => s.id === group.sourceId)?.name}</small>
                    <p>
                      {stats.correct} / {stats.count} {t.gradedAnswers}
                      {incorrect.length
                        ? ` · ${incorrect.length} ${incorrect.length === 1 ? t.observedIncorrectAnswer : t.observedIncorrectAnswers}`
                        : ''}
                    </p>
                    <Button onClick={() => practice(group.sourceId)}>{t.practice}</Button>
                    {incorrect.length > 0 && (
                      <Button onClick={() => startTarget(group)}>
                        <Sparkles size={13} />
                        {t.createReinforcement}
                      </Button>
                    )}
                    <details>
                      <summary>{t.recordedEvidence}</summary>
                      {[...group.attempts]
                        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                        .slice(0, 100)
                        .map((a) => (
                          <button
                            className="review-attempt-row"
                            key={a.id}
                            onClick={() => setInspect(a)}
                          >
                            <span>
                              {a.pendingReview
                                ? t.needsReview
                                : a.correct
                                  ? t.correct
                                  : t.recordedIncorrect}
                            </span>
                            <span>
                              {a.question?.prompt || a.concept}
                              <small>
                                {new Date(a.createdAt).toLocaleString()} · v{a.sourceVersion}
                              </small>
                            </span>
                          </button>
                        ))}
                    </details>
                  </section>
                );
              })}
            </>
          )}
          <h3>{t.savedReinforcements}</h3>
          {!visibleRecords.length && <p className="muted">{t.noReinforcements}</p>}
          {visibleRecords.map((r) => (
            <button key={r.id} className="reinforcement-row" onClick={() => setSelected(r.id)}>
              <span>
                {r.plan?.title || r.concept}
                <small>{r.sourceName}</small>
                <small>{new Date(r.createdAt).toLocaleString()}</small>
              </span>
              <Badge>v{r.version}</Badge>
              <small>
                {r.status === 'ready'
                  ? t.conceptAnalysisReady
                  : r.status === 'running'
                    ? t.creatingReinforcement
                    : r.status === 'interrupted'
                      ? t.conceptAnalysisInterrupted
                      : t.jobFailed}
              </small>
            </button>
          ))}
        </>
      )}
      {target && (
        <Modal title={t.createReinforcement} close={() => setTarget(null)} closeLabel={t.close}>
          <div className="reinforcement-setup">
            <h3>{target.concept}</h3>
            <p className="muted">{t.selectReinforcementAttempts}</p>
            {error && (
              <p role="alert" className="notice">
                {error}
              </p>
            )}
            {target.attempts
              .filter((a) => !a.correct && !a.pendingReview)
              .map((a) => (
                <label className="reinforcement-choice" key={a.id}>
                  <input
                    type="checkbox"
                    disabled={busy || (!chosen.includes(a.id) && chosen.length >= 20)}
                    checked={chosen.includes(a.id)}
                    onChange={(e) =>
                      setChosen((ids) =>
                        e.target.checked ? [...ids, a.id] : ids.filter((id) => id !== a.id),
                      )
                    }
                  />
                  <span>
                    {a.question?.prompt || a.concept}
                    <small>{new Date(a.createdAt).toLocaleString()}</small>
                  </span>
                </label>
              ))}
            <p className="muted">{t.reinforcementDisclosure}</p>
            <Button
              variant="primary"
              disabled={busy || !chosen.length}
              onClick={() => void create(target.sourceId, chosen)}
            >
              {busy ? t.creatingReinforcement : t.createReinforcement}
            </Button>
          </div>
        </Modal>
      )}
      {inspect && (
        <Modal title={t.recordedEvidence} close={() => setInspect(null)} closeLabel={t.close}>
          <div className="reinforcement-setup">{details(inspect)}</div>
        </Modal>
      )}
    </div>
  );
}
