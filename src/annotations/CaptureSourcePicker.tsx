import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ChevronLeft, ChevronRight, ImagePlus, MapPin, Pencil, Search } from 'lucide-react';
import type { Catalog, Source } from '../../shared/domain';
import { sourceState } from '../../shared/directories';
import type { SourceLocation } from '../../shared/locations';
import type { CaptureDescriptor } from '../../shared/captures';
import { captureContentUrl, captureTime } from '../../shared/capture-source';
import { formatTime } from '../../shared/media-controls';
import { boundedPage } from '../../shared/pdf-reader';
import { Button, IconButton, Modal } from '../design/components';
import { DirectoryTree, type TreeActions } from '../workspace/DirectoryTree';
import type { T } from '../i18n';
import { captureCanvasImage } from './capture';

GlobalWorkerOptions.workerSrc = workerUrl;
export type CaptureSourceChoice = {
  location: SourceLocation;
  blob?: Blob;
  origin: CaptureDescriptor['origin'];
};
export function CaptureSourcePicker({
  catalog,
  actions,
  initialSource,
  initialLocation,
  t,
  mode,
  close,
  pick,
}: {
  catalog: Catalog;
  actions: TreeActions;
  initialSource: Source | null;
  initialLocation: SourceLocation;
  t: T;
  mode: 'capture' | 'location';
  close: () => void;
  pick: (source: Source, choice: CaptureSourceChoice, annotate: boolean) => Promise<void>;
}) {
  const [source, setSource] = useState<Source | null>(
      initialSource &&
        (mode === 'location' || ['pdf', 'video', 'image'].includes(initialSource.kind))
        ? { ...initialSource }
        : null,
    ),
    [query, setQuery] = useState(''),
    [view, setView] = useState<'files' | 'archived'>('files'),
    [choice, setChoice] = useState<CaptureSourceChoice | null>(null),
    [excerpt, setExcerpt] = useState(''),
    [quoteMode, setQuoteMode] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const files = catalog.files.filter(
    (file) => mode === 'location' || ['pdf', 'video', 'image'].includes(file.kind),
  );
  const current = catalog.files.find((file) => file.id === source?.id),
    available =
      !!source &&
      current?.version === source.version &&
      sourceState(current, catalog.directories) !== 'trash';
  const isExcerpt =
    mode === 'location' &&
    (quoteMode || (!!source && !['pdf', 'audio', 'video'].includes(source.kind)));
  const selection =
    isExcerpt && excerpt.trim()
      ? { location: { quote: excerpt.trim() }, origin: 'text_excerpt' as const }
      : isExcerpt
        ? null
        : choice;
  async function confirm(annotate: boolean) {
    if (!source || !available || !selection || busy) return;
    setBusy(true);
    setError('');
    try {
      await pick(source, selection, annotate);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={mode === 'capture' ? t.captureFromLibrary : t.captureAddLocation}
      close={() => {
        if (!busy) close();
      }}
      closeLabel={t.close}
      className="capture-source-picker"
    >
      <p className="capture-picker-notice">{t.captureIndependentNotice}</p>
      <fieldset disabled={busy} className="capture-picker-fields">
        <div className="capture-picker-layout">
          <div className="capture-picker-tree">
            <label className="search-field">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                aria-label={t.search}
                placeholder={t.search}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="capture-picker-views">
              <Button aria-pressed={view === 'files'} onClick={() => setView('files')}>
                {t.files}
              </Button>
              <Button aria-pressed={view === 'archived'} onClick={() => setView('archived')}>
                {t.archived}
              </Button>
            </div>
            <DirectoryTree
              directories={catalog.directories}
              files={files}
              t={t}
              mode="file"
              view={view}
              query={query}
              active={source?.id}
              actions={actions}
              storageKey={`tl:tree:capture-${mode}`}
              chooseFile={(file) => {
                if (source?.id === file.id && source.version === file.version) return;
                setSource({ ...file });
                setChoice(null);
                setError('');
                setExcerpt('');
                setQuoteMode(false);
              }}
            />
          </div>
          <div className="capture-picker-preview">
            {!source ? (
              <p className="small-empty">{t.captureChooseSource}</p>
            ) : (
              <>
                <h3>{source.name}</h3>
                <small>
                  {t.sourceVersion} {source.version}
                </small>
                {!available && (
                  <p className="form-error" role="alert">
                    {t.captureSourceChanged}
                  </p>
                )}
                {mode === 'location' && ['pdf', 'audio', 'video'].includes(source.kind) && (
                  <label className="capture-excerpt-choice">
                    <input
                      type="checkbox"
                      checked={quoteMode}
                      onChange={(e) => setQuoteMode(e.target.checked)}
                    />
                    {t.captureUseExcerpt}
                  </label>
                )}
                {isExcerpt ? (
                  <label>
                    {t.captureExcerpt}
                    <textarea
                      aria-label={t.captureExcerpt}
                      maxLength={8000}
                      value={excerpt}
                      onChange={(e) => setExcerpt(e.target.value)}
                    />
                  </label>
                ) : (
                  <SourcePreview
                    key={`${source.id}:v${source.version}`}
                    source={source}
                    initial={source.id === initialSource?.id ? initialLocation : {}}
                    t={t}
                    ready={setChoice}
                  />
                )}
                {selection && (
                  <p role="status">
                    {selection.location.page !== undefined
                      ? `${t.page} ${selection.location.page}`
                      : selection.location.seconds !== undefined
                        ? `${formatTime(selection.location.seconds)} · ${selection.location.seconds.toFixed(3)} ${t.captureSeconds}`
                        : t.captureExcerpt}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </fieldset>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button
          variant="primary"
          disabled={busy || !available || !selection || (mode === 'capture' && !selection.blob)}
          onClick={() => void confirm(false)}
        >
          {mode === 'capture' ? <ImagePlus /> : <MapPin />}
          {mode === 'capture' ? t.captureAddClean : t.captureAddLocation}
        </Button>
        {mode === 'capture' && (
          <Button
            disabled={busy || !available || !selection?.blob}
            onClick={() => void confirm(true)}
          >
            <Pencil />
            {t.captureAddAnnotated}
          </Button>
        )}
        <Button disabled={busy} onClick={close}>
          {t.cancel}
        </Button>
      </div>
    </Modal>
  );
}
function SourcePreview({
  source,
  initial,
  t,
  ready,
}: {
  source: Source;
  initial: SourceLocation;
  t: T;
  ready: (choice: CaptureSourceChoice | null) => void;
}) {
  if (source.kind === 'pdf')
    return <PdfPagePreview source={source} initial={initial.page || 1} t={t} ready={ready} />;
  if (source.kind === 'video' || source.kind === 'audio')
    return <RecordingPreview source={source} initial={initial.seconds ?? 0} t={t} ready={ready} />;
  if (source.kind === 'image') return <ImagePreview source={source} t={t} ready={ready} />;
  return null;
}
function PdfPagePreview({
  source,
  initial,
  t,
  ready,
}: {
  source: Source;
  initial: number;
  t: T;
  ready: (choice: CaptureSourceChoice | null) => void;
}) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(initial),
    [text, setText] = useState(String(initial)),
    [preview, setPreview] = useState<Blob | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true);
  const currentChoice = useRef<CaptureSourceChoice | null>(null);
  useEffect(() => {
    let alive = true;
    const task = getDocument({
      url: captureContentUrl(source),
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
    });
    void task.promise
      .then((doc) => {
        if (alive) {
          const number = boundedPage(initial, doc.numPages);
          setPage(number);
          setText(String(number));
          setPdf(doc);
        }
      })
      .catch(() => {
        if (alive) {
          setError(t.pdfLoadError);
          setBusy(false);
        }
      });
    return () => {
      alive = false;
      ready(null);
      void task.destroy().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!pdf) return;
    let alive = true,
      render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    ready(null);
    currentChoice.current = null;
    setBusy(true);
    setError('');
    void (async () => {
      const sourcePage = await pdf.getPage(page);
      if (!alive) return;
      const base = sourcePage.getViewport({ scale: 1 }),
        scale = Math.min(2, 1600 / Math.max(base.width, base.height)),
        viewport = sourcePage.getViewport({ scale }),
        canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      render = sourcePage.render({ canvas, viewport });
      await render.promise;
      if (!alive) return;
      const blob = await captureCanvasImage(canvas, canvas.width, canvas.height);
      if (alive) {
        setPreview(blob);
        currentChoice.current = { blob, location: { page }, origin: 'pdf_page' };
        ready(currentChoice.current);
        setBusy(false);
      }
    })().catch((e) => {
      if (alive) {
        setError(e instanceof Error ? e.message : t.pdfLoadError);
        setBusy(false);
      }
    });
    return () => {
      alive = false;
      render?.cancel();
    };
  }, [pdf, page]);
  const url = useBlobUrl(preview);
  function choose(value: number) {
    if (!pdf) return;
    const number = boundedPage(value, pdf.numPages);
    ready(number === page ? currentChoice.current : null);
    setPage(number);
    setText(String(number));
  }
  return (
    <>
      <div className="capture-page-controls">
        <IconButton
          label={t.previousPage}
          disabled={!pdf || page <= 1}
          onClick={() => choose(page - 1)}
        >
          <ChevronLeft />
        </IconButton>
        <label>
          {t.page}
          <input
            type="number"
            aria-label={t.capturePage}
            min={1}
            max={pdf?.numPages || 1}
            value={text}
            disabled={!pdf}
            onChange={(e) => {
              setText(e.target.value);
              ready(null);
              if (
                e.target.value &&
                Number.isInteger(Number(e.target.value)) &&
                Number(e.target.value) >= 1 &&
                Number(e.target.value) <= (pdf?.numPages || 0)
              )
                if (Number(e.target.value) === page) ready(currentChoice.current);
                else setPage(Number(e.target.value));
            }}
            onBlur={() => choose(Number(text))}
          />
        </label>
        <span>
          {t.of} {pdf?.numPages || '…'}
        </span>
        <IconButton
          label={t.nextPage}
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => choose(page + 1)}
        >
          <ChevronRight />
        </IconButton>
      </div>
      {url && (
        <img
          className="capture-source-image"
          src={url}
          alt={`${source.name} · ${t.page} ${page}`}
          aria-busy={busy}
        />
      )}{' '}
      {busy && <p role="status">{t.captureLoading}</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </>
  );
}
function ImagePreview({
  source,
  t,
  ready,
}: {
  source: Source;
  t: T;
  ready: (choice: CaptureSourceChoice | null) => void;
}) {
  const serial = useRef(0),
    [error, setError] = useState('');
  useEffect(
    () => () => {
      serial.current++;
      ready(null);
    },
    [],
  );
  return (
    <>
      <img
        className="capture-source-image"
        src={captureContentUrl(source)}
        alt={source.name}
        onLoad={(e) => {
          const token = ++serial.current,
            image = e.currentTarget;
          void captureCanvasImage(image, image.naturalWidth, image.naturalHeight)
            .then((blob) => {
              if (serial.current === token) ready({ blob, location: {}, origin: 'image' });
            })
            .catch((e) => setError(e instanceof Error ? e.message : t.error));
        }}
        onError={() => setError(t.captureImageLoadError)}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
function RecordingPreview({
  source,
  initial,
  t,
  ready,
}: {
  source: Source;
  initial: number;
  t: T;
  ready: (choice: CaptureSourceChoice | null) => void;
}) {
  const media = useRef<HTMLMediaElement | null>(null),
    desired = useRef(initial),
    issued = useRef<number | null>(null),
    serial = useRef(0),
    validInput = useRef(true),
    alive = useRef(true),
    [duration, setDuration] = useState(0),
    [time, setTime] = useState(initial),
    [input, setInput] = useState(String(initial)),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true);
  const isVideo = source.kind === 'video';
  useEffect(() => {
    alive.current = true;
    const player = media.current;
    if (player) {
      player.muted = true;
      player.volume = 0;
    }
    return () => {
      alive.current = false;
      serial.current++;
      ready(null);
      if (player) {
        player.pause();
        player.removeAttribute('src');
        player.load();
      }
    };
  }, []);
  async function settled() {
    const player = media.current;
    if (!player || !alive.current || !validInput.current) return;
    player.pause();
    if (!Number.isFinite(player.duration) || player.duration <= 0) return;
    if (isVideo && issued.current !== desired.current) {
      if (player.seeking) return;
      issued.current = desired.current;
      if (Math.abs(player.currentTime - desired.current) > 1e-7) {
        player.currentTime = desired.current;
        return;
      }
    }
    if (isVideo && (player.seeking || player.readyState < 2)) return;
    const token = serial.current;
    try {
      const seconds = captureTime(
          isVideo ? player.currentTime : desired.current,
          player.duration,
          isVideo,
        ),
        blob = isVideo
          ? await captureCanvasImage(
              player as HTMLVideoElement,
              (player as HTMLVideoElement).videoWidth,
              (player as HTMLVideoElement).videoHeight,
            )
          : undefined;
      if (alive.current && token === serial.current && !player.seeking) {
        ready({ location: { seconds }, ...(blob ? { blob } : {}), origin: 'video_frame' });
        setTime(seconds);
        setInput(String(seconds));
        setBusy(false);
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : t.error);
        setBusy(false);
      }
    }
  }
  function seek(value: number) {
    const player = media.current;
    if (!player || !Number.isFinite(player.duration) || player.duration <= 0) return;
    const seconds = captureTime(value, player.duration, isVideo);
    desired.current = seconds;
    validInput.current = true;
    serial.current++;
    setTime(seconds);
    setInput(String(seconds));
    ready(null);
    setBusy(true);
    setError('');
    if (isVideo) {
      if (player.seeking) return;
      issued.current = seconds;
      if (Math.abs(player.currentTime - seconds) > 1e-7) {
        player.currentTime = seconds;
        return;
      }
    }
    void settled();
  }
  const properties = {
    src: captureContentUrl(source),
    muted: true,
    preload: 'auto' as const,
    onLoadedMetadata: () => {
      const player = media.current;
      if (!player) return;
      if (!Number.isFinite(player.duration) || player.duration <= 0) {
        setError(t.captureMediaLoadError);
        setBusy(false);
        return;
      }
      setDuration(player.duration);
      seek(initial);
    },
    onLoadedData: () => void settled(),
    onSeeked: () => void settled(),
    onError: () => {
      setError(t.captureMediaLoadError);
      setBusy(false);
      ready(null);
    },
    onPlay: (e: React.SyntheticEvent<HTMLMediaElement>) => e.currentTarget.pause(),
  };
  return (
    <>
      {isVideo ? (
        <video
          {...properties}
          ref={(node) => {
            media.current = node;
          }}
          playsInline
          disablePictureInPicture
          disableRemotePlayback
          className="capture-frame-preview"
          aria-label={t.captureFramePreview}
        />
      ) : (
        <audio
          {...properties}
          ref={(node) => {
            media.current = node;
          }}
          hidden
        />
      )}
      <p className="capture-picker-notice">
        {isVideo ? t.captureSilentFrame : t.captureSilentTime}
      </p>
      <div className="capture-time-controls">
        <IconButton
          label={t.captureEarlierFrame}
          disabled={!duration}
          onClick={() => seek(time - 0.1)}
        >
          <ChevronLeft />
        </IconButton>
        <input
          type="range"
          aria-label={t.captureFramePosition}
          min={0}
          max={duration ? captureTime(duration, duration, isVideo) : 1}
          step="0.001"
          value={time}
          disabled={!duration}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <IconButton
          label={t.captureLaterFrame}
          disabled={!duration}
          onClick={() => seek(time + 0.1)}
        >
          <ChevronRight />
        </IconButton>
      </div>
      <label>
        {t.captureSeconds}
        <input
          type="number"
          aria-label={t.captureSeconds}
          min={0}
          max={duration ? captureTime(duration, duration, isVideo) : 0}
          step="0.001"
          disabled={!duration}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            validInput.current = false;
            serial.current++;
            ready(null);
            if (
              e.target.value &&
              Number.isFinite(Number(e.target.value)) &&
              Number(e.target.value) >= 0 &&
              Number(e.target.value) <= duration
            )
              seek(Number(e.target.value));
          }}
          onBlur={() => seek(Number(input))}
        />
      </label>
      {busy && !error && <p role="status">{t.captureLoading}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
function useBlobUrl(blob: Blob | null) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) {
      setUrl('');
      return;
    }
    const value = URL.createObjectURL(blob);
    setUrl(value);
    return () => URL.revokeObjectURL(value);
  }, [blob]);
  return url;
}
