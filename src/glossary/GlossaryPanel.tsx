import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { StudyMarkdown } from '../study/StudyMarkdown';
import {
  Plus,
  ArrowLeft,
  Pencil,
  Archive,
  History,
  RotateCcw,
  Search,
  Link as LinkIcon,
  ArrowUpRight,
  BookOpen,
  FileText,
  Network,
  SlidersHorizontal,
  ChevronRight,
  Merge,
} from 'lucide-react';
import type { Catalog, ConceptSource, PublicLearning, Source } from '../../shared/domain';
import type { SourceLocation } from '../../shared/annotations';
import { normalizeConcept, type GlossaryEntry, type GlossarySummary } from '../../shared/glossary';
import { api } from '../api';
import { Badge, Button, IconButton } from '../design/components';
import { GlossaryEditor } from './GlossaryEditor';
import type { TreeActions } from '../workspace/DirectoryTree';
import type { T } from '../i18n';

type Revision = {
  version: number;
  term: string;
  archived: boolean;
  reviewed: boolean;
  updatedAt: string | null;
};
type Page = { items: GlossarySummary[]; nextCursor: string | null; total: number };
const preference = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(`tl:glossary:${key}`) || fallback;
  } catch {
    return fallback;
  }
};
function Relation({
  title,
  description,
  open,
  t,
}: {
  title: string;
  description: string;
  open: () => void;
  t: T;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <section className="glossary-relation">
      <button onClick={open}>
        <Network />
        {title}
        <ChevronRight />
      </button>
      <p className={expanded ? '' : 'clamped'}>{description}</p>
      {description.length > 100 && (
        <button type="button" className="text-link" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t.showLess : t.showMore}
        </button>
      )}
    </section>
  );
}
export function GlossaryPanel({
  catalog,
  focusRequest,
  source,
  openSourceIds,
  t,
  actions,
  changed,
  navigate,
  onError,
}: {
  catalog: Catalog;
  focusRequest: { id: string; nonce: string } | null;
  source: Source | null;
  openSourceIds: string[];
  t: T;
  actions: TreeActions;
  changed: () => Promise<unknown>;
  navigate: (sourceId: string, location: SourceLocation) => void;
  onError: (message: string) => void;
}) {
  const [scope, setScope] = useState(() => preference('scope', 'all'));
  const [query, setQuery] = useState(() => preference('query', ''));
  const [archived, setArchived] = useState(() => preference('archived', 'false') === 'true');
  const [reviewed, setReviewed] = useState(() => preference('reviewed', 'all'));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [search, setSearch] = useState(query),
    [page, setPage] = useState<Page>({ items: [], nextCursor: null, total: 0 });
  const [loading, setLoading] = useState(false),
    [tick, setTick] = useState(0);
  const [entry, setEntry] = useState<GlossaryEntry | null>(null),
    [editing, setEditing] = useState<GlossaryEntry | null>(null);
  const [trail, setTrail] = useState<string[]>([]),
    [visited, setVisited] = useState<string[]>([]);
  const [revisionPreview, setRevisionPreview] = useState<GlossaryEntry | null>(null);
  const [versions, setVersions] = useState<Revision[] | null>(null),
    [historyAfter, setHistoryAfter] = useState<string | null>(null);
  const [pending, setPending] = useState(false),
    [mergeId, setMergeId] = useState(''),
    [merging, setMerging] = useState(false);
  const detail = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null),
    sentinel = useRef<HTMLDivElement>(null),
    listScroll = useRef(0);
  const focusedIds = scope === 'active' ? (source ? [source.id] : []) : [...new Set(openSourceIds)];
  const sourceKey = scope === 'all' ? '' : [...focusedIds].sort().join(',');
  const emptyScope = scope !== 'all' && !sourceKey;
  const params = new URLSearchParams({
    q: search,
    archived: String(archived),
    reviewed,
    ...(sourceKey ? { sources: sourceKey } : {}),
  });
  const paramsKey = params.toString();
  useLayoutEffect(() => {
    if (entry && !editing) {
      const scroller = detail.current?.closest('.study-content');
      if (scroller) scroller.scrollTop = 0;
    }
  }, [entry?.id, editing]);
  const generation = useRef(0),
    loadingMore = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    for (const [key, value] of Object.entries({
      scope,
      query,
      archived: String(archived),
      reviewed,
    }))
      localStorage.setItem(`tl:glossary:${key}`, value);
  }, [scope, query, archived, reviewed]);
  useEffect(() => {
    const current = ++generation.current;
    setLoading(true);
    loadingMore.current = false;
    if (emptyScope) {
      setPage({ items: [], nextCursor: null, total: 0 });
      setLoading(false);
      return;
    }
    void api<Page>(`/glossary?${paramsKey}`)
      .then((value) => {
        if (current === generation.current) setPage(value);
      })
      .catch((e) => {
        if (current === generation.current) onError(e.message);
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
  }, [paramsKey, emptyScope, tick, catalog.concepts]);
  const more = async () => {
    if (!page.nextCursor || loadingMore.current || loading) return;
    const current = generation.current;
    loadingMore.current = true;
    try {
      const result = await api<Page>(
        `/glossary?${paramsKey}&after=${encodeURIComponent(page.nextCursor)}`,
      );
      if (current === generation.current)
        setPage((v) => ({
          ...result,
          items: [
            ...v.items,
            ...result.items.filter((item) => !v.items.some((old) => old.id === item.id)),
          ],
        }));
    } catch (e) {
      onError(e instanceof Error ? e.message : t.error);
    } finally {
      if (current === generation.current) loadingMore.current = false;
    }
  };
  useEffect(() => {
    if (!sentinel.current || !page.nextCursor || entry || editing) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void more();
      },
      { root: list.current, rootMargin: '100px' },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [page.nextCursor, loading, entry, editing]);
  useEffect(() => {
    if (!entry && !editing && list.current) list.current.scrollTop = listScroll.current;
  }, [entry, editing]);
  const task = async (work: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    try {
      await work();
    } catch (e) {
      onError(e instanceof Error ? e.message : t.error);
    } finally {
      setPending(false);
    }
  };
  const open = async (id: string, push = true) => {
    if (list.current) listScroll.current = list.current.scrollTop;
    await task(async () => {
      const value = await api<GlossaryEntry>(`/glossary/${id}`);
      if (push && entry) setTrail((v) => [...v, entry.id]);
      setEntry(value);
      setEditing(null);
      setVersions(null);
      setRevisionPreview(null);
      setMerging(false);
      setVisited((v) => [id, ...v.filter((old) => old !== id)].slice(0, 20));
    });
  };
  useEffect(() => {
    if (focusRequest) void open(focusRequest.id);
  }, [focusRequest?.nonce]);
  const back = () => {
    if (trail.length) {
      const id = trail.at(-1)!;
      setTrail((v) => v.slice(0, -1));
      void open(id, false);
    } else {
      setEntry(null);
      setVersions(null);
      setMerging(false);
    }
  };
  const save = async (value: GlossaryEntry) => {
    const saved = await api<GlossaryEntry>(`/glossary/${value.id}`, 'PUT', {
      ...value,
      mutationId: crypto.randomUUID(),
    });
    setEntry(saved);
    setEditing(null);
    setVersions(null);
    setTick((v) => v + 1);
    await changed();
  };
  const jump = async (reference: ConceptSource) => {
    const file = catalog.files.find((f) => f.id === reference.sourceId);
    if (!file || file.version !== reference.sourceVersion) {
      onError(t.sourceUnavailable);
      return;
    }
    try {
      let location = reference.location || {};
      if (reference.segmentIds.length) {
        const learning = await api<PublicLearning | null>(`/learning/${file.id}`);
        const segment =
          learning?.sourceVersion === reference.sourceVersion
            ? learning.segments.find((s) => reference.segmentIds.includes(s.id))
            : null;
        if (segment)
          location = {
            ...location,
            ...(segment.page ? { page: segment.page } : {}),
            ...(segment.start != null ? { seconds: segment.start } : {}),
            quote: segment.text.slice(0, 8000),
          };
      }
      navigate(file.id, location);
    } catch (e) {
      onError(e instanceof Error ? e.message : t.error);
    }
  };
  const history = async (after?: string) => {
    if (!entry) return;
    await task(async () => {
      const value = await api<{ items: Revision[]; nextCursor: string | null }>(
        `/glossary/${entry.id}/history${after ? `?after=${encodeURIComponent(after)}` : ''}`,
      );
      setVersions((v) => (after ? [...(v || []), ...value.items] : value.items));
      setHistoryAfter(value.nextCursor);
    });
  };
  const newEntry = () => {
    setEditing(
      normalizeConcept({
        id: crypto.randomUUID(),
        term: '',
        definition: '',
        version: 0,
        reviewed: false,
        proposals: [],
        sources: [],
      }),
    );
    setVersions(null);
  };
  const name = (id: string) =>
    catalog.concepts.find((c) => c.id === id)?.term || t.sourceUnavailable;
  const incoming = entry
    ? catalog.concepts
        .filter((c) => c.id !== entry.id && !c.archived)
        .flatMap((c) =>
          normalizeConcept(c).senses.flatMap((s) => [
            ...(s.synonyms.includes(entry.id) ? [{ id: c.id, description: t.linkedSynonym }] : []),
            ...s.relations
              .filter((r) => r.entryId === entry.id)
              .map((r) => ({ id: c.id, description: r.description })),
          ]),
        )
    : [];
  if (editing)
    return (
      <GlossaryEditor
        key={`${editing.id}-${editing.version}`}
        initial={editing}
        catalog={catalog}
        actions={actions}
        t={t}
        save={save}
        cancel={() => setEditing(null)}
      />
    );
  if (entry)
    return (
      <div className="glossary-detail" ref={detail}>
        <header>
          <Button variant="ghost" size="sm" disabled={pending} onClick={back}>
            <ArrowLeft />
            {t.glossary}
          </Button>
          <details className="glossary-visited">
            <summary aria-label={t.visitedConcepts} title={t.visitedConcepts}>
              <History />
            </summary>
            <div className="glossary-visited-menu" role="menu">
              {visited.map((id) => (
                <button key={id} disabled={pending} onClick={() => void open(id)}>
                  {name(id)}
                </button>
              ))}
            </div>
          </details>
        </header>
        <h2 title={`${t.revision} ${entry.version}`}>{entry.term}</h2>
        {entry.archived && (
          <div className="glossary-meta">
            <Badge tone="outline">{t.archived}</Badge>
          </div>
        )}
        {entry.mergedInto ? (
          <Button onClick={() => void open(entry.mergedInto!)}>
            {t.mergedConcept} {name(entry.mergedInto)}
          </Button>
        ) : (
          <div className="glossary-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setEditing(structuredClone(entry))}
            >
              <Pencil />
              {t.edit}
            </Button>
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => void history()}>
              <History />
              {t.versions}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => void task(() => save({ ...entry, archived: !entry.archived }))}
            >
              {entry.archived ? <RotateCcw /> : <Archive />}
              {entry.archived ? t.restore : t.archive}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={merging}
              disabled={pending}
              onClick={() => setMerging((v) => !v)}
            >
              <Merge />
              {t.mergeConcept}
            </Button>
          </div>
        )}
        {entry.mergedInto && (
          <Button disabled={pending} onClick={() => void history()}>
            <History size={14} />
            {t.versions}
          </Button>
        )}
        {entry.aliases.length > 0 && (
          <section>
            <h4>{t.conceptAliases}</h4>
            <p>{entry.aliases.join(' · ')}</p>
          </section>
        )}
        {merging && (
          <section className="glossary-merge">
            <h4>{t.mergeConcept}</h4>
            <p>{t.mergeConceptBody}</p>
            <label>
              {t.mergeDestination}
              <select value={mergeId} onChange={(e) => setMergeId(e.target.value)}>
                <option value="">{t.chooseConcept}</option>
                {catalog.concepts
                  .filter((c) => c.id !== entry.id && !c.archived && !c.mergedInto)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.term}
                    </option>
                  ))}
              </select>
            </label>
            {mergeId && (
              <blockquote>{catalog.concepts.find((c) => c.id === mergeId)?.definition}</blockquote>
            )}
            <Button
              disabled={pending || !mergeId}
              onClick={() =>
                void task(async () => {
                  const target = await api<GlossaryEntry>(`/glossary/${mergeId}`);
                  const saved = await api<GlossaryEntry>('/glossary/merge', 'POST', {
                    sourceId: entry.id,
                    sourceVersion: entry.version,
                    targetId: target.id,
                    targetVersion: target.version,
                    mutationId: crypto.randomUUID(),
                  });
                  setEntry(saved);
                  setMerging(false);
                  setMergeId('');
                  setTick((v) => v + 1);
                  await changed();
                })
              }
            >
              {t.confirmMerge}
            </Button>
          </section>
        )}
        {versions && (
          <section className="glossary-history">
            <header>
              <h4>{t.versions}</h4>
              <Button onClick={() => setVersions(null)}>{t.close}</Button>
            </header>
            <p>{entry.mergedInto ? t.readVersionBody : t.restoreVersionBody}</p>
            {revisionPreview && (
              <section className="glossary-revision-preview">
                <header>
                  <h4>
                    {revisionPreview.term} · {t.revision} {revisionPreview.version}
                  </h4>
                  <Button onClick={() => setRevisionPreview(null)}>{t.close}</Button>
                </header>
                {revisionPreview.senses.map((sense) => (
                  <div key={sense.id}>
                    <h4>{sense.label}</h4>
                    <StudyMarkdown t={t}>{sense.definition}</StudyMarkdown>
                  </div>
                ))}
              </section>
            )}
            {versions.map((v) => (
              <button
                key={v.version}
                disabled={pending}
                onClick={() =>
                  void task(async () => {
                    const snapshot = await api<GlossaryEntry>(
                      `/glossary/${entry.id}/history/${v.version}`,
                    );
                    if (entry.mergedInto) {
                      setRevisionPreview(snapshot);
                      return;
                    }
                    setEditing({ ...snapshot, version: entry.version, proposals: entry.proposals });
                  })
                }
              >
                <span>
                  {t.revision} {v.version} · {v.term}
                </span>
                <small>
                  {v.updatedAt ? new Date(v.updatedAt).toLocaleString() : t.originalDefinition}
                </small>
              </button>
            ))}
            {historyAfter && (
              <Button disabled={pending} onClick={() => void history(historyAfter)}>
                {t.loadMore}
              </Button>
            )}
          </section>
        )}
        {entry.senses.map((sense, index) => (
          <section className="glossary-sense" key={sense.id}>
            <header>
              <h3>
                {index + 1}. {sense.label || t.meaning}
              </h3>
            </header>
            <div className="glossary-definition">
              <StudyMarkdown t={t}>{sense.definition}</StudyMarkdown>
            </div>
            {!!sense.synonyms.length && (
              <div>
                <h4>{t.linkedSynonyms}</h4>
                <div className="glossary-chips">
                  {sense.synonyms.map((id) => (
                    <button type="button" key={id} disabled={pending} onClick={() => void open(id)}>
                      <LinkIcon />
                      {name(id)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {!!sense.sources.length && (
              <div>
                <h4>{t.sourceReferences}</h4>
                {sense.sources.map((reference, i) => (
                  <div className="glossary-source" key={i}>
                    <button
                      className="glossary-source-chip"
                      title={`${t.sourceVersion} ${reference.sourceVersion}`}
                      onClick={() => void jump(reference)}
                    >
                      <FileText />
                      {catalog.files.find((f) => f.id === reference.sourceId)?.name ||
                        t.sourceUnavailable}
                      {reference.location?.page
                        ? ` · ${t.page} ${reference.location.page}`
                        : reference.location?.seconds != null
                          ? ` · ${reference.location.seconds}s`
                          : ''}
                      <ArrowUpRight />
                    </button>
                    {reference.location?.quote && (
                      <blockquote>{reference.location.quote}</blockquote>
                    )}
                  </div>
                ))}
              </div>
            )}
            {!!sense.relations.length && (
              <div>
                <h4>{t.semanticRelations}</h4>
                {sense.relations.map((r) => (
                  <Relation
                    key={r.entryId}
                    title={name(r.entryId)}
                    description={r.description}
                    t={t}
                    open={() => void open(r.entryId)}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
        {!!incoming.length && (
          <section>
            <h4>{t.incomingRelations}</h4>
            {incoming.map((r, i) => (
              <Relation
                key={`${r.id}-${i}`}
                title={name(r.id)}
                description={r.description}
                t={t}
                open={() => void open(r.id)}
              />
            ))}
          </section>
        )}
        {!!entry.proposals.length && (
          <section className="glossary-proposals">
            <h3>{t.proposedDefinitions}</h3>
            <p>{t.proposalsBody}</p>
            {entry.proposals.map((proposal) => (
              <section key={proposal.id}>
                <StudyMarkdown t={t}>{proposal.definition}</StudyMarkdown>
                <button className="text-link" onClick={() => void jump(proposal.source)}>
                  {catalog.files.find((f) => f.id === proposal.source.sourceId)?.name ||
                    t.sourceUnavailable}
                </button>
                <div className="glossary-actions">
                  <Button
                    disabled={pending}
                    onClick={() =>
                      void task(async () => {
                        setEntry(
                          await api<GlossaryEntry>(`/glossary/${entry.id}/proposals`, 'POST', {
                            version: entry.version,
                            mutationId: crypto.randomUUID(),
                            action: 'add',
                            proposalId: proposal.id,
                          }),
                        );
                        await changed();
                      })
                    }
                  >
                    {t.addAsMeaning}
                  </Button>
                  <details>
                    <summary>{t.replaceMeaning}</summary>
                    {entry.senses.map((sense, i) => (
                      <Button
                        key={sense.id}
                        disabled={pending}
                        onClick={() =>
                          void task(async () => {
                            setEntry(
                              await api<GlossaryEntry>(`/glossary/${entry.id}/proposals`, 'POST', {
                                version: entry.version,
                                mutationId: crypto.randomUUID(),
                                action: 'replace',
                                proposalId: proposal.id,
                                senseId: sense.id,
                              }),
                            );
                            await changed();
                          })
                        }
                      >
                        {sense.label || `${t.meaning} ${i + 1}`}
                      </Button>
                    ))}
                  </details>
                  <Button
                    disabled={pending}
                    onClick={() =>
                      void task(async () => {
                        setEntry(
                          await api<GlossaryEntry>(`/glossary/${entry.id}/proposals`, 'POST', {
                            version: entry.version,
                            mutationId: crypto.randomUUID(),
                            action: 'dismiss',
                            proposalId: proposal.id,
                          }),
                        );
                        await changed();
                      })
                    }
                  >
                    {t.dismiss}
                  </Button>
                </div>
              </section>
            ))}
          </section>
        )}
      </div>
    );
  const activeFilters = Number(scope !== 'all') + Number(archived) + Number(reviewed !== 'all');
  return (
    <div className="glossary-panel">
      <div className="annotation-panel-head">
        <div className="panel-title-row">
          <div>
            <p>{t.glossary}</p>
            <small>{t.glossarySubtitle}</small>
          </div>
          <IconButton label={t.newConcept} onClick={newEntry}>
            <Plus />
          </IconButton>
        </div>
        <div className="glossary-search-row">
          <div className="search-field">
            <Search />
            <input
              type="search"
              aria-label={t.searchConcepts}
              placeholder={t.searchConcepts}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="button button-default icon-button glossary-filter-toggle"
            aria-label={t.glossaryFilters}
            title={t.glossaryFilters}
            aria-expanded={filtersOpen}
            onClick={() => setFiltersOpen(!filtersOpen)}
          >
            <SlidersHorizontal />
            {activeFilters > 0 && <span className="filter-count">{activeFilters}</span>}
          </button>
        </div>
        {filtersOpen && (
          <div className="glossary-filters">
            <label>
              {t.glossaryScope}
              <select value={scope} onChange={(e) => setScope(e.target.value)}>
                <option value="all">{t.entireLibrary}</option>
                <option value="active">{t.currentFile}</option>
                <option value="open">{t.openResourcesScope}</option>
              </select>
            </label>
            <label>
              {t.status}
              <select
                value={String(archived)}
                onChange={(e) => setArchived(e.target.value === 'true')}
              >
                <option value="false">{t.activeConcepts}</option>
                <option value="true">{t.archived}</option>
              </select>
            </label>
            <label>
              {t.definitionReview}
              <select value={reviewed} onChange={(e) => setReviewed(e.target.value)}>
                <option value="all">{t.all}</option>
                <option value="true">{t.reviewed}</option>
                <option value="false">{t.notReviewed}</option>
              </select>
            </label>
          </div>
        )}
      </div>
      <p className="sr-only" role="status">
        {loading
          ? t.loading
          : `${page.total} ${page.total === 1 ? t.conceptSingular : t.conceptsCount}`}
      </p>
      <div
        className="glossary-list"
        ref={list}
        onScroll={(e) => {
          listScroll.current = e.currentTarget.scrollTop;
        }}
      >
        {!loading && !page.items.length && (
          <div className="panel-empty">
            <BookOpen />
            <strong>{t.noConceptsTitle}</strong>
            <p>{t.noConcepts}</p>
          </div>
        )}
        {page.items.map((item) => (
          <button
            className="glossary-summary"
            key={item.id}
            onClick={() => void open(item.id)}
            disabled={pending}
          >
            <span className="glossary-summary-head">
              <strong>{item.term}</strong>
              <ArrowUpRight aria-hidden="true" />
            </span>
            {item.match === 'synonym' && <small>{t.synonymMatch}</small>}
            <p>{item.preview}</p>
            <span className="glossary-meta">
              <Badge>
                <BookOpen />
                {item.senseCount}{' '}
                {item.senseCount === 1 ? t.meaning.toLocaleLowerCase() : t.meaningsCount}
              </Badge>
              <Badge tone="outline">
                <LinkIcon />
                {item.synonymCount} {item.synonymCount === 1 ? t.synonymSingular : t.synonymsCount}
              </Badge>
              <Badge tone="outline">
                <FileText />
                {item.sourceIds.length}{' '}
                {item.sourceIds.length === 1 ? t.source.toLocaleLowerCase() : t.sourcesCount}
              </Badge>
              <Badge tone="outline">
                <Network />
                {item.relationCount}{' '}
                {item.relationCount === 1 ? t.relationSingular : t.relationsCount}
              </Badge>
            </span>
            {item.proposalCount > 0 && (
              <Badge tone="warning">
                {item.proposalCount} {t.proposedDefinitions}
              </Badge>
            )}
          </button>
        ))}
        <div ref={sentinel} />
        {page.nextCursor && (
          <Button variant="ghost" size="sm" className="glossary-more" onClick={() => void more()}>
            {t.loadMore}
          </Button>
        )}
      </div>
    </div>
  );
}
