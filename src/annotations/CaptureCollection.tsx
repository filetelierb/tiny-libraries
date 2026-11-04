import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Columns2,
  ImagePlus,
  LayoutGrid,
  Camera,
  MapPin,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import { stampIdentity, type PublishedCapture } from '../../shared/captures';
import type { Catalog, Source } from '../../shared/domain';
import type { SourceLocation } from '../../shared/locations';
import { sourceLocationStamp } from '../../shared/capture-source';
import type { TreeActions } from '../workspace/DirectoryTree';
import { CaptureSourcePicker, type CaptureSourceChoice } from './CaptureSourcePicker';
import { Button, IconButton, Modal } from '../design/components';
import type { T } from '../i18n';
import { CaptureWorkspace } from './CaptureWorkspace';
import { CaptureStudio } from './CaptureStudio';
import { captureSource } from './capture';
import { capturePreviewUrl, capturePath } from './captureClient';
import { api } from '../api';
import { stampLabel } from './captureLabels';
export { stampLabel } from './captureLabels';
import { captureDrawingSchema, type CaptureDrawing } from '../../shared/capture-drawing';

function sourcePaneTime(sourceId: string): number | undefined {
  const pane = [...document.querySelectorAll<HTMLElement>('[data-source-id]')].find(
    (node) => node.dataset.sourceId === sourceId,
  );
  const media = pane?.querySelector<HTMLMediaElement>('audio,video');
  return media && Number.isFinite(media.currentTime) ? media.currentTime : undefined;
}
function sourcePanePage(sourceId: string): number | undefined {
  const pane = [...document.querySelectorAll<HTMLElement>('[data-source-id]')].find(
    (node) => node.dataset.sourceId === sourceId,
  );
  const page = pane?.querySelector<HTMLElement>('[data-pdf-page]')?.dataset.pdfPage;
  return page ? Number(page) || undefined : undefined;
}

