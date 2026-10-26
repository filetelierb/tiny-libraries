import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { ChevronLeft, ChevronRight, Minus, Plus, LoaderCircle } from 'lucide-react';
import type { Source } from '../shared/domain';
import type { Annotation, SourceLocation, DrawingStroke } from '../shared/annotations';
import { listAnnotations } from './annotations/api';
import { api } from './api';
import { StrokeLayer } from './annotations/Sketch';
import { boundedPage, pdfScale, readPdfZoom, type PdfZoom } from '../shared/pdf-reader';
import { IconButton } from './design/components';
import type { T } from './i18n';

GlobalWorkerOptions.workerSrc = workerUrl;
type Page = { number: number; width: number; height: number; userUnit: number };

export default function PdfViewer({
  source,
  t,
  position,
  onPosition,
  seek,
  sessionId,
  annotationTick,
  onSelection,
}: {
  source: Source;
  sessionId: string;
  annotationTick: number;
  onSelection: (value: SourceLocation) => void;
  t: T;
  position: number;
  onPosition: (page: number) => void;
  seek: { value: number; nonce: number } | null;
}) {
  const scroll = useRef<HTMLDivElement>(null),
    documentRef = useRef<PDFDocumentProxy | null>(null),
    positionCallback = useRef(onPosition),
    initialPage = useRef(Math.max(1, position || 1));
  positionCallback.current = onPosition;
  const storageKey = `tl:pdf-zoom:${source.id}:v${source.version}`;
  const [markups, setMarkups] = useState<Annotation[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const summaries = (await listAnnotations(sessionId, source.id)).filter(
        (item) => !item.deleted && item.strokeCount && item.sourceVersion === source.version,
      );
      const values: Annotation[] = [];
      for (let index = 0; index < summaries.length && !cancelled; index += 5)
        values.push(
          ...(await Promise.all(
            summaries
              .slice(index, index + 5)
              .map((item) => api<Annotation>(`/annotations/${item.id}`)),
          )),
        );
      if (!cancelled) setMarkups(values);
    };
    void load().catch(() => {});
    const timer = setInterval(() => void load().catch(() => {}), 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, source.id, source.version, annotationTick]);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null),
    [pages, setPages] = useState<Page[]>([]),
    [page, setPage] = useState(Math.max(1, position || 1)),
    [pageInput, setPageInput] = useState(String(Math.max(1, position || 1))),
    [size, setSize] = useState({ width: 800, height: 700 }),
    [error, setError] = useState(''),
    [zoom, setZoom] = useState<PdfZoom>(() => {
      try {
        return readPdfZoom(JSON.parse(localStorage.getItem(storageKey) || 'null'));
      } catch {
        return 'width';
      }
    });
  useLayoutEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0)
        setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(zoom));
    } catch {}
  }, [storageKey, zoom]);
  useEffect(() => {
    let cancelled = false;
    const task = getDocument({
      url: `/api/files/${source.id}/content`,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
    });
    void task.promise
      .then(async (pdf) => {
        if (cancelled) return;
        documentRef.current = pdf;
        setDocument(pdf);
        const metadata: Page[] = [];
        for (let index = 1; index <= pdf.numPages && !cancelled; index++) {
          const page = await pdf.getPage(index),
            viewport = page.getViewport({ scale: 1 });
          metadata.push({
            number: index,
            width: viewport.width,
            height: viewport.height,
            userUnit: page.userUnit,
          });
        }
        if (!cancelled) setPages(metadata);
      })
      .catch(() => {
        if (!cancelled) setError(t.pdfLoadError);
      });
    return () => {
      cancelled = true;
      documentRef.current = null;
      void task.destroy().catch(() => {});
    };
  }, [source.id, source.version]);
  const navigate = (value: number) => {
    const next = boundedPage(value, documentRef.current?.numPages || 1);
    const target = scroll.current?.querySelector<HTMLElement>(`[data-pdf-page="${next}"]`);
    if (target && scroll.current) scroll.current.scrollTop = target.offsetTop - 16;
    setPage(next);
    setPageInput(String(next));
    positionCallback.current(next);
  };
  const loaded = pages.length > 0;
  useLayoutEffect(() => {
    if (loaded) navigate(initialPage.current);
  }, [loaded]);
  useEffect(() => {
    if (loaded && seek) navigate(seek.value);
  }, [seek?.nonce, loaded]);
  useLayoutEffect(() => {
    if (loaded) navigate(page);
  }, [zoom, loaded, size.width, size.height]);
  const trackPage = () => {
    const root = scroll.current;
    if (!root) return;
    const start = root.scrollTop,
      end = start + root.clientHeight;
    const elements = [...root.querySelectorAll<HTMLElement>('[data-pdf-page]')];
    const current = elements.reduce<HTMLElement | undefined>((best, element) => {
      const visible = Math.max(
        0,
        Math.min(end, element.offsetTop + element.offsetHeight) -
          Math.max(start, element.offsetTop),
      );
      const previous = best
        ? Math.max(
            0,
            Math.min(end, best.offsetTop + best.offsetHeight) - Math.max(start, best.offsetTop),
          )
        : -1;
      return visible > previous ? element : best;
    }, undefined);
    const next = current ? Number(current.dataset.pdfPage) : 1;
    if (next !== page) {
      setPage(next);
      setPageInput(String(next));
      positionCallback.current(next);
    }
  };
  const captureSelection = () => {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed) {
      onSelection({ page });
      return;
    }
    const anchor = selected.anchorNode?.parentElement?.closest<HTMLElement>('[data-pdf-page]');
    if (
      !anchor ||
      !scroll.current?.contains(anchor) ||
      !selected.focusNode ||
      !scroll.current.contains(selected.focusNode)
    )
      return;
    const quote = selected.toString().trim().slice(0, 8000);
    if (quote) onSelection({ page: Number(anchor.dataset.pdfPage), quote });
  };
  return (
    <div className="pdf-stage continuous-pdf">
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div
        ref={scroll}
        className="pdf-scroll"
        aria-label={source.name}
        tabIndex={0}
        onScroll={trackPage}
        onPointerUp={captureSelection}
        onKeyUp={captureSelection}
      >
        {!loaded && !error && (
          <p role="status" className="pdf-loading">
            <LoaderCircle className="spin" />
            {t.loadingPdf}
          </p>
        )}
        {document &&
          pages.map((item) => (
            <PdfPage
              key={item.number}
              document={document}
              page={item}
              scale={pdfScale(zoom, item, size)}
              scroll={scroll.current}
              t={t}
              strokes={markups
                .filter((markup) => markup.location.page === item.number)
                .flatMap((markup) => markup.strokes)}
            />
          ))}
      </div>
      <div className="pdf-controls">
        <IconButton
          label={t.previousPage}
          disabled={!loaded || page <= 1}
          onClick={() => navigate(page - 1)}
        >
          <ChevronLeft />
        </IconButton>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            navigate(Number(pageInput));
          }}
        >
          <label>
            {t.page}
            <input
              aria-label={t.page}
              type="number"
              min={1}
              max={document?.numPages || 1}
              value={pageInput}
              disabled={!loaded}
              onChange={(event) => setPageInput(event.target.value)}
              onBlur={() => navigate(Number(pageInput))}
            />
          </label>
        </form>
        <span>
          {t.of} {document?.numPages || '—'}
        </span>
        <IconButton
          label={t.nextPage}
          disabled={!loaded || page >= (document?.numPages || 1)}
          onClick={() => navigate(page + 1)}
        >
          <ChevronRight />
        </IconButton>
        <IconButton
          label={t.zoomOut}
          disabled={typeof zoom === 'number' && zoom <= 25}
          onClick={() => setZoom(readPdfZoom((typeof zoom === 'number' ? zoom : 100) - 25))}
        >
          <Minus />
        </IconButton>
        <select
          aria-label={t.zoom}
          value={zoom}
          onChange={(event) =>
            setZoom(
              readPdfZoom(
                event.target.value === 'width' || event.target.value === 'page'
                  ? event.target.value
                  : Number(event.target.value),
              ),
            )
          }
        >
          <option value="width">{t.fitWidth}</option>
          <option value="page">{t.fitPage}</option>
          {Array.from({ length: 12 }, (_, index) => (index + 1) * 25).map((value) => (
            <option key={value} value={value}>
              {value}%
            </option>
          ))}
        </select>
        <IconButton
          label={t.zoomIn}
          disabled={typeof zoom === 'number' && zoom >= 300}
          onClick={() => setZoom(readPdfZoom((typeof zoom === 'number' ? zoom : 100) + 25))}
        >
          <Plus />
        </IconButton>
      </div>
    </div>
  );
}

