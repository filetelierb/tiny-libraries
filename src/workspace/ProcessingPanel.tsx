import { useEffect, useState } from 'react';
import { Check, Clock, LoaderCircle, RotateCcw, Square, X } from 'lucide-react';
import { jobProgress, type Job, type Locale, type Source } from '../../shared/domain';
import { api } from '../api';
import { Button, IconButton } from '../design/components';
import type { T } from '../i18n';

type QueueItem = { sourceId: string; prepared: boolean; job: Job | null };
const POLL_MS = 3500;
const statusLabel = {
  queued: 'jobQueued',
  running: 'jobRunning',
  partial: 'jobPartial',
  completed: 'jobCompleted',
  failed: 'jobFailed',
  cancelled: 'jobCancelled',
} as const;

/** The preparation queue: start, follow, retry or cancel preparation across the library. */
export function ProcessingPanel({
  files,
  locale,
  t,
  open,
  changed,
  close,
}: {
  files: Source[];
  locale: Locale;
  t: T;
  open: (file: Source) => void;
  /** Called when a preparation finishes, so the library can show the new material. */
  changed: () => void;
  close: () => void;
}) {
  const [items, setItems] = useState<QueueItem[] | null>(null),
    [error, setError] = useState(''),
    [choice, setChoice] = useState(''),
    [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true,
      finished: Set<string> | null = null;
    const load = async () => {
      try {
        const value = await api<QueueItem[]>(`/jobs?locale=${locale}`);
        if (!live) return;
        const done = new Set(
          value.filter((item) => item.job?.status === 'completed').map((item) => item.sourceId),
        );
        if (finished && [...done].some((id) => !finished!.has(id))) changed();
        finished = done;
        setItems(value);
        setError('');
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : t.error);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [locale, tick]);
  const byId = new Map(files.map((file) => [file.id, file]));
  const pending = (items || []).filter(
    (item) => !item.prepared && !item.job && byId.has(item.sourceId),
  );
  const jobs = (items || [])
    .filter((item): item is QueueItem & { job: Job } => !!item.job && byId.has(item.sourceId))
    .sort((a, b) => b.job.createdAt.localeCompare(a.job.createdAt));
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await work();
      setTick((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="processing-panel" aria-label={t.preparationQueue}>
      <header>
        <h2>{t.preparationQueue}</h2>
        <IconButton label={t.close} onClick={close}>
          <X />
        </IconButton>
      </header>
      <p className="muted">{t.preparationQueueHint}</p>
      <div className="processing-start">
        <select
          aria-label={t.prepareFile}
          value={choice}
          disabled={!pending.length || busy}
          onChange={(event) => setChoice(event.target.value)}
        >
          <option value="">{pending.length ? t.chooseFileToPrepare : t.nothingToPrepare}</option>
          {pending.map((item) => (
            <option key={item.sourceId} value={item.sourceId}>
              {byId.get(item.sourceId)!.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={!choice || busy}
          onClick={() =>
            void act(async () => {
              await api('/jobs', 'POST', { sourceId: choice, locale });
              setChoice('');
            })
          }
        >
          {t.prepareNow}
        </Button>
      </div>
      {confirming ? (
        <div className="processing-confirm" role="alert">
          <p>{t.prepareAllConfirm.replace('{n}', String(pending.length))}</p>
          <Button
            size="sm"
            variant="primary"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await api('/jobs/batch', 'POST', { locale });
                setConfirming(false);
              })
            }
          >
            {t.prepareAll}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            {t.cancel}
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="ghost"
          disabled={!pending.length || busy}
          onClick={() => setConfirming(true)}
        >
          {t.prepareAll} ({pending.length})
        </Button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!items ? (
        <p className="muted">{t.loading}</p>
      ) : jobs.length ? (
        <ul className="processing-jobs">
          {jobs.map(({ sourceId, job }) => {
            const file = byId.get(sourceId)!,
              active = ['queued', 'running', 'partial'].includes(job.status);
            return (
              <li key={job.id} className={job.status}>
                {job.status === 'queued' ? (
                  <Clock size={14} />
                ) : active ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Check size={14} />
                )}
                <button type="button" className="processing-file" onClick={() => open(file)}>
                  <span>{file.name}</span>
                  <small>
                    {job.status === 'queued' && job.position
                      ? t.jobWaitingTurn.replace('{n}', String(job.position))
                      : `${t[statusLabel[job.status]]} · ${t[job.stage]}${jobProgress(job)}`}
                  </small>
                  {job.error && <small className="form-error">{job.error}</small>}
                </button>
                {['failed', 'cancelled'].includes(job.status) && (
                  <IconButton
                    label={`${t.retry}: ${file.name}`}
                    disabled={busy}
                    onClick={() => void act(() => api(`/jobs/${job.id}`, 'POST'))}
                  >
                    <RotateCcw />
                  </IconButton>
                )}
                {active && (
                  <IconButton
                    label={`${t.cancel}: ${file.name}`}
                    disabled={busy}
                    onClick={() => void act(() => api(`/jobs/${job.id}`, 'DELETE'))}
                  >
                    <Square />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">{t.noPreparationJobs}</p>
      )}
    </section>
  );
}