function shortTime(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds)),
    h = Math.floor(whole / 3600),
    m = Math.floor((whole % 3600) / 60),
    s = String(whole % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
async function normalizedImage(file: File, t: T) {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 20 * 1024 * 1024 ||
    !file.size
  )
    throw new Error(t.captureImageType);
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 64 * 1024 * 1024) throw new Error(t.captureImageType);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height)),
      canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error(t.error);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) =>
          blob && blob.size <= 8 * 1024 * 1024
            ? resolve(blob)
            : reject(new Error(t.captureImageType)),
        'image/png',
      ),
    );
  } finally {
    bitmap.close();
  }
}
export function CaptureCollectionEditor({
  catalog,
  actions,
  source,
  location,
  workspace,
  t,
  disabled = false,
}: {
  workspace: CaptureWorkspace;
  catalog: Catalog;
  actions: TreeActions;
  source: Source | null;
  location: SourceLocation;
  t: T;
  disabled?: boolean;
}) {
  const value = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot),
    [studio, setStudio] = useState<string | null>(null),
    [picker, setPicker] = useState<'capture' | 'location' | null>(null),
    [highlight, setHighlight] = useState<string | null>(null),
    [locationNotice, setLocationNotice] = useState(''),
    [gallery, setGallery] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0),
    [view, setView] = useState<'list' | 'grid'>('list'),
    [adding, setAdding] = useState(false),
    [cursor, setCursor] = useState(0),
    input = useRef<HTMLInputElement>(null);
  const missing = value.items
    .filter(
      (item) =>
        !item.version ||
        (item.localDrawingDigest && item.localDrawingDigest !== item.version.drawingDigest),
    )
    .map((item) => `${item.descriptor.id}:${item.localDrawingDigest || 'base'}`)
    .join(',');
  useEffect(() => {
    let alive = true;
    if (!missing) return;
    setBusy(true);
    void (async () => {
      for (const item of workspace.getSnapshot().items)
        if (
          !item.version ||
          (item.localDrawingDigest && item.localDrawingDigest !== item.version.drawingDigest)
        )
          await workspace.stageOne(item.descriptor.id);
    })()
      .then(() => {
        if (alive) setError('');
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : t.error);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [missing, retry]);
  useEffect(() => {
    if (highlight)
      document
        .getElementById(`capture-location-${highlight}`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [highlight]);
  async function chooseSource(file: Source, choice: CaptureSourceChoice, annotate: boolean) {
    const stamp =
      choice.location.page !== undefined ||
      choice.location.seconds !== undefined ||
      choice.location.quote
        ? sourceLocationStamp(file, choice.location)
        : undefined;
    if (picker === 'location') {
      if (!stamp) throw new Error(t.captureChooseSource);
      const result = await workspace.addStamp(stamp);
      setHighlight(result.id);
      setLocationNotice(result.added ? t.captureLocationAdded : t.captureLocationAlreadyAdded);
      return;
    }
    if (!choice.blob) throw new Error(t.captureNotReady);
    const id = await workspace.add(choice.blob, choice.origin, file.name, stamp, false, {
      id: file.id,
      version: file.version,
      name: file.name,
    });
    if (stamp) {
      const added = workspace
        .getSnapshot()
        .stamps.find((item) => stampIdentity(item) === stampIdentity(stamp));
      if (added) setHighlight(added.id);
    }
    if (annotate && id) {
      try {
        await workspace.stageOne(id);
        setStudio(id);
      } catch (e) {
        setError(e instanceof Error ? e.message : t.error);
      }
    }
  }
  function action(work: Promise<unknown>) {
    void work.catch((e) => setError(e instanceof Error ? e.message : t.error));
  }
  async function captureCurrentFrame(annotate: boolean) {
    if (!source) throw new Error(t.captureChooseSource);
    const current =
      source.kind === 'pdf'
        ? { page: sourcePanePage(source.id) ?? location.page ?? 1 }
        : { seconds: sourcePaneTime(source.id) ?? location.seconds ?? 0 };
    const stamp = sourceLocationStamp(source, current);
    const image = await captureSource(source, current);
    if (!image?.blob) throw new Error(t.captureNotReady);
    const id = await workspace.add(image.blob, 'image', source.name, stamp, false, {
      id: source.id,
      version: source.version,
      name: source.name,
    });
    if (annotate && id) {
      await workspace.stageOne(id);
      setStudio(id);
    }
  }
  const entries = value.items.flatMap((item) =>
      item.version ? [{ ...item.version, label: item.label }] : [],
    ),
    selected = value.items.find((item) => item.descriptor.id === studio);
  const total = value.items.length;
  const safeCursor = Math.max(0, Math.min(cursor, total - 1));
  if (total && cursor !== safeCursor) setCursor(safeCursor);
  const displayed = view === 'list' && total ? [value.items[safeCursor]] : value.items;
  return (
    <section className="capture-collection" aria-label={t.captureCollection}>
      <header className="capture-collection-head">
        <h3>
          {total === 1 ? t.captureCountSingular : t.captureCountPlural.replace('{n}', String(total))}
        </h3>
        <div className="capture-view-toggle" role="group" aria-label={t.captureViewToggle}>
          <IconButton
            label={t.captureViewList}
            aria-pressed={view === 'list'}
            onClick={() => setView('list')}
          >
            <Columns2 />
          </IconButton>
          <IconButton
            label={t.captureViewGrid}
            aria-pressed={view === 'grid'}
            onClick={() => setView('grid')}
          >
            <LayoutGrid />
          </IconButton>
        </div>
        {view === 'list' && total > 1 && (
          <div className="capture-pagination" aria-label={t.capturePagination}>
            <IconButton
              label={t.capturePrevious}
              disabled={safeCursor === 0}
              onClick={() => setCursor(safeCursor - 1)}
            >
              <ChevronLeft />
            </IconButton>
            <IconButton
              label={t.captureNext}
              disabled={safeCursor >= total - 1}
              onClick={() => setCursor(safeCursor + 1)}
            >
              <ChevronRight />
            </IconButton>
          </div>
        )}
      </header>
      <div className={`capture-collection-items capture-collection-${view}`}>
        {displayed.map((item) => {
          const index = value.items.indexOf(item);
          return (
            <article className="capture-tile" key={item.descriptor.id}>
              <button
                type="button"
                className="capture-tile-preview"
                aria-label={`${t.openCapture} ${index + 1}`}
                disabled={!item.version}
                onClick={() => setGallery(item.descriptor.id)}
              >
                {item.version ? (
                  <img
                    src={capturePreviewUrl(workspace.context.annotationId, item.version)}
                    alt={item.label || `${t.captureImage} ${index + 1}`}
                    loading="lazy"
                  />
                ) : (
                  <span>{t.captureLoading}</span>
                )}
              </button>
              <div className="capture-tile-bar">
                <span className="capture-tile-stamp">
                  {item.descriptor.stamp?.location.page !== undefined
                    ? `${t.page} ${item.descriptor.stamp.location.page}`
                    : item.descriptor.stamp?.location.seconds !== undefined
                      ? shortTime(item.descriptor.stamp.location.seconds)
                      : item.label || `${t.captureImage} ${index + 1}`}
                </span>
                <IconButton
                  label={`${t.captureEdit} ${index + 1}`}
                  disabled={
                    disabled ||
                    !item.version ||
                    (!!item.localDrawingDigest &&
                      item.localDrawingDigest !== item.version.drawingDigest)
                  }
                  onClick={() => setStudio(item.descriptor.id)}
                >
                  <Pencil />
                </IconButton>
                <IconButton
                  label={`${t.captureRemove} ${index + 1}`}
                  disabled={disabled}
                  onClick={() => action(workspace.remove(item.descriptor.id))}
                >
                  <X />
                </IconButton>
              </div>
            </article>
          );
        })}
      </div>
      <input
        className="sr-only"
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.currentTarget.value = '';
          if (!file) return;
          setBusy(true);
          void normalizedImage(file, t)
            .then((blob) => workspace.add(blob, 'image', file.name.slice(0, 240)))
            .catch((e) => setError(e instanceof Error ? e.message : t.error))
            .finally(() => setBusy(false));
        }}
      />
      <div className="capture-add">
        <Button
          className={adding ? 'capture-add-trigger active' : 'capture-add-trigger'}
          disabled={disabled || value.items.length >= 12}
          aria-expanded={adding}
          onClick={() => setAdding((v) => !v)}
        >
          <Camera />
          {t.captureAdd}
        </Button>
        {adding && (
          <div className="capture-add-options" role="group" aria-label={t.captureAdd}>
            {source && (source.kind === 'video' || source.kind === 'image' || source.kind === 'pdf') && (
              <>
                <Button
                  disabled={disabled || busy || value.items.length >= 12}
                  onClick={() => {
                    setAdding(false);
                    setBusy(true);
                    void captureCurrentFrame(false)
                      .catch((e) => setError(e instanceof Error ? e.message : t.error))
                      .finally(() => setBusy(false));
                  }}
                >
                  {t.captureFramePlain}
                </Button>
                <Button
                  disabled={disabled || busy || value.items.length >= 12}
                  onClick={() => {
                    setAdding(false);
                    setBusy(true);
                    void captureCurrentFrame(true)
                      .catch((e) => setError(e instanceof Error ? e.message : t.error))
                      .finally(() => setBusy(false));
                  }}
                >
                  {t.captureFrameAnnotated}
                </Button>
              </>
            )}
            <Button
              disabled={disabled || value.items.length >= 12}
              onClick={() => {
                setAdding(false);
                setPicker('capture');
              }}
            >
              {source && (source.kind === 'video' || source.kind === 'image' || source.kind === 'pdf')
                ? t.captureFrameSearch
                : t.captureFromLibrary}
            </Button>
            <Button
              disabled={disabled || value.items.length >= 12}
              onClick={() => {
                setAdding(false);
                input.current?.click();
              }}
            >
              <ImagePlus />
              {t.captureUpload}
            </Button>
          </div>
        )}
      </div>
      {value.stamps.length > 0 && (
        <div className="capture-stamp-chips" aria-label={t.captureLocations}>
          {value.stamps.map((stamp) => (
            <span
              key={stamp.id}
              id={`capture-location-${stamp.id}`}
              className={`capture-stamp-chip ${highlight === stamp.id ? 'highlight' : ''}`}
            >
              {stampLabel(stamp, t)}
              <button
                type="button"
                aria-label={`${t.captureRemoveLocation}: ${stamp.label}`}
                disabled={disabled}
                onClick={() =>
                  action(workspace.setStamps(value.stamps.filter((item) => item.id !== stamp.id)))
                }
              >
                <X />
              </button>
            </span>
          ))}
          <Button
            className="capture-add-stamp"
            disabled={disabled || value.stamps.length >= 100}
            onClick={() => setPicker('location')}
          >
            <MapPin />
            {t.captureAddLocation}
          </Button>
        </div>
      )}
      {value.stamps.length === 0 && (
        <Button
          className="capture-add-stamp"
          disabled={disabled}
          onClick={() => setPicker('location')}
        >
          <MapPin />
          {t.captureAddLocation}
        </Button>
      )}
      {locationNotice && (
        <p role="status" className="capture-stamp-notice">
          {locationNotice}
        </p>
      )}
      {picker && (
        <CaptureSourcePicker
          catalog={catalog}
          actions={actions}
          initialSource={source}
          initialLocation={location}
          mode={picker}
          t={t}
          close={() => setPicker(null)}
          pick={chooseSource}
        />
      )}
      {busy && <p role="status">{t.capturePreviewUpdating}</p>}
      {error && (
        <div role="alert">
          <p className="form-error">{error}</p>
          <Button onClick={() => setRetry((v) => v + 1)}>{t.retry}</Button>
        </div>
      )}
      {selected && (
        <CaptureStudio workspace={workspace} entry={selected} t={t} close={() => setStudio(null)} />
      )}
      {gallery && (
        <CaptureGallery
          owner={workspace.context.annotationId}
          items={entries}
          initial={gallery}
          t={t}
          close={() => setGallery(null)}
        />
      )}
    </section>
  );
}
const CAPTURE_ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
export function CaptureGallery({
  owner,
  items,
  initial,
  t,
  close,
}: {
  owner: string;
  items: PublishedCapture[];
  initial: string;
  t: T;
  close: () => void;
}) {
  const [id, setId] = useState(initial),
    [zoom, setZoom] = useState(1),
    index = Math.max(
      0,
      items.findIndex((item) => item.id === id),
    ),
    item = items[index];
  if (!item) return null;
  function move(delta: number) {
    const next = items[index + delta];
    if (next) {
      setId(next.id);
      setZoom(1);
    }
  }
  return (
    <Modal
      title={`${t.captureGallery} · ${index + 1} / ${items.length}`}
      close={close}
      closeLabel={t.close}
      className="capture-gallery"
    >
      <div
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).tagName === 'INPUT') return;
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            move(-1);
          }
          if (e.key === 'ArrowRight') {
            e.preventDefault();
            move(1);
          }
        }}
      >
        <div className="capture-gallery-tools">
          <IconButton label={t.capturePrevious} disabled={index === 0} onClick={() => move(-1)}>
            <ChevronLeft />
          </IconButton>
          <span>{item.label || t.captureImage}</span>
          <IconButton
            label={t.captureNext}
            disabled={index === items.length - 1}
            onClick={() => move(1)}
          >
            <ChevronRight />
          </IconButton>
          <select
            className="capture-zoom"
            aria-label={t.zoom}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          >
            {CAPTURE_ZOOMS.map((value) => (
              <option key={value} value={value}>
                {value === 1 ? `${t.captureFit} · 100%` : `${Math.round(value * 100)}%`}
              </option>
            ))}
          </select>
          <a
            className="button"
            href={capturePreviewUrl(owner, item)}
            download={`capture-${item.id}.png`}
          >
            {t.captureDownloadImage}
          </a>
        </div>
        <div className="capture-gallery-scroll" tabIndex={0} aria-label={t.captureGalleryHelp}>
          <img
            src={capturePreviewUrl(owner, item)}
            alt={item.label || t.captureImage}
            style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
          />
        </div>
        {items.length > 1 && (
          <div className="capture-filmstrip" role="group" aria-label={t.captureGallery}>
            {items.map((entry, i) => (
              <button
                type="button"
                key={entry.id}
                aria-current={entry.id === item.id ? 'true' : undefined}
                onClick={() => {
                  setId(entry.id);
                  setZoom(1);
                }}
              >
                <img src={capturePreviewUrl(owner, entry)} alt="" loading="lazy" />
                <span>{entry.label || `${t.captureImage} ${i + 1}`}</span>
              </button>
            ))}
          </div>
        )}
        {item.stamp && <p>{stampLabel(item.stamp, t)}</p>}
        {!item.stamp && item.originSource && (
          <p>
            {item.originSource.name} · {t.sourceVersion} {item.originSource.version}
          </p>
        )}
        <DrawingNotes key={`${item.id}:${item.drawingDigest}`} owner={owner} item={item} t={t} />
      </div>
    </Modal>
  );
}
export function CaptureCollectionView({
  owner,
  items,
  t,
}: {
  owner: string;
  items: PublishedCapture[];
  t: T;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  return (
    <>
      <div className="capture-view-grid">
        {items.map((item, i) => (
          <button
            key={item.id}
            onClick={() => setOpened(item.id)}
            aria-label={`${t.openCapture} ${i + 1}`}
          >
            <img
              loading="lazy"
              src={capturePreviewUrl(owner, item)}
              alt={item.label || `${t.captureImage} ${i + 1}`}
            />
            <span>{item.label || `${t.captureImage} ${i + 1}`}</span>
          </button>
        ))}
      </div>
      {opened && (
        <CaptureGallery
          owner={owner}
          items={items}
          initial={opened}
          t={t}
          close={() => setOpened(null)}
        />
      )}
    </>
  );
}

function DrawingNotes({ owner, item, t }: { owner: string; item: PublishedCapture; t: T }) {
  const [drawing, setDrawing] = useState<CaptureDrawing | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void api(`${capturePath(owner, item.id)}/drawings/${item.drawingDigest}`)
      .then((raw) => {
        if (alive) setDrawing(captureDrawingSchema.parse(raw));
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : t.error);
      });
    return () => {
      alive = false;
    };
  }, [owner, item.id, item.drawingDigest]);
  const notes =
    drawing?.objects.flatMap((object) =>
      object.kind === 'comment'
        ? [`${object.number}. ${object.text}`]
        : object.kind === 'text'
          ? [object.text]
          : object.kind === 'spotlight' && object.caption
            ? [object.caption]
            : [],
    ) || [];
  return (
    <>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!!notes.length && (
        <details className="capture-drawing-notes">
          <summary>
            {t.captureDrawingNotes} · {notes.length}
          </summary>
          {notes.map((text, index) => (
            <p key={index}>{text}</p>
          ))}
        </details>
      )}
    </>
  );
}
