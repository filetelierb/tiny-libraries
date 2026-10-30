import { CircleAlert, Clock, LoaderCircle } from 'lucide-react';
import { jobProgress, type Job, type Source } from '../../shared/domain';
import type { T } from '../i18n';

const working = (job: Job) => job.status === 'running' || job.status === 'partial';

/** What preparation is doing for one file, beside its name in the library. */
export function PreparationMarker({ job, t }: { job: Job; t: T }) {
  const label =
    job.status === 'failed'
      ? t.jobFailed
      : job.status === 'queued'
        ? t.jobQueued
        : `${t.jobRunning} · ${t[job.stage]}${jobProgress(job)}`;
  return (
    <span className={`preparation-marker ${job.status}`} title={label} aria-label={label}>
      {job.status === 'failed' ? (
        <CircleAlert size={14} aria-hidden="true" />
      ) : job.status === 'queued' ? (
        <Clock size={14} aria-hidden="true" />
      ) : (
        <LoaderCircle size={14} className="spin" aria-hidden="true" />
      )}
    </span>
  );
}

/**
 * A line above the library's files while files are being prepared: the file under way and its
 * step, or how many are, how many wait, and how many need attention. It opens the queue.
 */
export function PreparationStrip({
  jobs,
  files,
  t,
  open,
}: {
  jobs: Map<string, Job>;
  files: Source[];
  t: T;
  open: () => void;
}) {
  if (!jobs.size) return null;
  const names = new Map(files.map((file) => [file.id, file.name]));
  const entries = [...jobs].filter(([id]) => names.has(id));
  const running = entries.filter(([, job]) => working(job)),
    current = running.length === 1 ? running[0] : null;
  const queued = entries.filter(([, job]) => job.status === 'queued').length,
    failed = entries.filter(([, job]) => job.status === 'failed').length;
  if (!running.length && !queued && !failed) return null;
  return (
    <button type="button" className="preparation-strip" onClick={open}>
      {running.length ? (
        <LoaderCircle size={15} className="spin" aria-hidden="true" />
      ) : queued ? (
        <Clock size={15} aria-hidden="true" />
      ) : (
        <CircleAlert size={15} aria-hidden="true" />
      )}
      <span>
        <strong>
          {current
            ? t.preparingFile.replace('{name}', names.get(current[0])!)
            : running.length
              ? t.preparingMany.replace('{n}', String(running.length))
              : queued
                ? t.preparingWaiting
                : t.preparingStopped}
        </strong>
        <small>
          {[
            current && `${t[current[1].stage]}${jobProgress(current[1])}`,
            queued && t.preparingQueued.replace('{n}', String(queued)),
            failed && t.preparingFailed.replace('{n}', String(failed)),
          ]
            .filter(Boolean)
            .join(' · ')}
        </small>
      </span>
    </button>
  );
}
