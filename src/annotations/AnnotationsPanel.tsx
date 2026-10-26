import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, RotateCcw, ExternalLink } from 'lucide-react';
import type { Annotation, AnnotationSummary, SourceLocation } from '../../shared/annotations';
import type { Catalog, Source } from '../../shared/domain';
import { sourceState } from '../../shared/directories';
import { api } from '../api';
import { Button, IconButton, Modal } from '../design/components';
import { DirectoryTree, type TreeActions } from '../workspace/DirectoryTree';
import { queryAnnotations } from './api';
import { RichContent } from './RichContent';
import { StrokeLayer } from './Sketch';
import type { T } from '../i18n';

export function AnnotationsPanel({
  sessionId,
  openSourceIds,
  source,
  catalog,
  t,
  tick,
  actions,
  create,
  edit,
  navigate,
  onError,
}: {
  sessionId: string;
  openSourceIds: string[];
  source: Source | null;
  catalog: Catalog;
  t: T;
  tick: number;
  actions: TreeActions;
  create: () => void;
  edit: (value: Annotation) => void;
  navigate: (sourceId: string, location: SourceLocation) => void;
  onError: (message: string) => void;
}) {
  const [items, setItems] = useState<AnnotationSummary[]>([]),
    [all, setAll] = useState(!source),
    [excluded, setExcluded] = useState<Set<string>>(() => new Set()),
    [includeSession, setIncludeSession] = useState(true),
    [trash, setTrash] = useState(false),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [query, setQuery] = useState(''),
    [opened, setOpened] = useState<Annotation | null>(null);
  const resourceKey = [...new Set(openSourceIds)].sort().join(',');
  const openIds = new Set(openSourceIds);
  const openFiles = catalog.files.filter(
    (file) => openIds.has(file.id) && sourceState(file, catalog.directories) !== 'trash',
  );
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setItems([]);
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const value = await queryAnnotations(
          sessionId,
          resourceKey ? resourceKey.split(',') : [],
          true,
        );
        if (!cancelled) setItems(value);
      } catch (error) {
        if (!cancelled) onError(error instanceof Error ? error.message : t.error);
      } finally {
        busy = false;
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [sessionId, resourceKey, tick, refresh]);
  useEffect(() => {
    if (!source) setAll(true);
  }, [source?.id]);
  const selectedIds = new Set(
    openFiles.filter((file) => !excluded.has(file.id)).map((file) => file.id),
  );
  const counts = new Map<string, number>();
  for (const item of items)
    if (item.sourceId && item.deleted === trash)
      counts.set(item.sourceId, (counts.get(item.sourceId) || 0) + 1);
  const visible = items.filter(
    (item) =>
      item.deleted === trash &&
      (all
        ? item.sourceId
          ? selectedIds.has(item.sourceId)
          : includeSession && item.sessionId === sessionId
        : item.sourceId === source?.id),
  );
  const open = async (item: AnnotationSummary, editing = false) => {
    try {
      const value = await api<Annotation>(`/annotations/${item.id}`);
      if (editing) edit(value);
      else setOpened(value);
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
    }
  };
  const remove = async (item: AnnotationSummary) => {
    try {
      await api(`/annotations/${item.id}`, 'PATCH', {
        deleted: !item.deleted,
        expectedRevision: item.revision,
      });
      setOpened(null);
      setRefresh((value) => value + 1);
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
      setRefresh((value) => value + 1);
    }
  };
  return (
    <>
      <div className="annotation-panel-head">
        <strong>{t.notes}</strong>
        <IconButton label={t.newAnnotation} onClick={create}>
          <Plus />
        </IconButton>
      </div>
      <div className="annotation-scope" role="group" aria-label={t.annotationScope}>
        <Button
          aria-pressed={!all}
          disabled={!source}
          onClick={() => {
            setAll(false);
          }}
        >
          {t.currentResource}
        </Button>
        <Button aria-pressed={all} onClick={() => setAll(true)}>
          {t.allResources}
        </Button>
      </div>
      {all && (
        <details className="annotation-resource-filter">
          <summary>
            {t.filterResources} · {selectedIds.size} / {openFiles.length}
          </summary>
          <div className="annotation-resource-filter-body">
            <p className="muted">{t.openSessionResources}</p>
            <div className="resource-filter-actions">
              <Button
                onClick={() => {
                  setExcluded(new Set());
                  setIncludeSession(true);
                }}
              >
                {t.selectAll}
              </Button>
              <Button
                onClick={() => {
                  setExcluded(new Set(openSourceIds));
                  setIncludeSession(false);
                }}
              >
                {t.selectNone}
              </Button>
              <span role="status">
                {selectedIds.size} / {openFiles.length} {t.resourcesSelected}
              </span>
            </div>
            <input
              type="search"
              aria-label={t.search}
              placeholder={t.search}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <DirectoryTree
              directories={catalog.directories}
              files={openFiles}
              t={t}
              mode="filter"
              query={query}
              actions={actions}
              storageKey="tl:tree:annotation-filter"
              selectedFileIds={selectedIds}
              fileCounts={counts}
              toggleFile={(file, checked) =>
                setExcluded((previous) => {
                  const next = new Set(previous);
                  if (checked) next.delete(file.id);
                  else next.add(file.id);
                  return next;
                })
              }
            />
            {items.some((item) => !item.sourceId && item.sessionId === sessionId) && (
              <label className="annotation-session-filter">
                <input
                  type="checkbox"
                  checked={includeSession}
                  onChange={(event) => setIncludeSession(event.target.checked)}
                />
                {t.includeSessionAnnotations}
              </label>
            )}
          </div>
        </details>
      )}
      <label className="annotation-trash">
        <input
          type="checkbox"
          checked={trash}
          onChange={(event) => setTrash(event.target.checked)}
        />
        {t.showDeletedAnnotations}
      </label>
      {loading && <p role="status">{t.loadingAnnotations}</p>}
      <p className="annotation-result-count" role="status">
        {!loading
          ? `${visible.length} ${visible.length === 1 ? t.annotationSingular : t.annotationCount}`
          : ''}
      </p>
      {!loading && !visible.length && (
        <p className="small-empty">
          {all && !openFiles.length && !items.some((item) => !item.sourceId)
            ? t.openResourcesForNotes
            : all && !selectedIds.size && !includeSession
              ? t.selectResourcesForNotes
              : t.noNotes}
        </p>
      )}
      {visible.map((item) => {
        const file = catalog.files.find((file) => file.id === item.sourceId),
          unavailable =
            !!item.sourceId && (!file || sourceState(file, catalog.directories) === 'trash');
        return (
          <article className="annotation-card" key={item.id}>
            <header>
              <button className="annotation-card-title" onClick={() => void open(item)}>
                {item.title || t.untitledAnnotation}
              </button>
              <small>{new Date(item.updatedAt).toLocaleDateString()}</small>
            </header>
            <p className="annotation-card-source">
              {file?.name || (item.sourceId ? t.sourceUnavailable : t.sessionAnnotation)}
              {item.location.page
                ? ` · ${t.page} ${item.location.page}`
                : item.location.seconds != null
                  ? ` · ${Math.floor(item.location.seconds / 60)}:${String(Math.floor(item.location.seconds % 60)).padStart(2, '0')}`
                  : ''}
            </p>
            {item.location.quote && <blockquote>{item.location.quote}</blockquote>}
            <AnnotationPreview
              key={`${item.id}:${item.revision}`}
              item={item}
              t={t}
              open={() => void open(item)}
            />
            <div className="annotation-card-actions">
              <Button onClick={() => void open(item)}>{t.readAnnotation}</Button>
              {!trash && (
                <IconButton
                  label={`${t.editAnnotation}: ${item.title || t.untitledAnnotation}`}
                  disabled={unavailable}
                  onClick={() => void open(item, true)}
                >
                  <Pencil />
                </IconButton>
              )}
              {item.sourceId && (
                <IconButton
                  label={t.openAnnotationSource}
                  disabled={unavailable}
                  onClick={() => navigate(item.sourceId!, item.location)}
                >
                  <ExternalLink />
                </IconButton>
              )}
              <IconButton
                label={trash ? t.restoreAnnotation : t.deleteAnnotation}
                onClick={() => void remove(item)}
              >
                {trash ? <RotateCcw /> : <Trash2 />}
              </IconButton>
            </div>
          </article>
        );
      })}
      {opened && (
        <Modal
          title={opened.title || t.untitledAnnotation}
          close={() => setOpened(null)}
          closeLabel={t.close}
        >
          {opened.location.quote && <blockquote>{opened.location.quote}</blockquote>}
          <RichContent document={opened.document} />
          {opened.capture && (
            <div
              className="sketch-surface annotation-capture"
              style={{ aspectRatio: `${opened.capture.width}/${opened.capture.height}` }}
            >
              <img
                src={`/api/annotations/${opened.id}/capture?v=${opened.capture.id}`}
                alt={t.capturePreview}
              />
              <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label={t.savedDrawing}>
                <StrokeLayer strokes={opened.strokes} />
              </svg>
            </div>
          )}
          <div className="modal-actions">
            <Button
              disabled={
                opened.deleted ||
                (!!opened.sourceId &&
                  !catalog.files.some(
                    (file) =>
                      file.id === opened.sourceId &&
                      sourceState(file, catalog.directories) !== 'trash',
                  ))
              }
              onClick={() => {
                edit(opened);
                setOpened(null);
              }}
            >
              {t.editAnnotation}
            </Button>
            <Button onClick={() => setOpened(null)}>{t.close}</Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function AnnotationPreview({ item, t, open }: { item: AnnotationSummary; t: T; open: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState<Annotation | null>(null);
  useEffect(() => {
    let cancelled = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void api<Annotation>(`/annotations/${item.id}`)
          .then((value) => {
            if (!cancelled) setValue(value);
          })
          .catch(() => {
            /* The summary remains readable if its rich preview is unavailable. */
          });
      },
      { rootMargin: '100px' },
    );
    if (root.current) observer.observe(root.current);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [item.id, item.revision]);
  return (
    <div ref={root}>
      {value ? (
        <div className="annotation-rich-preview">
          <RichContent document={value.document} />
        </div>
      ) : (
        <p>
          {item.text.slice(0, 240)}
          {item.text.length > 240 ? '…' : ''}
        </p>
      )}
      {item.capture && (
        <button className="annotation-thumbnail" onClick={open} aria-label={t.openCapture}>
          <span
            className="sketch-surface"
            style={{ aspectRatio: `${item.capture.width}/${item.capture.height}` }}
          >
            <img
              src={`/api/annotations/${item.id}/capture?v=${item.capture.id}`}
              alt={t.capturePreview}
              loading="lazy"
            />
            {value && (
              <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label={t.savedDrawing}>
                <StrokeLayer strokes={value.strokes} />
              </svg>
            )}
          </span>
        </button>
      )}
    </div>
  );
}
