import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FileText, BookOpen, Download, Minus, Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Source, PublicLearning, Bookmark } from '../shared/domain';
import { Button, Empty, IconButton } from './design/components';
import type { T } from './i18n';
import { MediaPlayer } from './MediaPlayer';

export function Viewer({
  source,
  t,
  learning,
  position = 0,
  onPosition,
  seek,
  bookmarks = [],
}: {
  source: Source;
  bookmarks?: Bookmark[];
  t: T;
  learning: PublicLearning | null;
  position?: number;
  onPosition: (value: number) => void;
  seek: { value: number; nonce: number } | null;
}) {
  const [text, setText] = useState(''),
    [page, setPage] = useState(Math.max(1, Math.round(position) || 1)),
    [zoom, setZoom] = useState(100);
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
  useEffect(() => {
    if (!seek) return;
    if (source.kind === 'pdf') {
      setPage(Math.max(1, Math.round(seek.value)));
      onPosition(Math.max(1, Math.round(seek.value)));
    }
  }, [seek?.nonce]);
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
      <div className="pdf-stage">
        <div className="pdf-controls">
          <IconButton
            label={t.back}
            disabled={page <= 1}
            onClick={() => {
              setPage((p) => p - 1);
              onPosition(page - 1);
            }}
          >
            <ChevronLeft />
          </IconButton>
          <label>
            {t.page}
            <input
              aria-label={t.page}
              type="number"
              min="1"
              value={page}
              onChange={(e) => {
                const next = Math.max(1, Number(e.target.value));
                setPage(next);
                onPosition(next);
              }}
            />
          </label>
          <IconButton
            label={t.page}
            onClick={() => {
              setPage((p) => p + 1);
              onPosition(page + 1);
            }}
          >
            <ChevronRight />
          </IconButton>
          <IconButton label={t.zoom} onClick={() => setZoom((z) => Math.max(25, z - 25))}>
            <Minus />
          </IconButton>
          <span>{zoom}%</span>
          <IconButton label={t.zoom} onClick={() => setZoom((z) => Math.min(300, z + 25))}>
            <Plus />
          </IconButton>
        </div>
        <iframe title={source.name} src={`${url}#page=${page}&zoom=${zoom}`} />
      </div>
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
