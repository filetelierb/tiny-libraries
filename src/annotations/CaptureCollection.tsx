import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  Pencil,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { PublishedCapture } from '../../shared/captures';
import { Button, IconButton, Modal } from '../design/components';
import type { T } from '../i18n';
import { CaptureWorkspace } from './CaptureWorkspace';
import { CaptureStudio } from './CaptureStudio';
import { capturePreviewUrl, capturePath } from './captureClient';
import { api } from '../api';
import { captureDrawingSchema, type CaptureDrawing } from '../../shared/capture-drawing';

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
  workspace,
  t,
  disabled = false,
}: {
  workspace: CaptureWorkspace;
  t: T;
  disabled?: boolean;
}) {
  const value = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot),
    [studio, setStudio] = useState<string | null>(null),
    [gallery, setGallery] = useState<string | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [retry, setRetry] = useState(0),
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
  function action(work: Promise<unknown>) {
    void work.catch((e) => setError(e instanceof Error ? e.message : t.error));
  }
  const entries = value.items.flatMap((item) =>
      item.version ? [{ ...item.version, label: item.label }] : [],
    ),
    selected = value.items.find((item) => item.descriptor.id === studio);
  return (
    <section className="capture-collection" aria-label={t.captureCollection}>
      <header>
        <h3>
          {t.captureCollection} <small>{value.items.length} / 12</small>
        </h3>
        <Button
          disabled={disabled || value.items.length >= 12}
          onClick={() => input.current?.click()}
        >
          <ImagePlus />
          {t.captureUpload}
        </Button>
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
      </header>
      {value.items.length === 0 && <p className="small-empty">{t.captureEmpty}</p>}
      <div className="capture-collection-grid">
        {value.items.map((item, index) => (
          <article className="capture-tile" key={item.descriptor.id}>
            <button
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
            <label>
              <span className="sr-only">
                {t.captureImageLabel} {index + 1}
              </span>
              <input
                aria-label={`${t.captureImageLabel} ${index + 1}`}
                maxLength={240}
                value={item.label}
                disabled={disabled}
                onChange={(e) => action(workspace.setLabel(item.descriptor.id, e.target.value))}
              />
            </label>
            {item.descriptor.stamp && <small>{stampLabel(item.descriptor.stamp, t)}</small>}
            <div className="capture-tile-actions">
              <Button
                disabled={
                  disabled ||
                  !item.version ||
                  (!!item.localDrawingDigest &&
                    item.localDrawingDigest !== item.version.drawingDigest)
                }
                onClick={() => setStudio(item.descriptor.id)}
              >
                <Pencil />
                {t.captureEdit}
              </Button>
              <IconButton
                label={`${t.captureMoveEarlier} ${index + 1}`}
                disabled={disabled || index === 0}
                onClick={() => action(workspace.move(item.descriptor.id, -1))}
              >
                <ArrowLeft />
              </IconButton>
              <IconButton
                label={`${t.captureMoveLater} ${index + 1}`}
                disabled={disabled || index === value.items.length - 1}
                onClick={() => action(workspace.move(item.descriptor.id, 1))}
              >
                <ArrowRight />
              </IconButton>
              <IconButton
                label={`${t.captureRemove} ${index + 1}`}
                disabled={disabled}
                onClick={() => action(workspace.remove(item.descriptor.id))}
              >
                <Trash2 />
              </IconButton>
            </div>
          </article>
        ))}
      </div>
      {!!value.stamps.length && (
        <div className="capture-location-list">
          <h4>{t.captureLocations}</h4>
          {value.stamps.map((stamp) => (
            <div key={stamp.id}>
              <span>{stampLabel(stamp, t)}</span>
              <IconButton
                label={`${t.captureRemoveLocation}: ${stamp.label}`}
                disabled={disabled}
                onClick={() =>
                  action(workspace.setStamps(value.stamps.filter((item) => item.id !== stamp.id)))
                }
              >
                <Trash2 />
              </IconButton>
            </div>
          ))}
        </div>
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
export function stampLabel(
  stamp: { label: string; location: { page?: number; seconds?: number; quote?: string } },
  t: T,
) {
  const where =
    stamp.location.page !== undefined
      ? `${t.page} ${stamp.location.page}`
      : stamp.location.seconds !== undefined
        ? `${Math.floor(stamp.location.seconds / 60)}:${String(Math.floor(stamp.location.seconds % 60)).padStart(2, '0')}`
        : stamp.location.quote?.slice(0, 100) || '';
  return `${stamp.label} · ${where}`;
}
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
          <IconButton
            label={t.captureZoomOut}
            disabled={zoom <= 0.5}
            onClick={() => setZoom((v) => Math.max(0.5, v / 1.25))}
          >
            <ZoomOut />
          </IconButton>
          <Button onClick={() => setZoom(1)}>
            {t.captureFit} · {Math.round(zoom * 100)}%
          </Button>
          <IconButton
            label={t.captureZoomIn}
            disabled={zoom >= 4}
            onClick={() => setZoom((v) => Math.min(4, v * 1.25))}
          >
            <ZoomIn />
          </IconButton>
        </div>
        <div className="capture-gallery-scroll" tabIndex={0} aria-label={t.captureGalleryHelp}>
          <img
            src={capturePreviewUrl(owner, item)}
            alt={item.label || t.captureImage}
            style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
          />
        </div>
        {item.stamp && <p>{stampLabel(item.stamp, t)}</p>}
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
