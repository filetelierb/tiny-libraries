import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileText, Paperclip, Pencil, Play, Plus, Search, StickyNote, Trash2 } from 'lucide-react';
import type { Annotation, AnnotationSummary, SourceLocation } from '../../shared/annotations';
import type { Catalog, Source } from '../../shared/domain';
import { sourceState } from '../../shared/directories';
import { api } from '../api';
import { Button, IconButton, Modal } from '../design/components';
import { DirectoryTree, type TreeActions } from '../workspace/DirectoryTree';
import { queryAnnotations } from './api';
import { RichContent } from './RichContent';
import { StrokeLayer } from './Sketch';
import { CaptureCollectionView, CaptureGallery, stampLabel } from './CaptureCollection';
import { capturePreviewUrl } from './captureClient';
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
  attach,
  composer,
  changed,
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
  attach: (item: AnnotationSummary) => void;
  composer?: ReactNode;
  changed?: () => void;
  onError: (message: string) => void;
}) {
  const [items, setItems] = useState<AnnotationSummary[]>([]),
    [all, setAll] = useState(!source),
    [excluded, setExcluded] = useState<Set<string>>(() => new Set()),
    [includeSession, setIncludeSession] = useState(true),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [query, setQuery] = useState(''),
    [opened, setOpened] = useState<Annotation | null>(null),
    [gallery, setGallery] = useState<{ item: Annotation; captureId: string } | null>(null),
    [deleteTarget, setDeleteTarget] = useState<string | null>(null);
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
    if (item.sourceId && !item.deleted)
      counts.set(item.sourceId, (counts.get(item.sourceId) || 0) + 1);
  const visible = items.filter(
    (item) =>
      !item.deleted &&
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
  const openGallery = async (item: AnnotationSummary, captureId: string) => {
    try {
      const value = await api<Annotation>(`/annotations/${item.id}`);
      setGallery({ item: value, captureId });
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
    }
  };
  const remove = async (item: AnnotationSummary) => {
    try {
      await api(`/annotations/${item.id}`, 'DELETE');
      setOpened(null);
      setRefresh((value) => value + 1);
      changed?.();
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
      setRefresh((value) => value + 1);
    }
  };
  return (
    <>
      <div className="annotation-panel-head">
        <div className="panel-title-row">
          <span className="panel-tile panel-tile-amber">
            <StickyNote />
          </span>
          <div>
            <p>{t.notes}</p>
            <small>{all ? t.openSessionResources : source?.name || t.selectMaterial}</small>
          </div>
          {!composer && (
            <IconButton label={t.newAnnotation} onClick={create}>
              <Plus />
            </IconButton>
          )}
        </div>
        {!composer && (
          <div className="segmented" role="tablist" aria-label={t.annotationScope}>
            <button
              type="button"
              role="tab"
              aria-selected={!all}
              disabled={!source}
              onClick={() => setAll(false)}
            >
              {t.currentResource}
            </button>
            <button type="button" role="tab" aria-selected={all} onClick={() => setAll(true)}>
              {t.allResources}
            </button>
          </div>
        )}
        {!composer && all && (
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
              <label className="search-field">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  aria-label={t.search}
                  placeholder={t.search}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
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
      </div>
      <div className="annotation-list">
        {composer}
        {loading && <p role="status">{t.loadingAnnotations}</p>}
        <p className="sr-only" role="status">
          {!loading
            ? `${visible.length} ${visible.length === 1 ? t.annotationSingular : t.annotationCount}`
            : ''}
        </p>
        {!loading && !visible.length && (
          <div className="panel-empty">
            <StickyNote />
            <strong>{t.noNotesTitle}</strong>
            <p>
              {all && !openFiles.length && !items.some((item) => !item.sourceId)
                ? t.openResourcesForNotes
                : all && !selectedIds.size && !includeSession
                  ? t.selectResourcesForNotes
                  : t.noNotes}
            </p>
          </div>
        )}
        {visible.map((item) => {
          const file = catalog.files.find((file) => file.id === item.sourceId),
            unavailable =
              !!item.sourceId && (!file || sourceState(file, catalog.directories) === 'trash');
          return (
            <article className="annotation-card" key={item.id}>
              {(all || unavailable) && (
                <p className="annotation-card-source" title={file?.name}>
                  <FileText />
                  <span>
                    {file?.name || (item.sourceId ? t.sourceUnavailable : t.sessionAnnotation)}
                    {item.location.page
                      ? ` · ${t.page} ${item.location.page}`
                      : item.location.seconds != null
                        ? ` · ${Math.floor(item.location.seconds / 60)}:${String(Math.floor(item.location.seconds % 60)).padStart(2, '0')}`
                        : ''}
                  </span>
                </p>
              )}
              <header className="annotation-card-actions">
                <IconButton
                  label={t.editAnnotation}
                  disabled={unavailable}
                  onClick={() => void open(item, true)}
                >
                  <Pencil />
                </IconButton>
                <IconButton
                  label={t.deleteAnnotation}
                  className="icon-button annotation-delete"
                  onClick={() => setDeleteTarget(item.id)}
                >
                  <Trash2 />
                </IconButton>
              </header>
              {(item.location.quote || item.quoteText) && (
                <blockquote className="annotation-card-quote">
                  {item.quoteText || item.location.quote}
                </blockquote>
              )}
              <AnnotationPreview
                key={`${item.id}:${item.revision}`}
                item={item}
                t={t}
                open={() => void open(item)}
                openCapture={(captureId) => void openGallery(item, captureId)}
              />
              {!!item.stamps?.length && (
                <div className="annotation-stamp-chips" role="group" aria-label={t.jumpToStamp}>
                  {item.stamps.map((stamp) => (
                    <button
                      type="button"
                      key={stamp.id}
                      className="annotation-stamp-chip"
                      onClick={() => navigate(stamp.sourceId, stamp.location)}
                      title={stampLabel(stamp, t)}
                    >
                      {stampLabel(stamp, t)}
                    </button>
                  ))}
                </div>
              )}
              <div className="annotation-card-meta">
                <span className={`annotation-origin origin-${item.origin}`}>
                  {item.origin === 'tutor' ? t.suggestedOrigin : t.personalOrigin}
                </span>
                <span className="annotation-card-date">
                  {new Date(item.updatedAt).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                  })}
                </span>
              </div>
              {deleteTarget === item.id ? (
                <div className="annotation-delete-confirm" role="group">
                  <p>{t.deleteAnnotationConfirm}</p>
                  <div>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(null)}>
                      {t.cancel}
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => {
                        setDeleteTarget(null);
                        void remove(item);
                      }}
                    >
                      <Trash2 />
                      {t.delete}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="annotation-card-actions">
                  <Button
                    size="sm"
                    disabled={!item.sourceId || unavailable}
                    onClick={() => item.sourceId && navigate(item.sourceId, item.location)}
                  >
                    <Play />
                    {t.reviewNote}
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={unavailable}
                    onClick={() => attach(item)}
                  >
                    <Paperclip />
                    {t.attachNote}
                  </Button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {gallery && !!gallery.item.captures?.length && (
        <CaptureGallery
          owner={gallery.item.id}
          items={gallery.item.captures}
          initial={gallery.captureId}
          t={t}
          close={() => setGallery(null)}
        />
      )}
      {opened && (
        <Modal
          title={opened.title || t.untitledAnnotation}
          close={() => setOpened(null)}
          closeLabel={t.close}
        >
          {opened.location.quote && <blockquote>{opened.location.quote}</blockquote>}
          <RichContent document={opened.document} t={t} />
          {opened.captures !== undefined && (
            <CaptureCollectionView owner={opened.id} items={opened.captures} t={t} />
          )}
          {!!opened.stamps?.length && (
            <div className="capture-read-locations">
              {opened.stamps.map((stamp) => (
                <Button
                  key={stamp.id}
                  onClick={() => {
                    navigate(stamp.sourceId, stamp.location);
                    setOpened(null);
                  }}
                >
                  {stampLabel(stamp, t)}
                </Button>
              ))}
            </div>
          )}
          {opened.captures === undefined && opened.capture && (
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

function AnnotationPreview({
  item,
  t,
  open,
  openCapture,
}: {
  item: AnnotationSummary;
  t: T;
  open: () => void;
  openCapture: (captureId: string) => void;
}) {
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
      <div
        role="button"
        tabIndex={0}
        className="annotation-card-body"
        title={t.readAnnotation}
        onClick={open}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
          }
        }}
      >
        {value ? (
          <div className="annotation-rich-preview">
            <RichContent document={value.document} t={t} />
          </div>
        ) : (
          <p>
            {item.text.slice(0, 240)}
            {item.text.length > 240 ? '…' : ''}
          </p>
        )}
      </div>
      {!!item.captures?.length && (
        <div className="annotation-capture-strip" aria-label={t.captureGallery}>
          {item.captures.slice(0, 4).map((capture, i) => (
            <button
              type="button"
              key={capture.id}
              className="annotation-capture-thumb"
              onClick={() => openCapture(capture.id)}
              aria-label={capture.label || `${t.captureImage} ${i + 1}`}
              title={capture.label || `${t.captureImage} ${i + 1}`}
            >
              <img
                loading="lazy"
                src={capturePreviewUrl(item.id, capture)}
                alt={capture.label || t.capturePreview}
              />
            </button>
          ))}
          {item.captures.length > 4 && (
            <button
              type="button"
              className="annotation-capture-more"
              onClick={() => item.captures && openCapture(item.captures[4].id)}
              aria-label={`${t.captureGallery} · ${item.captures.length}`}
            >
              +{item.captures.length - 4}
            </button>
          )}
        </div>
      )}
      {item.captures === undefined && item.capture && (
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
