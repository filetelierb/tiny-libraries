import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ConceptMention } from '../../shared/tutor-context';
import type { Catalog, ConceptSource, PublicLearning, Segment } from '../../shared/domain';
import type { GlossaryEntry } from '../../shared/glossary';
import { sourceState } from '../../shared/directories';
import { api } from '../api';
import { Badge, Button, Modal } from '../design/components';
import type { T } from '../i18n';
export function ConceptInspector({
  reference,
  catalog,
  t,
  close,
  openConcept,
  cite,
  useLatest,
}: {
  reference: ConceptMention & { meaningIds?: string[] };
  catalog: Catalog;
  t: T;
  close: () => void;
  openConcept: (id: string) => void;
  cite: (id: string, segment: Segment) => void;
  useLatest?: (entry: GlossaryEntry) => void;
}) {
  const [entry, setEntry] = useState<GlossaryEntry | null>(null),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [tick, setTick] = useState(0);
  const latest = catalog.concepts.find((c) => c.id === reference.id);
  useEffect(() => {
    let cancelled = false;
    setEntry(null);
    setError('');
    void api<GlossaryEntry>(`/glossary/${reference.id}/history/${reference.version}`)
      .then((value) => {
        if (!cancelled) setEntry(value);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [reference.id, reference.version, tick]);
  const jump = async (source: ConceptSource) => {
    setPending(true);
    setError('');
    try {
      const file = catalog.files.find((f) => f.id === source.sourceId);
      if (
        !file ||
        file.version !== source.sourceVersion ||
        sourceState(file, catalog.directories) === 'trash'
      )
        throw new Error(t.sourceUnavailable);
      let segment: Segment = {
        id: t.sourceReferences,
        text: source.location?.quote || '',
        ...(source.location?.page ? { page: source.location.page } : {}),
        ...(source.location?.seconds != null ? { start: source.location.seconds } : {}),
      };
      if (!source.location?.page && source.location?.seconds == null && source.segmentIds.length) {
        const material = await api<PublicLearning | null>(`/learning/${file.id}`),
          found =
            material?.sourceVersion === source.sourceVersion
              ? material.segments.find((s) => source.segmentIds.includes(s.id))
              : null;
        if (found) segment = found;
      }
      close();
      cite(file.id, segment);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      title={t.inspectConcept}
      close={() => {
        if (!pending) close();
      }}
      closeLabel={t.close}
    >
      <h3>{entry?.term || reference.term}</h3>
      <p>
        {t.revision} {reference.version} ·{' '}
        <Badge tone={entry?.reviewed ? 'success' : 'warning'}>
          {entry?.reviewed ? t.reviewed : t.notReviewed}
        </Badge>
      </p>
      <p className="muted">{t.conceptRevisionNotice}</p>
      {reference.meaningIds && <p className="muted">{t.conceptScopedMeanings}</p>}
      {latest && latest.version !== reference.version && (
        <p className="concept-version-notice">
          {t.newerConceptRevision} {latest.version}
        </p>
      )}
      {latest?.archived && <Badge>{t.archived}</Badge>}
      {error && (
        <p role="alert" className="inline-error">
          {error} <Button onClick={() => setTick((v) => v + 1)}>{t.retry}</Button>
        </p>
      )}
      {!entry && !error && <p role="status">{t.loading}</p>}
      {entry?.aliases.length ? (
        <p>
          <strong>{t.conceptAliases}:</strong> {entry.aliases.join(' · ')}
        </p>
      ) : null}
      {entry?.senses
        .filter((sense) => !reference.meaningIds || reference.meaningIds.includes(sense.id))
        .map((sense, i) => (
          <section className="glossary-sense" key={sense.id}>
            <header>
              <h4>{sense.label || `${t.meaning} ${i + 1}`}</h4>
              <Badge tone={sense.reviewed ? 'success' : 'warning'}>
                {sense.reviewed ? t.reviewed : t.notReviewed}
              </Badge>
            </header>
            <div className="glossary-definition">
              <Markdown remarkPlugins={[remarkGfm]}>{sense.definition}</Markdown>
            </div>
            {!!sense.sources.length && (
              <div>
                <h5>{t.sourceReferences}</h5>
                {sense.sources.map((source, k) => (
                  <div className="glossary-source" key={k}>
                    <button
                      disabled={pending}
                      className="text-link"
                      onClick={() => void jump(source)}
                    >
                      {catalog.files.find((f) => f.id === source.sourceId)?.name ||
                        t.sourceUnavailable}
                      {source.location?.page
                        ? ` · ${t.page} ${source.location.page}`
                        : source.location?.seconds != null
                          ? ` · ${source.location.seconds}s`
                          : ''}
                    </button>
                    {source.location?.quote && <blockquote>{source.location.quote}</blockquote>}
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
      <div className="glossary-actions">
        {latest && (
          <Button
            onClick={() => {
              close();
              openConcept(reference.id);
            }}
          >
            {t.openCurrentConcept}
          </Button>
        )}
        {useLatest &&
          latest &&
          !latest.archived &&
          !latest.mergedInto &&
          latest.version !== reference.version && (
            <Button
              variant="primary"
              onClick={() => {
                useLatest(latest as GlossaryEntry);
                close();
              }}
            >
              {t.useLatestConcept}
            </Button>
          )}
      </div>
    </Modal>
  );
}
