import { useEffect, useState, type ReactNode } from 'react';
import { PencilLine } from 'lucide-react';
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
    [error, setError] = useState(''),
    [tick, setTick] = useState(0);
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
        {render(shown, !selected)}
      </div>
      <footer className="artifact-versions" aria-label={t.artifactVersions}>
        <span>
          {selected
            ? t.olderArtifactVersion.replace('{n}', String(selected.revision))
            : head
              ? `${t.artifactLabel} · v${head.revision}`
              : t.artifactLabel}
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
              {version.origin === 'edited' ? t.versionEdited : t.versionGenerated} ·{' '}
              {new Date(version.createdAt).toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}
            </option>
          ))}
        </select>
        {!selected && head && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            <PencilLine />
            {t.edit}
          </Button>
        )}
      </footer>
    </div>
  );
}
