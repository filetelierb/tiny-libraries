import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ArrowLeft, Plus, RefreshCw, Search } from 'lucide-react';
import {
  assessmentSetupSchema,
  assessmentCounts,
  difficulties,
  type AssessmentConfig,
  type AssessmentOption,
  type AssessmentSummary,
  type AssessmentDetail,
} from '../../shared/assessments';
import type { Catalog, Segment } from '../../shared/domain';
import { api } from '../api';
import { Button, Modal } from '../design/components';
import { DirectoryTree, type TreeActions } from '../workspace/DirectoryTree';
import type { T } from '../i18n';
import { AssessmentRun } from './AssessmentRun';
import { AttachmentPicker } from '../tutor/AttachmentPicker';
import { AttachmentInspector } from '../tutor/AttachmentInspector';
import {
  attachmentImages,
  questionImageBudget,
  type QuestionAttachment,
} from '../../shared/tutor-attachments';

const defaultConfig: AssessmentConfig = {
  sourceIds: [],
  count: 12,
  difficulty: 'mixed',
  guidance: '',
  priorReportIds: [],
};
const localConfigSchema = assessmentSetupSchema;
export function AssessmentWorkspace({
  sessionId,
  catalog,
  actions,
  t,
  close,
  navigate,
  bookmark,
  prepareFile,
  beforeCreate,
  changed,
  initialSelection,
}: {
  sessionId: string;
  catalog: Catalog;
  actions: TreeActions;
  t: T;
  close: () => void;
  navigate: (sourceId: string, segment: Segment) => void;
  bookmark: (id: string) => void;
  prepareFile: (id: string) => void;
  beforeCreate: () => Promise<unknown>;
  changed: () => void;
  /** undefined: resume the last or active test; null: open setup; id: open that test. */
  initialSelection?: string | null;
}) {
  const configKey = `tl:assessment-config:${sessionId}`,
    selectedKey = `tl:assessment-selected:${sessionId}`;
  const [config, setConfig] = useState<AssessmentConfig>(() => {
      try {
        const value = localConfigSchema.safeParse(
          JSON.parse(localStorage.getItem(configKey) || 'null'),
        );
        return value.success ? value.data : defaultConfig;
      } catch {
        return defaultConfig;
      }
    }),
    [options, setOptions] = useState<AssessmentOption[]>([]),
    [history, setHistory] = useState<AssessmentSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [query, setQuery] = useState(''),
    [evidence, setEvidence] = useState<QuestionAttachment[]>([]),
    [evidenceLoading, setEvidenceLoading] = useState(false),
    [evidencePicker, setEvidencePicker] = useState(false),
    [inspectedEvidence, setInspectedEvidence] = useState<string | null>(null);
  const alive = useRef(true),
    initial = useRef(true),
    creation = useRef<{ fingerprint: string; id: string } | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const eligible = new Set(
      options.filter((o) => o.prepared && o.studiedCount > 0).map((o) => o.sourceId),
    ),
    availableIds = new Set(options.map((o) => o.sourceId));
  function choose(id: string | null) {
    setSelected(id);
    try {
      if (id) localStorage.setItem(selectedKey, id);
      else localStorage.removeItem(selectedKey);
    } catch {}
  }
  function update(value: AssessmentConfig) {
    configRef.current = value;
    setConfig(value);
    try {
      localStorage.setItem(configKey, JSON.stringify(value));
    } catch {}
  }
  const evidenceIds = config.attachmentIds || [],
    evidenceKey = evidenceIds.join(',');
  useEffect(() => {
    let active = true;
    setEvidenceLoading(true);
    void Promise.allSettled(
      evidenceIds.map((id) => api<QuestionAttachment>(`/tutor-attachments/${id}`)),
    ).then((results) => {
      if (!active) return;
      setEvidence(
        results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : [])),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') setError((failed.reason as Error).message);
      setEvidenceLoading(false);
    });
    return () => {
      active = false;
    };
  }, [evidenceKey]);
  function changeEvidence(items: QuestionAttachment[]) {
    setEvidence(items);
    update({ ...configRef.current, attachmentIds: items.map((item) => item.id) });
  }
  async function loadOptions() {
    await beforeCreate();
    const values = await api<AssessmentOption[]>('/assessments/options', 'POST', { sessionId });
    if (!alive.current) return;
    setOptions(values);
    const valid = new Set(
      values.filter((o) => o.prepared && o.studiedCount > 0).map((o) => o.sourceId),
    );
    let saved = false;
    try {
      saved = localConfigSchema.safeParse(
        JSON.parse(localStorage.getItem(configKey) || 'null'),
      ).success;
    } catch {}
    const current = configRef.current;
    if (initial.current && !saved)
      update({
        ...defaultConfig,
        sourceIds: values
          .filter((o) => o.suggested && valid.has(o.sourceId))
          .slice(0, 40)
          .map((o) => o.sourceId),
      });
    else {
      const ids = current.sourceIds.filter((id) => valid.has(id));
      if (ids.length !== current.sourceIds.length) setError(t.assessmentSelectionChanged);
      update({ ...current, sourceIds: ids });
    }
    initial.current = false;
  }
  async function loadHistory(after?: string) {
    const result = await api<{ items: AssessmentSummary[]; nextCursor: string | null }>(
      `/assessments?sessionId=${sessionId}${after ? `&after=${after}` : ''}`,
    );
    if (alive.current) {
      setHistory((current) =>
        after
          ? [...new Map([...current, ...result.items].map((row) => [row.id, row])).values()]
          : result.items,
      );
      setCursor(result.nextCursor);
    }
    return result.items;
  }
  const workingHistoryIds = history
    .filter((row) => row.workActive || ['preparing', 'grading'].includes(row.status))
    .map((row) => row.id)
    .join(',');
  useEffect(() => {
    if (!workingHistoryIds) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const summaries = await Promise.all(
          workingHistoryIds
            .split(',')
            .map((id) => api<AssessmentSummary>(`/assessments/${id}?view=summary`)),
        );
        if (live)
          setHistory((current) =>
            current.map((row) => summaries.find((value) => value.id === row.id) || row),
          );
      } catch (e) {
        if (live) setError((e as Error).message);
      }
      if (live) timer = setTimeout(poll, 3000);
    };
    timer = setTimeout(poll, 3000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workingHistoryIds]);
  useEffect(() => {
    alive.current = true;
    void Promise.allSettled([loadOptions(), loadHistory()]).then((results) => {
      if (!alive.current) return;
      for (const result of results)
        if (result.status === 'rejected') setError((result.reason as Error).message);
      const values =
        results[1].status === 'fulfilled' ? (results[1].value as AssessmentSummary[]) : [];
      let last: string | null = null;
      try {
        last = localStorage.getItem(selectedKey);
      } catch {}
      const active = values.find((row) => !['completed', 'cancelled'].includes(row.status));
      if (initialSelection !== undefined) choose(initialSelection);
      else choose(active?.id || (z.string().uuid().safeParse(last).success ? last : null));
      setLoading(false);
    });
    return () => {
      alive.current = false;
    };
  }, []);
  async function create() {
    if (busy) return;
    setBusy(true);
    setError('');
    const budgetError = questionImageBudget(evidence);
    if (budgetError) {
      setError(budgetError);
      setBusy(false);
      return;
    }
    const fingerprint = JSON.stringify(config);
    if (creation.current?.fingerprint !== fingerprint)
      creation.current = { id: crypto.randomUUID(), fingerprint };
    try {
      await beforeCreate();
      const value = await api<AssessmentDetail>('/assessments', 'POST', {
        requestId: creation.current.id,
        sessionId,
        config,
      });
      if (alive.current) {
        choose(value.id);
        await loadHistory();
      }
    } catch (e) {
      if (alive.current) {
        setError((e as Error).message);
        await loadHistory().catch(() => {});
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  const unfinished = history.find((row) => !['completed', 'cancelled'].includes(row.status));
  return (
    <Modal
      title={t.assessmentTitle}
      close={close}
      closeLabel={t.assessmentClose}
      className="assessment-modal"
    >
      <div className="assessment-layout">
        <main className="assessment-main">
          {error && (
            <p role="alert" className="notice">
              {error}
            </p>
          )}
          {selected ? (
            <>
              <Button variant="ghost" onClick={() => choose(null)}>
                <ArrowLeft size={14} />
                {t.assessmentSetup}
              </Button>
              <AssessmentRun
                key={selected}
                id={selected}
                sessionId={sessionId}
                t={t}
                catalog={catalog}
                navigate={navigate}
                bookmark={bookmark}
                changed={changed}
                summaryChanged={() =>
                  void loadHistory().catch((e) => setError((e as Error).message))
                }
                followup={(detail) => {
                  update({
                    sourceIds: detail.config.sourceIds.filter((id) => eligible.has(id)),
                    count: 12,
                    difficulty: 'mixed',
                    guidance: t.assessmentFollowupGuidance,
                    priorReportIds: [detail.id],
                    attachmentIds: detail.config.attachmentIds,
                  });
                  creation.current = null;
                  choose(null);
                }}
              />
            </>
          ) : (
            <>
              <h3>{t.assessmentSetup}</h3>
              <p className="muted">{t.assessmentSetupHint}</p>
              {loading ? (
                <p role="status">{t.loading}</p>
              ) : (
                <>
                  {unfinished && (
                    <div className="notice">
                      <p>{t.assessmentUnfinishedNotice}</p>
                      <Button onClick={() => choose(unfinished.id)}>{t.assessmentResume}</Button>
                    </div>
                  )}
                  <label className="assessment-guidance">
                    {t.assessmentGuidance}
                    <textarea
                      value={config.guidance}
                      maxLength={4000}
                      onChange={(e) => update({ ...config, guidance: e.target.value })}
                      placeholder={t.assessmentGuidanceHint}
                    />
                  </label>
                  <div className="assessment-picker-heading">
                    <h4>
                      {t.assessmentIncludedFiles} · {config.sourceIds.length}
                    </h4>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      aria-label={t.assessmentRefreshSources}
                      onClick={() => {
                        setError('');
                        void loadOptions().catch((e) => setError((e as Error).message));
                      }}
                    >
                      <RefreshCw size={14} />
                    </Button>
                  </div>
                  <div className="assessment-picker-actions">
                    <Button
                      variant="ghost"
                      onClick={() => update({ ...config, sourceIds: [...eligible].slice(0, 40) })}
                    >
                      {t.assessmentSelectAll}
                    </Button>
                    <Button variant="ghost" onClick={() => update({ ...config, sourceIds: [] })}>
                      {t.assessmentDeselectAll}
                    </Button>
                  </div>
                  <label className="library-search">
                    <Search size={14} />
                    <input
                      type="search"
                      aria-label={t.assessmentSearchFiles}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={t.search}
                    />
                  </label>
                  <div className="assessment-file-picker">
                    <DirectoryTree
                      mode="filter"
                      directories={catalog.directories}
                      files={catalog.files.filter((file) => availableIds.has(file.id))}
                      actions={actions}
                      t={t}
                      query={query}
                      storageKey="tl:tree:assessments"
                      selectedFileIds={new Set(config.sourceIds)}
                      disabledFileIds={
                        new Set(
                          options.filter((o) => !eligible.has(o.sourceId)).map((o) => o.sourceId),
                        )
                      }
                      fileStatuses={
                        new Map(
                          options
                            .filter((o) => !eligible.has(o.sourceId))
                            .map((o) => [
                              o.sourceId,
                              o.prepared ? t.assessmentStudyMore : t.assessmentPrepareFirst,
                            ]),
                        )
                      }
                      fileCounts={new Map(options.map((o) => [o.sourceId, o.noteCount]))}
                      toggleFile={(file, checked) =>
                        update({
                          ...config,
                          sourceIds: checked
                            ? config.sourceIds.length < 40
                              ? [...config.sourceIds, file.id]
                              : config.sourceIds
                            : config.sourceIds.filter((id) => id !== file.id),
                        })
                      }
                    />
                  </div>
                  <p className="muted">{t.assessmentFileLimit}</p>
                  {options.some((o) => !o.prepared) && (
                    <details>
                      <summary>{t.assessmentUnpreparedFiles}</summary>
                      {options
                        .filter((o) => !o.prepared)
                        .map((o) => (
                          <Button
                            key={o.sourceId}
                            variant="ghost"
                            onClick={() => prepareFile(o.sourceId)}
                          >
                            {t.assessmentOpenToPrepare}:{' '}
                            {catalog.files.find((file) => file.id === o.sourceId)?.name}
                          </Button>
                        ))}
                    </details>
                  )}
                  <section
                    className="assessment-saved-evidence"
                    aria-label={t.assessmentSavedEvidence}
                  >
                    <h4>
                      {t.assessmentSavedEvidence} · {evidenceIds.length} / 6
                    </h4>
                    <p>
                      {t.attachmentSelectedImages}: {evidence.flatMap(attachmentImages).length} / 48
                      ·{' '}
                      {(
                        evidence
                          .flatMap(attachmentImages)
                          .reduce((sum, image) => sum + image.size, 0) /
                        1024 /
                        1024
                      ).toFixed(2)}{' '}
                      / 12 MB
                    </p>
                    <p className="muted">{t.assessmentEvidenceDisclosure}</p>
                    {evidenceLoading && <p role="status">{t.loading}</p>}
                    {evidenceIds.map((id) => {
                      const item = evidence.find((item) => item.id === id);
                      return (
                        <div className="question-attachment" key={id}>
                          <Button disabled={!item} onClick={() => setInspectedEvidence(id)}>
                            {item?.name || t.evidenceUnavailable}
                            {item && (
                              <small>
                                {t.attachmentSelectedImages}: {attachmentImages(item).length}
                                {item.annotationRevision
                                  ? ` · ${t.revision} ${item.annotationRevision}`
                                  : ''}
                              </small>
                            )}
                          </Button>
                          <Button
                            aria-label={`${t.remove}: ${item?.name || t.evidenceUnavailable}`}
                            onClick={() => {
                              const ids = evidenceIds.filter((value) => value !== id);
                              update({ ...configRef.current, attachmentIds: ids });
                              setEvidence((old) => old.filter((value) => value.id !== id));
                            }}
                          >
                            {t.remove}
                          </Button>
                        </div>
                      );
                    })}
                    <Button
                      disabled={busy || evidenceLoading || evidenceIds.length >= 6}
                      onClick={() => setEvidencePicker(true)}
                    >
                      {t.assessmentAddEvidence}
                    </Button>
                    <p className="muted">{t.assessmentEvidenceLimits}</p>
                  </section>
                  <div className="assessment-config-grid">
                    <label>
                      {t.assessmentQuestionCount}
                      <select
                        value={config.count}
                        onChange={(e) => update({ ...config, count: Number(e.target.value) })}
                      >
                        {assessmentCounts.map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      {t.assessmentDifficulty}
                      <select
                        value={config.difficulty}
                        onChange={(e) =>
                          update({
                            ...config,
                            difficulty: e.target.value as AssessmentConfig['difficulty'],
                          })
                        }
                      >
                        {difficulties.map((value) => (
                          <option key={value} value={value}>
                            {t[`assessmentDifficulty_${value}`]}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {history.some((row) => row.status === 'completed') && (
                    <fieldset className="assessment-prior-reports">
                      <legend>{t.assessmentUseReports}</legend>
                      {history
                        .filter((row) => row.status === 'completed')
                        .map((row) => (
                          <label key={row.id}>
                            <input
                              type="checkbox"
                              checked={config.priorReportIds.includes(row.id)}
                              disabled={
                                config.priorReportIds.length >= 10 &&
                                !config.priorReportIds.includes(row.id)
                              }
                              onChange={(e) =>
                                update({
                                  ...config,
                                  priorReportIds: e.target.checked
                                    ? [...config.priorReportIds, row.id]
                                    : config.priorReportIds.filter((id) => id !== row.id),
                                })
                              }
                            />
                            <span>
                              {row.title}
                              <small>{new Date(row.createdAt).toLocaleString()}</small>
                            </span>
                          </label>
                        ))}
                    </fieldset>
                  )}
                  <p className="muted">{t.assessmentDisclosure}</p>
                  {!catalog.settings.configured && (
                    <p className="notice">{t.assessmentKeyRequired}</p>
                  )}
                  <Button
                    variant="primary"
                    disabled={
                      busy ||
                      !!unfinished ||
                      (!config.sourceIds.length && !evidenceIds.length) ||
                      evidenceLoading ||
                      evidenceIds.some((id) => !evidence.some((item) => item.id === id)) ||
                      !catalog.settings.configured
                    }
                    onClick={() => void create()}
                  >
                    {busy ? t.assessmentPreparing : t.assessmentPrepare}
                  </Button>
                </>
              )}
            </>
          )}
        </main>
        {evidencePicker && (
          <AttachmentPicker
            purpose="assessment"
            sessionId={sessionId}
            source={null}
            catalog={catalog}
            t={t}
            treeActions={actions}
            chosen={evidence}
            choose={(item) => changeEvidence([...evidence, item])}
            close={() => setEvidencePicker(false)}
            changed={async () => {
              changed();
              await loadOptions();
            }}
            prepareSource={(source) => prepareFile(source.id)}
          />
        )}
        {inspectedEvidence && (
          <AttachmentInspector
            id={inspectedEvidence}
            t={t}
            catalog={catalog}
            close={() => setInspectedEvidence(null)}
            cite={navigate}
            notice={t.assessmentSavedEvidenceNotice}
          />
        )}
        <aside className="assessment-history">
          <div className="assessment-picker-heading">
            <h3>{t.assessmentSavedReviews}</h3>
            <Button
              variant="ghost"
              aria-label={t.assessmentRefreshHistory}
              onClick={() => void loadHistory().catch((e) => setError((e as Error).message))}
            >
              <RefreshCw size={14} />
            </Button>
          </div>
          <Button variant="ghost" onClick={() => choose(null)}>
            <Plus size={14} />
            {t.assessmentNew}
          </Button>
          {!history.length && !loading && <p className="muted">{t.assessmentNoHistory}</p>}
          {history.map((row) => (
            <button
              key={row.id}
              type="button"
              aria-current={selected === row.id ? 'page' : undefined}
              className="assessment-history-row"
              onClick={() => choose(row.id)}
            >
              <strong>{row.title || t.assessmentPreparing}</strong>
              <small>
                {new Date(row.createdAt).toLocaleString()} · {row.config.count}{' '}
                {t.assessmentQuestions}
              </small>
              <span>{t[`assessmentStatus_${row.status}`]}</span>
            </button>
          ))}
          {cursor && (
            <Button
              onClick={() => void loadHistory(cursor).catch((e) => setError((e as Error).message))}
            >
              {t.assessmentLoadMore}
            </Button>
          )}
        </aside>
      </div>
    </Modal>
  );
}
