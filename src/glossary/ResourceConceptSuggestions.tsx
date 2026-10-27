import { useEffect, useRef, useState } from 'react';
import { StudyMarkdown } from '../study/StudyMarkdown';
import { ArrowLeft, Lightbulb, LoaderCircle, X } from 'lucide-react';
import type { Catalog, Source } from '../../shared/domain';
import type { SourceLocation } from '../../shared/annotations';
import {
  nearbyConcept,
  conceptReviewPrompt,
  exactSuggestionMatch,
  type AcceptSuggestion,
  type ConceptCandidate,
  type ResourceSuggestions,
} from '../../shared/concept-suggestions';
import { normalizeConcept, uniqueNames, type GlossaryEntry } from '../../shared/glossary';
import type { BulkConceptResult } from '../../worker/concept-suggestions';
import { api } from '../api';
import { Badge, Button, IconButton, Modal, LoadingRow } from '../design/components';
import type { T } from '../i18n';

export function ResourceConceptSuggestions({
  source,
  preparedAt,
  location,
  open,
  setOpen,
  catalog,
  t,
  changed,
  prepare,
  navigate,
  openConcept,
  followup,
}: {
  source: Source;
  preparedAt: string;
  location: SourceLocation;
  open: boolean;
  setOpen: (open: boolean) => void;
  catalog: Catalog;
  t: T;
  changed: () => Promise<unknown>;
  prepare: () => void;
  navigate: (sourceId: string, location: SourceLocation) => void;
  openConcept: (id: string) => void;
  followup: (prompt: string, location: SourceLocation) => void;
}) {
  const [data, setData] = useState<ResourceSuggestions | null>(null),
    [error, setError] = useState(''),
    [selected, setSelected] = useState<string | null>(null);
  const [manualCopy, setManualCopy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false),
    [pending, setPending] = useState(false),
    [bulk, setBulk] = useState<BulkConceptResult | null>(null);
  const hiddenKey = `tl:concept-hints:${source.id}:${source.version}`;
  const [hidden, setHidden] = useState(() => localStorage.getItem(hiddenKey) === 'hidden');
  const [analysisHistory, setAnalysisHistory] = useState<
    Array<{ id: string; createdAt: string; locale: string; method: string; status: string }>
  >([]);
  const [historicalId, setHistoricalId] = useState('');
  const historyView = useRef('');
  const viewHistory = (id: string) =>
    void perform(async () => {
      historyView.current = id;
      setHistoricalId(id);
      setSelected(null);
      setBulk(null);
      const value = await api<ResourceSuggestions>(
        id
          ? `/concept-suggestions/${id}`
          : `/concept-suggestions?sourceId=${source.id}&version=${source.version}`,
      );
      if (alive.current && historyView.current === id) setData(value);
    });
  const analyzeAttempt = useRef<string | null>(null),
    bulkAttempt = useRef<string | null>(null),
    loading = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      const selectedId = historyView.current;
      const value = await api<ResourceSuggestions>(
        selectedId
          ? `/concept-suggestions/${selectedId}`
          : `/concept-suggestions?sourceId=${source.id}&version=${source.version}`,
      );
      if (alive.current && historyView.current === selectedId) setData(value);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : t.error);
    } finally {
      loading.current = false;
    }
  };
  useEffect(() => {
    void load();
  }, [source.id, source.version, preparedAt]);
  useEffect(() => {
    if (!open && data?.analysis?.status !== 'running') return;
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [open, data?.analysis?.status]);
  const perform = async (work: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : t.error);
    } finally {
      if (alive.current) setPending(false);
    }
  };
  const analyze = (force = false) =>
    void perform(async () => {
      if (force || !analyzeAttempt.current) analyzeAttempt.current = crypto.randomUUID();
      const value = await api<ResourceSuggestions>('/concept-suggestions/analyze', 'POST', {
        sourceId: source.id,
        sourceVersion: source.version,
        requestId: analyzeAttempt.current,
        force,
      });
      if (alive.current) {
        historyView.current = '';
        setHistoricalId('');
        setData(value);
        setSelected(null);
        setBulk(null);
      }
    });
  const decide = async (candidate: ConceptCandidate, action: 'dismiss' | 'restore') =>
    perform(async () => {
      await api(`/concept-suggestions/${data!.analysis!.id}/${candidate.id}`, 'POST', {
        action,
        revision: candidate.revision,
        mutationId: crypto.randomUUID(),
      });
      await load();
    });
  const toggleHidden = (value: boolean) => {
    setHidden(value);
    localStorage.setItem(hiddenKey, value ? 'hidden' : 'visible');
  };
  const nearby = data?.concepts.filter((c) => !c.decision && nearbyConcept(c, location)) || [];
  const analysis = data?.analysis,
    running = analysis?.status === 'running',
    candidate = data?.concepts.find((c) => c.id === selected);
  return (
    <>
      {!open &&
        !hidden &&
        (nearby.length > 0 ||
          running ||
          analysis?.status === 'failed' ||
          analysis?.status === 'interrupted') && (
          <div className="concept-hint">
            <button
              onClick={() => {
                setSelected(nearby[0]?.id || null);
                setOpen(true);
              }}
            >
              {running ? <LoaderCircle className="spin" size={16} /> : <Lightbulb size={16} />}
              <span>
                {running
                  ? t.analyzingConcepts
                  : nearby.length
                    ? `${t.suggestedConcept}: ${nearby[0].term}${nearby.length > 1 ? ` (+${nearby.length - 1})` : ''}`
                    : t.checkConceptSuggestions}
              </span>
            </button>
            <IconButton label={t.hideResourceSuggestions} onClick={() => toggleHidden(true)}>
              <X size={14} />
            </IconButton>
          </div>
        )}
      {open && (
        <Modal
          title={t.conceptSuggestions}
          close={() => {
            if (!pending) setOpen(false);
          }}
          closeLabel={t.close}
        >
          <p className="concept-resource-name">
            {source.name} · {t.sourceVersion} {source.version}
          </p>
          <p>{t.suggestionReviewBody}</p>
          <p className="concept-resource-name">{t.conceptComparisonDisclosure}</p>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          {!data && <LoadingRow>{t.loading}</LoadingRow>}
          {data && !data.prepared && (
            <div>
              <p>{t.prepareConceptSource}</p>
              <Button
                onClick={() => {
                  setOpen(false);
                  prepare();
                }}
              >
                {t.process}
              </Button>
            </div>
          )}
          {data?.prepared && !analysis && (
            <Button variant="primary" disabled={pending} onClick={() => analyze()}>
              <Lightbulb size={15} />
              {t.analyzeConcepts}
            </Button>
          )}
          {running && (
            <p className="concept-running" role="status">
              <LoaderCircle className="spin" size={16} />
              {t.conceptAnalysisBackground}
            </p>
          )}
          {analysis && ['failed', 'interrupted'].includes(analysis.status) && (
            <div role="alert">
              <p>{analysis.error || t.error}</p>
              <Button disabled={pending} onClick={() => analyze()}>
                {t.retry}
              </Button>
            </div>
          )}
          {analysis?.status === 'ready' && (
            <>
              {analysis.method === 'guide' && (
                <section className="suggestion-bulk">
                  <p>{t.guideConceptProposals}</p>
                  <Button variant="primary" disabled={pending} onClick={() => analyze()}>
                    {t.compareGlossaryConcepts}
                  </Button>
                </section>
              )}
              {!analysis.complete && analysis.method !== 'guide' && (
                <p className="concept-coverage" role="status">
                  {t.incompleteConceptCoverage}
                </p>
              )}
              {analysis.warnings.map((warning, i) => (
                <p className="concept-coverage" key={i}>
                  {warning}
                </p>
              ))}
              {candidate ? (
                <>
                  <Button disabled={pending} variant="ghost" onClick={() => setSelected(null)}>
                    <ArrowLeft size={14} />
                    {t.back}
                  </Button>
                  <SuggestionReview
                    key={`${candidate.id}:${candidate.revision}`}
                    candidate={candidate}
                    data={data!}
                    catalog={catalog}
                    t={t}
                    pending={pending}
                    decide={decide}
                    openConcept={openConcept}
                    navigate={navigate}
                    save={async (input) => {
                      await perform(async () => {
                        await api(`/concept-suggestions/${analysis.id}/${candidate.id}`, 'POST', {
                          action: 'accept',
                          ...input,
                        });
                        await changed();
                        await load();
                      });
                    }}
                  />
                </>
              ) : (
                <>
                  <div className="suggestion-bulk">
                    <Button
                      disabled={
                        pending ||
                        analysis.method === 'guide' ||
                        !data?.concepts.some((c) => c.decision?.status !== 'dismissed')
                      }
                      onClick={() =>
                        void perform(async () => {
                          if (!bulkAttempt.current) bulkAttempt.current = crypto.randomUUID();
                          const result = await api<BulkConceptResult>(
                            `/concept-suggestions/${analysis.id}/accept-all`,
                            'POST',
                            { mutationId: bulkAttempt.current },
                          );
                          setBulk(result);
                          bulkAttempt.current = null;
                          await changed();
                          await load();
                        })
                      }
                    >
                      {t.saveAllConcepts}
                    </Button>
                    <p>{t.saveAllConceptsBody}</p>
                  </div>
                  {bulk && (
                    <section className="suggestion-bulk-result" aria-live="polite">
                      <p>
                        {bulk.created} {bulk.created === 1 ? t.conceptCreated : t.conceptsCreated} ·{' '}
                        {bulk.updated} {bulk.updated === 1 ? t.conceptUpdated : t.conceptsUpdated} ·{' '}
                        {bulk.linksAdded} {t.conceptLinksAdded}
                      </p>
                      {!!(bulk.skipped.length + bulk.unresolved.length) && (
                        <div className="glossary-actions">
                          <Button
                            disabled={pending}
                            onClick={() =>
                              followup(
                                conceptReviewPrompt(source.name, bulk, catalog.settings.locale),
                                data?.concepts[0]?.sources[0]?.location || {},
                              )
                            }
                          >
                            {t.draftConceptFollowup}
                          </Button>
                          <Button
                            onClick={() => {
                              void navigator.clipboard
                                .writeText(
                                  conceptReviewPrompt(source.name, bulk, catalog.settings.locale),
                                )
                                .then(() => {
                                  setCopied(true);
                                  setManualCopy(false);
                                })
                                .catch(() => setManualCopy(true));
                            }}
                          >
                            {copied ? t.copiedConceptFollowup : t.copyConceptFollowup}
                          </Button>
                        </div>
                      )}
                      {manualCopy && (
                        <label>
                          {t.copyConceptFollowup}
                          <textarea
                            readOnly
                            value={conceptReviewPrompt(source.name, bulk, catalog.settings.locale)}
                          />
                        </label>
                      )}
                      {!!(bulk.skipped.length + bulk.unresolved.length) && (
                        <details>
                          <summary>
                            {t.pendingConceptReview} ({bulk.skipped.length + bulk.unresolved.length}
                            )
                          </summary>
                          <ul>
                            {bulk.skipped.map((s, i) => (
                              <li key={`s-${i}`}>
                                {s.term}: {s.reason}
                              </li>
                            ))}
                            {bulk.unresolved.map((s, i) => (
                              <li key={`r-${i}`}>
                                {s.term} → {s.related}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </section>
                  )}
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={showAll}
                      onChange={(e) => setShowAll(e.target.checked)}
                    />
                    {t.showDecidedSuggestions}
                  </label>
                  <div className="suggestion-list">
                    {data?.concepts
                      .filter((c) => showAll || !c.decision)
                      .map((c) => (
                        <button key={c.id} disabled={pending} onClick={() => setSelected(c.id)}>
                          <strong>
                            <Lightbulb size={15} />
                            {c.term}
                          </strong>
                          <p>{c.definition}</p>
                          <small>
                            {c.decision?.status === 'accepted'
                              ? t.addedToGlossary
                              : c.decision?.status === 'dismissed'
                                ? t.dismissedSuggestion
                                : c.matches.length
                                  ? t.existingConceptMatch
                                  : t.newConceptProposal}
                          </small>
                        </button>
                      ))}
                  </div>
                  {!data?.concepts.some((c) => showAll || !c.decision) && (
                    <p>{t.noPendingConcepts}</p>
                  )}
                </>
              )}
              <details
                className="concept-reanalyze"
                onToggle={(event) => {
                  if (event.currentTarget.open)
                    void api<{ items: typeof analysisHistory }>(
                      `/concept-suggestions/history?sourceId=${source.id}&version=${source.version}`,
                    )
                      .then((value) => setAnalysisHistory(value.items))
                      .catch((e) => setError(e.message));
                }}
              >
                <summary>{t.analysisOptions}</summary>
                <label>
                  {t.conceptAnalysisHistory}
                  <select
                    disabled={pending}
                    value={historicalId}
                    onChange={(e) => viewHistory(e.target.value)}
                  >
                    <option value="">{t.latestConceptAnalysis}</option>
                    {analysisHistory.map((item) => (
                      <option key={item.id} value={item.id}>
                        {new Date(item.createdAt).toLocaleString()} · {item.locale} ·{' '}
                        {item.method === 'guide'
                          ? t.sourcePreparationAnalysis
                          : t.semanticComparisonAnalysis}{' '}
                        ·{' '}
                        {item.status === 'ready'
                          ? t.conceptAnalysisReady
                          : item.status === 'running'
                            ? t.analyzingConcepts
                            : item.status === 'interrupted'
                              ? t.conceptAnalysisInterrupted
                              : t.jobFailed}
                      </option>
                    ))}
                  </select>
                </label>
                <p>{t.reanalyzeConceptsBody}</p>
                <Button disabled={pending} onClick={() => analyze(true)}>
                  {t.reanalyzeConcepts}
                </Button>
              </details>
            </>
          )}
          <label className="check-row concept-hint-setting">
            <input
              type="checkbox"
              checked={!hidden}
              onChange={(e) => toggleHidden(!e.target.checked)}
            />
            {t.showResourceHints}
          </label>
        </Modal>
      )}
    </>
  );
}
function SuggestionReview({
  candidate,
  data,
  catalog,
  t,
  pending,
  save,
  decide,
  navigate,
  openConcept,
}: {
  candidate: ConceptCandidate;
  data: ResourceSuggestions;
  catalog: Catalog;
  t: T;
  pending: boolean;
  save: (input: AcceptSuggestion) => Promise<void>;
  decide: (candidate: ConceptCandidate, action: 'dismiss' | 'restore') => Promise<void>;
  navigate: (id: string, location: SourceLocation) => void;
  openConcept: (id: string) => void;
}) {
  const all = catalog.concepts.map(normalizeConcept).filter((e) => !e.archived && !e.mergedInto);
  const exact = exactSuggestionMatch(candidate, all),
    matches = exact.length
      ? exact
      : all.filter((e) => candidate.matches.some((m) => m.entryId === e.id));
  const initialTarget = matches.length === 1 ? matches[0] : null;
  const [target, setTarget] = useState<GlossaryEntry | null>(initialTarget),
    [mode, setMode] = useState<'create' | 'add' | 'replace'>(initialTarget ? 'add' : 'create');
  const [term, setTerm] = useState(candidate.term),
    [label, setLabel] = useState(candidate.label),
    [definition, setDefinition] = useState(candidate.definition);
  const [aliases, setAliases] = useState(
    uniqueNames([candidate.term, ...candidate.aliases], initialTarget?.term || candidate.term).join(
      '\n',
    ),
  );
  const [targetLoading, setTargetLoading] = useState(false);
  const targetRequest = useRef(0);
  const [senseId, setSenseId] = useState(initialTarget?.senses[0]?.id || `${candidate.id}:meaning`),
    [error, setError] = useState('');
  const [links, setLinks] = useState<Record<number, string>>({});
  const attempt = useRef<{ signature: string; id: string } | null>(null);
  const chooseTarget = async (id: string) => {
    setError('');
    if (!id) {
      setTarget(null);
      setMode('create');
      return;
    }
    const request = ++targetRequest.current;
    setTargetLoading(true);
    try {
      const value = await api<GlossaryEntry>(`/glossary/${id}`);
      if (request !== targetRequest.current) return;
      setTarget(value);
      setMode('add');
      setSenseId(value.senses[0].id);
      setAliases(uniqueNames([candidate.term, ...candidate.aliases], value.term).join('\n'));
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    } finally {
      if (request === targetRequest.current) setTargetLoading(false);
    }
  };
  const relatedTarget = (index: number) => {
    const relation = candidate.relations[index],
      related = data.concepts.find((c) => c.id === relation.candidateId);
    const relatedMatch = related ? exactSuggestionMatch(related, all) : [];
    return (
      relation.entryId ||
      related?.decision?.entryId ||
      (relatedMatch.length === 1 ? relatedMatch[0].id : related?.entryId) ||
      ''
    );
  };
  const accept = async () => {
    const input: Omit<AcceptSuggestion, 'mutationId'> = {
      revision: candidate.revision,
      mode,
      entryId: target?.id || candidate.entryId,
      version: target?.version || 0,
      senseId: mode === 'replace' ? senseId : `${candidate.id}:meaning`,
      term: target?.term || term,
      label,
      definition,
      aliases: aliases
        .split('\n')
        .map((a) => a.trim())
        .filter(Boolean),
      links: Object.entries(links).map(([index, entryId]) => ({
        index: Number(index),
        entryId,
        create: !all.some((e) => e.id === entryId),
      })),
    };
    const signature = JSON.stringify(input);
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, id: crypto.randomUUID() };
    await save({ ...input, mutationId: attempt.current.id });
  };
  return (
    <section className="suggestion-review">
      <h3>{candidate.term}</h3>
      {candidate.decision ? (
        <div className="suggestion-decision">
          <Badge tone={candidate.decision.status === 'accepted' ? 'success' : 'neutral'}>
            {candidate.decision.status === 'accepted' ? t.addedToGlossary : t.dismissedSuggestion}
          </Badge>
          {candidate.decision.entryId && (
            <Button onClick={() => openConcept(candidate.decision!.entryId!)}>
              {t.openConcept}
            </Button>
          )}
          {candidate.decision.status === 'dismissed' && (
            <Button disabled={pending} onClick={() => void decide(candidate, 'restore')}>
              {t.restoreSuggestion}
            </Button>
          )}
          <StudyMarkdown t={t}>{candidate.definition}</StudyMarkdown>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void accept();
          }}
        >
          {error && <p role="alert">{error}</p>}
          <fieldset disabled={pending || targetLoading}>
            {!!candidate.matches.length && (
              <details className="suggestion-match">
                <summary>
                  {t.semanticMatches} ({candidate.matches.length})
                </summary>
                {candidate.matches.map((m) => (
                  <section key={m.entryId}>
                    <button
                      type="button"
                      className="text-link"
                      onClick={() => void chooseTarget(m.entryId)}
                    >
                      {all.find((e) => e.id === m.entryId)?.term || t.sourceUnavailable}
                    </button>
                    <p>{m.reason}</p>
                  </section>
                ))}
              </details>
            )}
            <label>
              {t.suggestionDestination}
              <select value={target?.id || ''} onChange={(e) => void chooseTarget(e.target.value)}>
                <option value="">{t.createConceptEntry}</option>
                {all.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.term}
                  </option>
                ))}
              </select>
            </label>
            {target ? (
              <>
                <section className="suggestion-existing">
                  <h4>
                    {target.term} · {t.revision} {target.version}
                  </h4>
                  {target.senses.map((sense, i) => (
                    <div key={sense.id}>
                      <strong>{sense.label || `${t.meaning} ${i + 1}`}</strong>
                      <Badge tone={sense.reviewed ? 'success' : 'warning'}>
                        {sense.reviewed ? t.reviewed : t.notReviewed}
                      </Badge>
                      <StudyMarkdown t={t}>{sense.definition}</StudyMarkdown>
                    </div>
                  ))}
                </section>
                <label>
                  {t.definitionAction}
                  <select
                    value={mode}
                    onChange={(e) => setMode(e.target.value as 'add' | 'replace')}
                  >
                    <option value="add">{t.addAsMeaning}</option>
                    <option value="replace">{t.replaceMeaning}</option>
                  </select>
                </label>
                {mode === 'replace' && (
                  <label>
                    {t.meaningToReplace}
                    <select value={senseId} onChange={(e) => setSenseId(e.target.value)}>
                      {target.senses.map((s, i) => (
                        <option key={s.id} value={s.id}>
                          {s.label || `${t.meaning} ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </>
            ) : (
              <label>
                {t.conceptTitle}
                <input
                  required
                  maxLength={200}
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                />
              </label>
            )}
            <label>
              {t.meaningLabel}
              <input maxLength={160} value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label>
              {t.definitionMarkdown}
              <textarea
                required
                rows={5}
                maxLength={12000}
                value={definition}
                onChange={(e) => setDefinition(e.target.value)}
              />
            </label>
            <label>
              {t.conceptAliases}
              <textarea rows={2} value={aliases} onChange={(e) => setAliases(e.target.value)} />
            </label>
            {!!candidate.relations.length && (
              <section>
                <h4>{t.suggestedRelationships}</h4>
                {candidate.relations.map((relation, i) => {
                  const related = data.concepts.find((c) => c.id === relation.candidateId);
                  const defaultTarget = relatedTarget(i);
                  return (
                    <section className="suggestion-related" key={i}>
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={!!links[i]}
                          onChange={(e) =>
                            setLinks((v) => {
                              const next = { ...v };
                              if (e.target.checked) next[i] = defaultTarget;
                              else delete next[i];
                              return next;
                            })
                          }
                        />
                        {related?.term ||
                          all.find((e) => e.id === relation.entryId)?.term ||
                          t.sourceUnavailable}{' '}
                        · {relation.kind === 'synonym' ? t.linkedSynonym : t.relationSingular}
                      </label>
                      <p>{relation.description}</p>
                      {related && (
                        <details>
                          <summary>{t.reviewRelatedConcept}</summary>
                          <StudyMarkdown t={t}>{related.definition}</StudyMarkdown>
                          {related.sources.map((s, k) => (
                            <button
                              type="button"
                              className="text-link"
                              key={k}
                              onClick={() => navigate(s.sourceId, s.location || {})}
                            >
                              {s.location?.quote || t.originalSource}
                            </button>
                          ))}
                        </details>
                      )}
                      {links[i] && (
                        <label>
                          {t.relationshipTarget}
                          <select
                            value={links[i]}
                            onChange={(e) => setLinks((v) => ({ ...v, [i]: e.target.value }))}
                          >
                            {related &&
                              related.decision?.status !== 'accepted' &&
                              !all.some((e) => e.id === related.entryId) && (
                                <option value={related.entryId}>
                                  {t.createRelatedConcept}: {related.term}
                                </option>
                              )}
                            {all
                              .filter((e) => e.id !== target?.id)
                              .map((e) => (
                                <option key={e.id} value={e.id}>
                                  {e.term}
                                </option>
                              ))}
                          </select>
                        </label>
                      )}
                    </section>
                  );
                })}
              </section>
            )}
          </fieldset>
          <p className="small-empty">
            {mode === 'replace' ? t.replaceSuggestionBody : t.acceptSuggestionBody}
          </p>
          <div className="glossary-actions">
            <Button disabled={pending} onClick={() => void decide(candidate, 'dismiss')}>
              {t.dismiss}
            </Button>
            <Button type="submit" variant="primary" disabled={pending || targetLoading}>
              {pending ? t.saving : t.acceptConcept}
            </Button>
          </div>
        </form>
      )}
      <section className="suggestion-evidence">
        <h4>{t.sourceReferences}</h4>
        {candidate.sources.map((source, i) => (
          <div key={i}>
            <button
              className="text-link"
              onClick={() => navigate(source.sourceId, source.location || {})}
            >
              {catalog.files.find((f) => f.id === source.sourceId)?.name || t.sourceUnavailable}
              {source.location?.page
                ? ` · ${t.page} ${source.location.page}`
                : source.location?.seconds != null
                  ? ` · ${source.location.seconds}s`
                  : ''}
            </button>
            <blockquote>{source.location?.quote}</blockquote>
          </div>
        ))}
      </section>
    </section>
  );
}
