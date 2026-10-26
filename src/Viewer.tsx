import { useEffect, useState, lazy, Suspense } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Source, PublicLearning, Bookmark } from '../shared/domain';
import type { SourceLocation } from '../shared/annotations';
import type { T } from './i18n';
import { MediaPlayer } from './MediaPlayer';
const PdfViewer = lazy(() => import('./PdfViewer'));

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
  seek: { value: number; nonce: number } | null;
}) {
  const [text, setText] = useState('');
  const url = `/api/files/${source.id}/content`;
  useEffect(() => {
    if (source.kind === 'text' || source.kind === 'markdown') {
      const controller = new AbortController();
      fetch(url, { signal: controller.signal })
        .then((r) => r.text())
        .then(setText)
        .catch(() => {});
      return () => controller.abort();
    }
  }, [source.id]);
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
      />
    );
  if (source.kind === 'pdf')
    return (
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
        />
      </Suspense>
    );
  if (source.kind === 'image')
    return (
      <div className="image-stage">
        <img src={url} alt={source.name} />
      </div>
    );
  return (
    <article className="document-reader">
      {source.kind === 'markdown' ? (
        <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
      ) : (
        <pre>{text}</pre>
      )}
    </article>
  );
}
