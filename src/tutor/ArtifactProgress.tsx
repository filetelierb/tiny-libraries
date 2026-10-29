import { useEffect, useState } from 'react';
import { FileStack, RotateCcw } from 'lucide-react';
import type { TutorArtifactStatus } from '../../shared/tutor-artifacts';
import { api } from '../api';
import { Button } from '../design/components';
import type { T } from '../i18n';

const POLL = 2500;

/** An artifact a reply started: its generation stage while it is written, then a way to open it. */
export function ArtifactProgress({
  id,
  title,
  t,
  open,
  ready,
}: {
  id: string;
  title?: string;
  t: T;
  open: (fileId: string) => void;
  /** Called once when the artifact is saved, so the library shows the new file. */
  ready: () => void;
}) {
  const [status, setStatus] = useState<TutorArtifactStatus | null>(null),
    [error, setError] = useState(''),
    [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (wasRunning: boolean) =>
      api<TutorArtifactStatus>(`/tutor-artifacts/${id}`)
        .then((value) => {
          if (!live) return;
          setStatus(value);
          setError('');
          const running = value.status !== 'ready' && value.status !== 'failed';
          if (running) timer = setTimeout(() => poll(true), POLL);
          else if (wasRunning && value.status === 'ready') ready();
        })
        .catch((cause) => {
          if (!live) return;
          setError(cause instanceof Error ? cause.message : t.error);
          timer = setTimeout(() => poll(wasRunning), POLL * 4);
        });
    void poll(false);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, tick]);
  const stage = status?.status;
  const { done = 0, total = 0 } = status?.chapters || {};
  const percent =
    stage === 'ready'
      ? 100
      : stage === 'planning' || !stage
        ? 5
        : stage === 'writing'
          ? 10 + Math.round((done / Math.max(1, total)) * 70)
          : stage === 'checking'
            ? 85
            : 95;
  return (
    <section className="tutor-artifact-card" aria-label={t.artifactLabel}>
      <FileStack size={18} aria-hidden="true" />
      <div>
        <strong>{status?.title || title || t.artifactLabel}</strong>
        <small role="status">
          {stage === 'ready'
            ? `${t.artifactReady}${status?.version && status.version > 1 ? ` · v${status.version}` : ''}`
            : stage === 'failed'
              ? status?.error || t.artifactFailed
              : stage === 'writing'
                ? t.artifactWriting
                    .replace('{done}', String(done))
                    .replace('{total}', String(total))
                : stage === 'checking'
                  ? t.artifactChecking
                  : stage === 'saving'
                    ? t.artifactSaving
                    : t.artifactPlanning}
        </small>
        {stage !== 'ready' && stage !== 'failed' && (
          <progress max={100} value={percent} aria-label={t.artifactLabel} />
        )}
        {error && <small className="error">{error}</small>}
      </div>
      {stage === 'ready' && status && (
        <Button size="sm" onClick={() => open(status.fileId)}>
          {t.openArtifact}
        </Button>
      )}
      {stage === 'failed' && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            void api<TutorArtifactStatus>(`/tutor-artifacts/${id}/retry`, 'POST')
              .then(() => setTick((value) => value + 1))
              .catch((cause) => setError(cause instanceof Error ? cause.message : t.error))
          }
        >
          <RotateCcw />
          {t.retry}
        </Button>
      )}
    </section>
  );
}
