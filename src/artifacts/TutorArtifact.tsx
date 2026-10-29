import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { Code2, Download, Eye, History } from 'lucide-react';
import type { Segment, Source } from '../../shared/domain';
import type { ArtifactReference, TutorArtifactDocument } from '../../shared/tutor-artifacts';
import { api } from '../api';
import { Button, LoadingRow } from '../design/components';
import type { T } from '../i18n';
import { StudyMarkdown } from '../study/StudyMarkdown';
import { WidgetHostContext, type WidgetHost } from './Widgets';

const segmentOf = (reference: ArtifactReference): Segment => ({
  id: reference.segmentId,
  text: reference.text,
  ...(reference.page ? { page: reference.page } : {}),
  ...(reference.seconds != null ? { start: reference.seconds } : {}),
});

/**
 * An artifact the tutor wrote from one or more library files. Its citations open the passage in
 * the file it came from; every saved version stays readable.
 */
export function TutorArtifact({
  file,
  files,
  t,
  onCite,
}: {
  file: Source;
  files: Source[];
  t: T;
  onCite: (sourceId: string, segment: Segment) => void;
}) {
  const [version, setVersion] = useState(file.version),
    [shown, setShown] = useState<TutorArtifactDocument | null>(null),
    [source, setSource] = useState(false),
    [error, setError] = useState('');
  // A new version saved while the artifact is open replaces the one shown.
  useEffect(() => setVersion(file.version), [file.version]);
  useEffect(() => {
    let live = true;
    setError('');
    api<TutorArtifactDocument>(`/tutor-artifacts/${file.id}/versions/${version}`)
      .then((value) => live && setShown(value))
      .catch((cause) => live && setError(cause instanceof Error ? cause.message : t.error));
    return () => {
      live = false;
    };
  }, [file.id, version]);
  const names = new Map(files.map((item) => [item.id, item.name]));
  const references = shown?.references || [];
  const cite = (id: string) => {
    const reference = references.find((item) => item.id === id);
    if (reference) onCite(reference.sourceId, segmentOf(reference));
  };
  const label = (reference: ArtifactReference) =>
    [
      names.get(reference.sourceId) || t.evidenceUnavailable,
      reference.page ? `${t.page} ${reference.page}` : '',
      reference.seconds != null
        ? new Date(reference.seconds * 1000).toISOString().slice(11, 19).replace(/^00:/, '')
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
  const host = useMemo<WidgetHost>(
    () => ({
      cite,
      citeNumber: (id) => {
        const index = references.findIndex((item) => item.id === id);
        return index < 0 ? undefined : index + 1;
      },
    }),
    [shown],
  );
  // Inline citations are links to #ref-<id>; they open the cited passage.
  const components = useMemo(
    () => ({
      a: ({ node: _node, href, ...link }: ComponentProps<'a'> & { node?: unknown }) =>
        href?.startsWith('#ref-') ? (
          <a
            {...link}
            href={href}
            className="artifact-cite"
            onClick={(event) => {
              event.preventDefault();
              cite(decodeURIComponent(href.slice(5)));
            }}
          />
        ) : (
          <a {...link} href={href} target="_blank" rel="noreferrer" />
        ),
    }),
    [shown],
  );
  const markdown = shown ? `# ${shown.title}\n\n${shown.markdown}\n` : '';
  return (
    <div className="artifact-pane">
      <div className="artifact-stage">
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
        {version !== file.version && (
          <div className="artifact-older-banner" role="status">
            <History aria-hidden />
            <span>{t.olderArtifactVersion.replace('{n}', String(version))}</span>
            <Button size="sm" onClick={() => setVersion(file.version)}>
              {t.backToLatest}
            </Button>
          </div>
        )}
        {!shown ? (
          !error && <LoadingRow>{t.loading}</LoadingRow>
        ) : source ? (
          <pre className="artifact-source" tabIndex={0} aria-label={t.viewSource}>
            {markdown}
          </pre>
        ) : (
          <section className="generated-artifact">
            <div className="section-label">{t.artifactLabel}</div>
            <h2>{shown.title}</h2>
            <WidgetHostContext.Provider value={host}>
              <StudyMarkdown t={t} components={components}>
                {shown.markdown}
              </StudyMarkdown>
            </WidgetHostContext.Provider>
            <footer className="artifact-references" aria-label={t.artifactReferences}>
              <h3>{t.artifactReferences}</h3>
              {references.length ? (
                <ol>
                  {references.map((reference) => (
                    <li key={reference.id} id={`ref-${encodeURIComponent(reference.id)}`}>
                      <a
                        href={`/api/files/${reference.sourceId}/content`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => {
                          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                            return;
                          event.preventDefault();
                          cite(reference.id);
                        }}
                      >
                        {label(reference)}
                      </a>
                      <span>
                        {reference.text.slice(0, 160)}
                        {reference.text.length > 160 ? '…' : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">{t.artifactNoReferences}</p>
              )}
              <p className="muted artifact-edit-hint">{t.tutorArtifactHint}</p>
            </footer>
          </section>
        )}
      </div>
      <footer className="artifact-versions" aria-label={t.artifactVersions}>
        <span>
          {t.artifactLabel} · v{version}
        </span>
        <select
          aria-label={t.artifactVersion}
          value={version === file.version ? '' : version}
          disabled={file.version < 2}
          onChange={(event) =>
            setVersion(event.target.value ? Number(event.target.value) : file.version)
          }
        >
          <option value="">{t.latestVersion}</option>
          {Array.from({ length: file.version - 1 }, (_, index) => file.version - 1 - index).map(
            (value) => (
              <option key={value} value={value}>
                v{value}
              </option>
            ),
          )}
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
          disabled={!shown}
          onClick={() => {
            const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = `${shown!.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'artifact'}-v${version}.md`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download />
          <span>{t.downloadArtifact}</span>
        </Button>
      </footer>
    </div>
  );
}
