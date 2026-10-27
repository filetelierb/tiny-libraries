import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Code2, Download, Eye, History, PencilLine } from 'lucide-react';
import type { Artifact } from '../../shared/domain';
import type { ArtifactRevision, ArtifactRevisionSummary } from '../../shared/artifact-revisions';
import { api } from '../api';
import { Button } from '../design/components';
import type { T } from '../i18n';
import { ArtifactEditor } from './ArtifactEditor';

/** Shows the latest artifact or a chosen older version, and opens the editor on the latest. */
export function ArtifactVersions({
  sourceId,
  latest,
  t,
  header,
  render,
  onSaved,
}: {
  sourceId: string;
  latest: Artifact;
  t: T;
  header: ReactNode;
  /** `latest` is false while an older version is shown read-only. */
  render: (artifact: Artifact, latest: boolean) => ReactNode;
  onSaved: () => void;
}) {
  const [versions, setVersions] = useState<ArtifactRevisionSummary[]>([]),
    [selected, setSelected] = useState<ArtifactRevision | null>(null),
    [editing, setEditing] = useState(false),
    [source, setSource] = useState(false),
    [error, setError] = useState(''),
    [tick, setTick] = useState(0),
    [compact, setCompact] = useState(false);
  const bar = useRef<HTMLElement>(null);
  // A narrow pane keeps the bar on one line by dropping the button labels.
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 560));
    observer.observe(element);
    return () => observer.disconnect();
  }, [editing]);
  const latestKey = `${latest.title}\n${latest.explanation}`;
  useEffect(() => {
    let live = true;
    api<ArtifactRevisionSummary[]>(`/artifacts/${sourceId}/revisions`)
      .then((value) => live && setVersions(value))
      .catch((cause) => live && setError(cause instanceof Error ? cause.message : t.error));
    return () => {
      live = false;
    };
  }, [sourceId, latestKey, tick]);
  const head = versions[0];
  const choose = async (revision: number | null) => {
    setError('');
    if (revision === null || revision === head?.revision) return setSelected(null);
    try {
      setSelected(await api<ArtifactRevision>(`/artifacts/${sourceId}/revisions/${revision}`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.error);
    }
  };
  if (editing && head)
    return (
      <ArtifactEditor
        key={head.revision}
        sourceId={sourceId}
        artifact={latest}
        revision={head.revision}
        t={t}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          setSelected(null);
          setTick((value) => value + 1);
          onSaved();
        }}
      />
    );
  const shown = selected?.artifact || latest;
  return (
    <div className="artifact-pane">
      <div className="artifact-stage">
        {header}
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {selected && (
          <div className="artifact-older-banner" role="status">
            <History aria-hidden />
            <span>{t.olderArtifactVersion.replace('{n}', String(selected.revision))}</span>
            <Button size="sm" onClick={() => void choose(null)}>
              {t.backToLatest}
            </Button>
          </div>
        )}
        {source ? (
          <pre className="artifact-source" tabIndex={0} aria-label={t.viewSource}>
            {`# ${shown.title}\n\n${shown.explanation}`}
          </pre>
        ) : (
          render(shown, !selected)
        )}
      </div>
      <footer
        ref={bar}
        className={`artifact-versions ${compact ? 'compact' : ''}`}
        aria-label={t.artifactVersions}
      >
        <span>
          {t.artifactLabel} · v{selected?.revision ?? head?.revision ?? 1}
        </span>
        <select
          aria-label={t.artifactVersion}
          value={selected?.revision ?? ''}
          disabled={versions.length < 2}
          onChange={(event) => void choose(event.target.value ? Number(event.target.value) : null)}
        >
          <option value="">{t.latestVersion}</option>
          {versions.slice(1).map((version) => (
            <option key={version.revision} value={version.revision}>
              v{version.revision} ·{' '}
              {version.origin === 'edited'
                ? t.versionEdited
                : version.origin === 'tutor'
                  ? t.versionTutor
                  : t.versionGenerated}{' '}
              ·{' '}
              {new Date(version.createdAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant={source ? 'secondary' : 'ghost'}
          aria-pressed={source}
          title={source ? t.viewPreview : t.viewSource}
          onClick={() => setSource(!source)}
        >
          {source ? <Eye /> : <Code2 />}
          <span>{source ? t.viewPreview : t.viewSource}</span>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title={t.downloadArtifact}
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([`# ${shown.title}\n\n${shown.explanation}\n`], { type: 'text/markdown' }),
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = `${shown.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'artifact'}-v${selected?.revision ?? head?.revision ?? 1}.md`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download />
          <span>{t.downloadArtifact}</span>
        </Button>
        {!selected && head && (
          <Button size="sm" variant="ghost" title={t.edit} onClick={() => setEditing(true)}>
            <PencilLine />
            <span>{t.edit}</span>
          </Button>
        )}
      </footer>
    </div>
  );
}
