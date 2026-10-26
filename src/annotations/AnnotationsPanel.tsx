import { useEffect, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, RotateCcw, ExternalLink } from 'lucide-react';
import type { Annotation, AnnotationSummary, SourceLocation } from '../../shared/annotations';
import type { Catalog, Source } from '../../shared/domain';
import { sourceState } from '../../shared/directories';
import { api } from '../api';
import { Button, IconButton, Modal } from '../design/components';
import { DirectoryTree, type TreeActions } from '../workspace/DirectoryTree';
import { listAnnotations } from './api';
import { RichContent } from './RichContent';
import { StrokeLayer } from './Sketch';
import type { T } from '../i18n';

export function AnnotationsPanel({
  sessionId,
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
    [filter, setFilter] = useState<string | null>(null),
    [trash, setTrash] = useState(false),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [picker, setPicker] = useState(false),
    [query, setQuery] = useState(''),
    [opened, setOpened] = useState<Annotation | null>(null);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    let busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const value = await listAnnotations(sessionId);
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
  }, [sessionId, tick, refresh]);
  const selected = all ? filter : source?.id;
  const visible = items.filter(
    (item) => item.deleted === trash && (!selected || item.sourceId === selected),
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
            setFilter(null);
          }}
        >
          {t.currentResource}
        </Button>
        <Button aria-pressed={all} onClick={() => setAll(true)}>
          {t.allResources}
        </Button>
      </div>
      {all && (
        <div className="annotation-filter">
          <Button onClick={() => setPicker(true)}>
            {filter
              ? catalog.files.find((file) => file.id === filter)?.name || t.sourceUnavailable
              : t.filterResource}
          </Button>
          {filter && (
            <Button variant="ghost" onClick={() => setFilter(null)}>
              {t.clear}
            </Button>
          )}
        </div>
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
      {!loading && !visible.length && <p className="small-empty">{t.noNotes}</p>}
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
      {picker && (
        <Modal title={t.filterResource} close={() => setPicker(false)} closeLabel={t.close}>
          <input
            type="search"
            aria-label={t.search}
            placeholder={t.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <DirectoryTree
            directories={catalog.directories}
            files={catalog.files}
            t={t}
            mode="file"
            query={query}
            actions={actions}
            storageKey="tl:tree:annotation-filter"
            chooseFile={(file) => {
              setFilter(file.id);
              setPicker(false);
            }}
          />
        </Modal>
      )}
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