function PdfPage({
  document,
  page,
  scale,
  scroll,
  t,
  strokes,
}: {
  document: PDFDocumentProxy;
  strokes: DrawingStroke[];
  page: Page;
  scale: number;
  scroll: HTMLDivElement | null;
  t: T;
}) {
  const element = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    text = useRef<HTMLDivElement>(null);
  const [rendered, setRendered] = useState(false);
  const [visible, setVisible] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      root: scroll,
      rootMargin: '800px 0px',
    });
    if (element.current) observer.observe(element.current);
    return () => observer.disconnect();
  }, [scroll]);
  useEffect(() => {
    if (!visible || !canvas.current || !text.current) return;
    let cancelled = false,
      render: RenderTask | undefined,
      layer: TextLayer | undefined,
      loadedPage: PDFPageProxy | undefined;
    setError(false);
    setRendered(false);
    const canvasElement = canvas.current,
      textElement = text.current;
    void document
      .getPage(page.number)
      .then(async (pdfPage) => {
        if (cancelled) return;
        loadedPage = pdfPage;
        const viewport = pdfPage.getViewport({ scale }),
          pixelScale = Math.min(
            window.devicePixelRatio || 1,
            2,
            Math.sqrt(12000000 / (viewport.width * viewport.height)),
          );
        canvasElement.width = Math.max(1, Math.floor(viewport.width * pixelScale));
        canvasElement.height = Math.max(1, Math.floor(viewport.height * pixelScale));
        render = pdfPage.render({
          canvas: canvasElement,
          viewport,
          transform: pixelScale === 1 ? undefined : [pixelScale, 0, 0, pixelScale, 0, 0],
        });
        textElement.replaceChildren();
        layer = new TextLayer({
          textContentSource: pdfPage.streamTextContent(),
          container: textElement,
          viewport,
        });
        await Promise.all([render.promise, layer.render()]);
        if (!cancelled) setRendered(true);
      })
      .catch((error) => {
        if (!cancelled && error?.name !== 'RenderingCancelledException') setError(true);
      });
    return () => {
      cancelled = true;
      render?.cancel();
      layer?.cancel();
      textElement.replaceChildren();
      canvasElement.width = canvasElement.height = 0;
      loadedPage?.cleanup();
    };
  }, [document, page.number, visible, scale]);
  return (
    <section
      className="pdf-page"
      ref={element}
      data-pdf-page={page.number}
      data-render-ready={rendered && visible}
      aria-label={`${t.page} ${page.number}`}
      style={
        {
          width: page.width * scale,
          height: page.height * scale,
          '--total-scale-factor': scale * page.userUnit,
          '--scale-round-x': '1px',
          '--scale-round-y': '1px',
        } as CSSProperties
      }
    >
      <canvas ref={canvas} aria-hidden="true" />
      <div className="textLayer" ref={text} />
      {strokes.length > 0 && (
        <svg
          className="pdf-saved-markup"
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          role="img"
          aria-label={t.savedDrawing}
        >
          <StrokeLayer strokes={strokes} />
        </svg>
      )}
      {error && (
        <p role="alert" className="form-error">
          {t.pdfPageError} {page.number}
        </p>
      )}
    </section>
  );
}
