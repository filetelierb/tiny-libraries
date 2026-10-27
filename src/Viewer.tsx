import { useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { FileWarning } from 'lucide-react';
import { parseCsv } from '../shared/csv';
import { StudyMarkdown } from './study/StudyMarkdown';
import type { Source, PublicLearning, Bookmark, Segment } from '../shared/domain';
import type { ReadingProgress } from '../shared/chapters';
import type { SourceLocation } from '../shared/annotations';
import type { T } from './i18n';
import { MediaPlayer } from './MediaPlayer';
import { remarkSourceAnchors } from './study/sourceAnchors';
import { ContentBoundary } from './design/ContentBoundary';
import { paintHighlights, quoteRanges, useSavedQuotes } from './annotations/highlights';
const PdfViewer = lazy(() => import('./PdfViewer'));
const CSV_ROW_LIMIT = 200;

export function Viewer({
  source,
  t,
  learning,
  position = 0,
  onPosition,
  seek,
  bookmarks = [],
  sessionId,
  annotationTick,
  onSelection,
  onReadingProgress,
  onPlaying,
  suspended = false,
  resumeSignal = 0,
}: {
  source: Source;
  sessionId: string;
  annotationTick: number;
  onSelection: (value: SourceLocation) => void;
  bookmarks?: Bookmark[];
  t: T;
  learning: PublicLearning | null;
  position?: number;
  onPosition: (value: number) => void;
  seek: { value: number; nonce: number; segment?: Segment; heading?: string } | null;
  onReadingProgress?: (event: ReadingProgress) => void;
  onPlaying?: (value: boolean) => void;
  suspended?: boolean;
  resumeSignal?: number;
}) {
  const [text, setText] = useState('');
  const csv = source.kind === 'text' && /\.csv$/i.test(source.name);
  // Tables are easier to read; the plain text view keeps chapters and highlights anchored.
  const [csvView, setCsvView] = useState<'table' | 'text'>('table');
  const table = useMemo(
    () => (csv && csvView === 'table' ? parseCsv(text, CSV_ROW_LIMIT + 1) : null),
    [csv, csvView, text],
  );
  useEffect(() => {
    if (seek) setCsvView('text');
  }, [seek?.nonce]);
  const documentRoot = useRef<HTMLElement>(null),
    textPosition = useRef(position);
  const textRanges = useRef<Array<{ index: number; range: Range }>>([]);
  const progress = useRef(onReadingProgress);
  progress.current = onReadingProgress;
  const savedQuotes = useSavedQuotes(sessionId, source, annotationTick);
  useEffect(() => {
    const root = documentRoot.current,
      key = `text:${source.id}`;
    if (!root || !text || !['markdown', 'text'].includes(source.kind)) return;
    paintHighlights(
      key,
      quoteRanges(
        root,
        savedQuotes.map((item) => item.location.quote!),
      ),
    );
    return () => paintHighlights(key, []);
  }, [text, savedQuotes, source.id, source.kind]);
  useEffect(() => {
    if (!documentRoot.current || !text || !learning || !['markdown', 'text'].includes(source.kind))
      return;
    const root = documentRoot.current;
    const find = (quote: string, heading?: string) => {
      const sourceOffset = text.indexOf(quote);
      if (heading && sourceOffset >= 0) {
        const normalize = (value: string) =>
          value
            .toLocaleLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
        const target = [...root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].find(
          (element) =>
            normalize(element.textContent || '') === normalize(heading) &&
            Number(element.dataset.sourceStart) >= sourceOffset &&
            Number(element.dataset.sourceStart) < sourceOffset + quote.length,
        );
        if (target) {
          const range = document.createRange();
          range.selectNodeContents(target);
          return range;
        }
      }
      const anchor =
        sourceOffset < 0
          ? undefined
          : [...root.querySelectorAll<HTMLElement>('[data-source-start]')]
              .filter(
                (el) =>
                  Number(el.dataset.sourceStart) <= sourceOffset &&
                  Number(el.dataset.sourceEnd) > sourceOffset,
              )
              .sort(
                (a, b) =>
                  Number(a.dataset.sourceEnd) -
                  Number(a.dataset.sourceStart) -
                  (Number(b.dataset.sourceEnd) - Number(b.dataset.sourceStart)),
              )[0];
      const searchRoot = anchor || root;
      const candidates = quote
        .split('\n')
        .map((s) =>
          s
            .trim()
            .replace(/^[#>*\s-]+/, '')
            .replace(/[*_`]/g, ''),
        )
        .filter((s) => s.length >= 8)
        .slice(0, 5);
      for (const candidate of candidates) {
        const token = candidate.slice(0, Math.min(45, candidate.length)),
          walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT);
        let node: Node | null;
        while ((node = walker.nextNode())) {
          const at = node.textContent?.indexOf(token) ?? -1;
          if (at >= 0) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + token.length);
            return range;
          }
        }
      }
      if (anchor) {
        const range = document.createRange();
        range.selectNodeContents(anchor);
        return range;
      }
      return null;
    };
    textRanges.current = learning.segments.flatMap((s, index) => {
      const range = find(s.text);
      return range ? [{ index, range }] : [];
    });
    const target = seek?.segment
      ? find(seek.segment.text, seek.heading)
      : textRanges.current.find((r) => r.index === position)?.range;
    if (target) {
      root.scrollTop += target.getBoundingClientRect().top - root.getBoundingClientRect().top - 24;
      const index = seek?.segment
        ? learning.segments.findIndex((s) => s.id === seek.segment!.id)
        : position;
      textPosition.current = Math.max(0, index);
      progress.current?.({ value: textPosition.current, cause: seek ? 'seek' : 'restore' });
    }
  }, [text, learning?.createdAt, seek?.nonce, csvView]);
  const url = `/api/files/${source.id}/content`;
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (source.kind === 'text' || source.kind === 'markdown') {
      const controller = new AbortController();
      fetch(url, { signal: controller.signal })
        .then((r) => {
          if (!r.ok) throw new Error(r.statusText);
          return r.text();
        })
        .then(setText)
        .catch(() => {
          if (!controller.signal.aborted) setFailed(true);
        });
      return () => controller.abort();
    }
  }, [source.id]);
  if (failed) return <PreviewUnavailable name={source.name} url={url} t={t} />;
  if (source.kind === 'video' || source.kind === 'audio')
    return (
      <MediaPlayer
        key={source.id}
        source={source}
        learning={learning}
        bookmarks={bookmarks}
        position={position}
        onPosition={onPosition}
        seek={seek}
        t={t}
        onReadingProgress={onReadingProgress}
        onPlaying={onPlaying}
        suspended={suspended}
        resumeSignal={resumeSignal}
      />
    );
  if (source.kind === 'pdf')
    return (
      <ContentBoundary t={t} title={t.readerUnavailable}>
        <Suspense fallback={<p className="pdf-loading">{t.loadingPdf}</p>}>
          <PdfViewer
            key={source.id}
            source={source}
            t={t}
            position={position}
            onPosition={onPosition}
            seek={seek}
            sessionId={sessionId}
            annotationTick={annotationTick}
            onSelection={onSelection}
            onReadingProgress={onReadingProgress}
          />
        </Suspense>
      </ContentBoundary>
    );
  if (source.kind === 'image')
    return (
      <div className="image-stage">
        <img src={url} alt={source.name} onError={() => setFailed(true)} />
      </div>
    );
  return (
    <article
      ref={documentRoot}
      className={`document-reader ${source.kind === 'markdown' ? '' : 'text-reader'}`}
      onScroll={() => {
        const root = documentRoot.current;
        if (!root) return;
        const visible =
          textRanges.current
            .filter(
              (r) => r.range.getBoundingClientRect().top <= root.getBoundingClientRect().top + 80,
            )
            .at(-1)?.index ?? 0;
        if (visible !== textPosition.current) {
          textPosition.current = visible;
          onPosition(visible);
          progress.current?.({ value: visible, cause: 'read' });
        }
      }}
      onPointerUp={(event) => {
        const selection = window.getSelection();
        if (
          selection?.anchorNode &&
          selection.focusNode &&
          event.currentTarget.contains(selection.anchorNode) &&
          event.currentTarget.contains(selection.focusNode)
        )
          onSelection({ quote: selection.toString().trim().slice(0, 8000) });
      }}
      onKeyUp={(event) => {
        const selection = window.getSelection();
        if (
          selection?.anchorNode &&
          selection.focusNode &&
          event.currentTarget.contains(selection.anchorNode) &&
          event.currentTarget.contains(selection.focusNode)
        )
          onSelection({ quote: selection.toString().trim().slice(0, 8000) });
      }}
    >
      {source.kind === 'markdown' ? (
        <div className="document-column">
          <StudyMarkdown t={t} remarkPlugins={[remarkSourceAnchors]}>
            {text}
          </StudyMarkdown>
        </div>
      ) : (
        <>
          {csv && (
            <div className="csv-view" role="group" aria-label={t.viewAs}>
              {(['table', 'text'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  aria-pressed={csvView === view}
                  onClick={() => setCsvView(view)}
                >
                  {view === 'table' ? t.csvTable : t.csvText}
                </button>
              ))}
            </div>
          )}
          {table ? (
            <div className="csv-table-scroll">
              <table className="csv-table">
                {table.rows.length > 0 && (
                  <thead>
                    <tr>
                      {table.rows[0].map((cell, i) => (
                        <th key={i} scope="col">
                          {cell}
                        </th>
                      ))}
                    </tr>
                  </thead>
                )}
                <tbody>
                  {table.rows.slice(1).map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, i) => (
                        <td key={i}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {table.total - 1 > CSV_ROW_LIMIT && (
                <p className="muted">
                  {t.csvRowLimit
                    .replace('{shown}', String(CSV_ROW_LIMIT))
                    .replace('{total}', String(table.total - 1))}
                </p>
              )}
            </div>
          ) : (
            <pre data-source-start="0" data-source-end={text.length}>
              {text}
            </pre>
          )}
        </>
      )}
    </article>
  );
}

/** Shown when a file cannot be previewed here; the original stays reachable. */
function PreviewUnavailable({ name, url, t }: { name: string; url: string; t: T }) {
  return (
    <div className="preview-unavailable" role="status">
      <FileWarning aria-hidden="true" />
      <p className="preview-unavailable-title">{t.previewUnavailable}</p>
      <p className="muted">{name}</p>
      <a className="text-link" href={url} target="_blank" rel="noreferrer">
        {t.openOriginalFile}
      </a>
    </div>
  );
}
