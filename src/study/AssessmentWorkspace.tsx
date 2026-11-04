import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Check, ChevronLeft, ChevronRight, Plus, RefreshCw, Search } from 'lucide-react';
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
import { Button, Modal, LoadingRow } from '../design/components';
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
// The setup is a short wizard; only the material step has a required choice.
const setupSteps = ['material', 'focus', 'format', 'review'] as const;
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
    [inspectedEvidence, setInspectedEvidence] = useState<string | null>(null),
    [step, setStep] = useState(0);
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
    const current = configRef.current;
    // Opening the review always starts from the session's open files; the rest of the setup is kept.
    if (initial.current)
      update({
        ...current,
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
  const completed = history.filter((row) => row.status === 'completed'),
    materialReady =
      (config.sourceIds.length > 0 || evidenceIds.length > 0) &&
      !evidenceLoading &&
      evidenceIds.every((id) => evidence.some((item) => item.id === id)),
    selectedNames = config.sourceIds.flatMap((id) => {
      const file = catalog.files.find((file) => file.id === id);
      return file ? [file.name] : [];
    });
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
              <AssessmentRun
                back={() => choose(null)}
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
                  setStep(setupSteps.length - 1);
                  choose(null);
                }}
              />
            </>
          ) : (
            <>
              {loading ? (
                <LoadingRow>{t.loading}</LoadingRow>
              ) : (
                <div className="assessment-wizard">
                  <ol className="assessment-steps" aria-label={t.assessmentSetup}>
                    {setupSteps.map((name, index) => (
                      <li key={name}>
                        <button
                          type="button"
                          aria-current={step === index ? 'step' : undefined}
                          data-done={index < step || undefined}
                          disabled={index > 0 && !materialReady}
                          onClick={() => setStep(index)}
                        >
                          <span className="assessment-step-index" aria-hidden="true">
                            {index < step ? <Check size={12} /> : index + 1}
                          </span>
                          <span>{t[`assessmentStep_${name}`]}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                  <section
                    className="assessment-setup-card"
                    aria-labelledby="assessment-step-title"
                  >
                    <header className="assessment-step-header">
                      <small>
                        {t.assessmentStepProgress
                          .replace('{n}', String(step + 1))
                          .replace('{total}', String(setupSteps.length))}
                      </small>
                      <h3 id="assessment-step-title">{t[`assessmentStep_${setupSteps[step]}`]}</h3>
                      <p>{t[`assessmentStepHint_${setupSteps[step]}`]}</p>
                    </header>
                    {setupSteps[step] === 'material' && (
                      <>
                        <div className="assessment-picker-heading">
                          <span className="assessment-field-label">
                            {t.assessmentIncludedFiles}
                          </span>
                          <span className="assessment-picker-actions">
                            <span>
                              {config.sourceIds.length} {t.selectedOf} {eligible.size}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                update({ ...config, sourceIds: [...eligible].slice(0, 40) })
                              }
                            >
                              {t.assessmentSelectAll}
                            </button>
                            <button
                              type="button"
                              onClick={() => update({ ...config, sourceIds: [] })}
                            >
                              {t.assessmentDeselectAll}
                            </button>
                          </span>
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
                                options
                                  .filter((o) => !eligible.has(o.sourceId))
                                  .map((o) => o.sourceId),
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
                        <p className="assessment-helper">
                          {t.assessmentFileLimit}{' '}
                          <button
                            type="button"
                            disabled={busy}
                            title={t.assessmentRefreshSources}
                            onClick={() => {
                              setError('');
                              void loadOptions().catch((e) => setError((e as Error).message));
                            }}
                          >
                            {t.assessmentRefreshShort}
                          </button>
                        </p>
                        {options.some((o) => !o.prepared) && (
                          <details className="assessment-unprepared">
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
                      </>
                    )}
                    {setupSteps[step] === 'focus' && (
                      <>
                        <label className="assessment-guidance">
                          <span>
                            {t.assessmentGuidance} <small>{t.optional}</small>
                          </span>
                          <textarea
                            rows={4}
                            value={config.guidance}
                            maxLength={4000}
                            onChange={(e) => update({ ...config, guidance: e.target.value })}
                            placeholder={t.assessmentGuidanceHint}
                          />
                        </label>
                        {completed.length > 0 && (
                          <fieldset className="assessment-prior-reports">
                            <legend>
                              {t.assessmentUseReports} <small>{t.optional}</small>
                            </legend>
                            {completed.map((row) => (
                              <label key={row.id} className="assessment-option-row">
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
                      </>
                    )}
                    {setupSteps[step] === 'format' && (
                      <>
                        <fieldset className="assessment-choice-group">
                          <legend>{t.assessmentQuestionCount}</legend>
                          <div className="assessment-count-options">
                            {assessmentCounts.map((n) => (
                              <label key={n} className="assessment-count-option">
                                <input
                                  type="radio"
                                  name="assessment-count"
                                  value={n}
                                  checked={config.count === n}
                                  onChange={() => update({ ...config, count: n })}
                                />
                                <span>{n}</span>
                              </label>
                            ))}
                          </div>
                        </fieldset>
                        <fieldset className="assessment-choice-group">
                          <legend>{t.assessmentDifficulty}</legend>
                          <div className="assessment-difficulty-options">
                            {difficulties.map((value) => (
                              <label key={value} className="assessment-difficulty-option">
                                <input
                                  type="radio"
                                  name="assessment-difficulty"
                                  value={value}
                                  checked={config.difficulty === value}
                                  onChange={() => update({ ...config, difficulty: value })}
                                />
                                <span>
                                  <strong>{t[`assessmentDifficulty_${value}`]}</strong>
                                  <small>{t[`assessmentDifficultyHint_${value}`]}</small>
                                </span>
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      </>
                    )}
                    {setupSteps[step] === 'review' && (
                      <>
                        <dl className="assessment-summary">
                          <div>
                            <dt>{t.assessmentIncludedFiles}</dt>
                            <dd>
                              {selectedNames.length
                                ? `${selectedNames.slice(0, 3).join(', ')}${
                                    selectedNames.length > 3
                                      ? ` ${t.assessmentMoreFiles.replace('{n}', String(selectedNames.length - 3))}`
                                      : ''
                                  }`
                                : t.assessmentNone}
                            </dd>
                            <button type="button" onClick={() => setStep(0)}>
                              {t.edit}
                            </button>
                          </div>
                          <div>
                            <dt>{t.assessmentSavedEvidence}</dt>
                            <dd>
                              {evidence.length
                                ? evidence.map((item) => item.name).join(', ')
                                : t.assessmentNone}
                            </dd>
                            <button type="button" onClick={() => setStep(0)}>
                              {t.edit}
                            </button>
                          </div>
                          <div>
                            <dt>{t.assessmentStep_focus}</dt>
                            <dd className="assessment-summary-guidance">
                              {config.guidance.trim() || t.assessmentNoGuidance}
                              {config.priorReportIds.length > 0 && (
                                <small>
                                  {t.assessmentUseReports}: {config.priorReportIds.length}
                                </small>
                              )}
                            </dd>
                            <button type="button" onClick={() => setStep(1)}>
                              {t.edit}
                            </button>
                          </div>
                          <div>
                            <dt>{t.assessmentStep_format}</dt>
                            <dd>
                              {config.count} {t.assessmentQuestions} ·{' '}
                              {t[`assessmentDifficulty_${config.difficulty}`]}
                            </dd>
                            <button type="button" onClick={() => setStep(2)}>
                              {t.edit}
                            </button>
                          </div>
                        </dl>
                        <p className="assessment-helper">{t.assessmentDisclosure}</p>
                        {!catalog.settings.configured && (
                          <p className="notice">{t.assessmentKeyRequired}</p>
                        )}
                      </>
                    )}
                    <footer className="assessment-wizard-footer">
                      {step > 0 && (
                        <Button variant="ghost" onClick={() => setStep(step - 1)}>
                          <ChevronLeft size={14} />
                          {t.back}
                        </Button>
                      )}
                      {step === 0 && !materialReady && !evidenceLoading && (
                        <small>{t.assessmentNeedsMaterial}</small>
                      )}
                      {step < setupSteps.length - 1 ? (
                        <Button
                          variant="primary"
                          disabled={!materialReady}
                          onClick={() => setStep(step + 1)}
                        >
                          {t.assessmentNext}
                          <ChevronRight size={14} />
                        </Button>
                      ) : (
                        <Button
                          variant="primary"
                          disabled={busy || !materialReady || !catalog.settings.configured}
                          onClick={() => void create()}
                        >
                          {busy ? t.assessmentPreparing : t.assessmentPrepare}
                        </Button>
                      )}
                    </footer>
                  </section>
                </div>
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
      </div>
    </Modal>
  );
}
