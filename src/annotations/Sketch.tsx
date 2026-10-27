import { useRef, useState } from 'react';
import { Pencil, Highlighter, Eraser, MapPin, Undo2, Trash2 } from 'lucide-react';
import type { DrawingStroke } from '../../shared/annotations';
import { IconButton } from '../design/components';
import type { T } from '../i18n';

export function StrokeLayer({ strokes }: { strokes: DrawingStroke[] }) {
  return (
    <>
      {strokes.map((stroke, index) =>
        stroke.kind === 'pin' ? null : (
          <polyline
            key={index}
            points={stroke.points.map((point) => `${point.x * 1000},${point.y * 1000}`).join(' ')}
            fill="none"
            stroke={stroke.color}
            strokeWidth={stroke.width}
            opacity={stroke.width >= 10 ? 0.3 : 1}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ),
      )}
    </>
  );
}
/** Numbered comment pins, drawn as fixed-size markers over a scaled page or image. */
export function PinLayer({ strokes }: { strokes: DrawingStroke[] }) {
  return (
    <>
      {strokes
        .filter((stroke) => stroke.kind === 'pin')
        .map((stroke, index) => (
          <span
            key={index}
            className="drawing-pin"
            aria-hidden="true"
            style={{
              left: `${stroke.points[0].x * 100}%`,
              top: `${stroke.points[0].y * 100}%`,
              background: stroke.color,
            }}
          >
            {index + 1}
          </span>
        ))}
    </>
  );
}
export function Sketch({
  image,
  strokes,
  change,
  t,
}: {
  image: { url: string; width: number; height: number };
  strokes: DrawingStroke[];
  change: (value: DrawingStroke[]) => void;
  t: T;
}) {
  const [tool, setTool] = useState<'pen' | 'highlight' | 'pin' | 'eraser'>('pen'),
    [color, setColor] = useState<DrawingStroke['color']>('#007f76'),
    [live, setLive] = useState<DrawingStroke | null>(null),
    [undoCount, setUndoCount] = useState(0);
  const drawing = useRef<DrawingStroke | null>(null),
    history = useRef<DrawingStroke[][]>([]),
    erased = useRef(false),
    strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const replace = (next: DrawingStroke[]) => {
    history.current.push(strokesRef.current);
    setUndoCount(history.current.length);
    strokesRef.current = next;
    change(next);
  };
  return (
    <div className="sketch-editor">
      <div className="sketch-tools" role="toolbar" aria-label={t.drawingTools}>
        <IconButton label={t.pen} aria-pressed={tool === 'pen'} onClick={() => setTool('pen')}>
          <Pencil />
        </IconButton>
        <IconButton
          label={t.highlight}
          aria-pressed={tool === 'highlight'}
          onClick={() => setTool('highlight')}
        >
          <Highlighter />
        </IconButton>
        <IconButton
          label={t.commentPin}
          aria-pressed={tool === 'pin'}
          onClick={() => setTool('pin')}
        >
          <MapPin />
        </IconButton>
        <IconButton
          label={t.eraseStroke}
          aria-pressed={tool === 'eraser'}
          onClick={() => setTool('eraser')}
        >
          <Eraser />
        </IconButton>
        <select
          aria-label={t.inkColor}
          value={color}
          onChange={(event) => setColor(event.target.value as DrawingStroke['color'])}
        >
          <option value="#007f76">{t.teal}</option>
          <option value="#e5913f">{t.amber}</option>
          <option value="#1f6bbb">{t.blue}</option>
          <option value="#c33d45">{t.red}</option>
          <option value="#202f36">{t.ink}</option>
        </select>
        <IconButton
          label={t.undoDrawing}
          disabled={!undoCount}
          onClick={() => {
            const prior = history.current.pop();
            if (prior) {
              change(prior);
              setUndoCount(history.current.length);
            }
          }}
        >
          <Undo2 />
        </IconButton>
        <IconButton label={t.clearDrawing} disabled={!strokes.length} onClick={() => replace([])}>
          <Trash2 />
        </IconButton>
      </div>
      <div className="sketch-surface" style={{ aspectRatio: `${image.width}/${image.height}` }}>
        <img src={image.url} alt={t.capturePreview} draggable={false} />
        <svg
          viewBox="0 0 1000 1000"
          preserveAspectRatio="none"
          role="img"
          aria-label={t.drawingSurface}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            const rect = event.currentTarget.getBoundingClientRect(),
              x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
              y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
            if (tool === 'eraser') {
              erased.current = true;
              replace(
                strokesRef.current.filter(
                  (stroke) =>
                    !stroke.points.some(
                      (point) =>
                        Math.hypot((point.x - x) * rect.width, (point.y - y) * rect.height) < 18,
                    ),
                ),
              );
              return;
            }
            if (tool === 'pin') {
              replace([
                ...strokesRef.current,
                {
                  kind: 'pin',
                  color,
                  width: 3,
                  points: [{ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }],
                },
              ]);
              return;
            }
            drawing.current = {
              color,
              width: tool === 'highlight' ? 12 : 3,
              points: [{ x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 }],
            };
            setLive(drawing.current);
          }}
          onPointerMove={(event) => {
            if (!drawing.current) return;
            const rect = event.currentTarget.getBoundingClientRect(),
              point = {
                x:
                  Math.round(
                    Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * 1000,
                  ) / 1000,
                y:
                  Math.round(
                    Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * 1000,
                  ) / 1000,
              };
            const previous = drawing.current.points.at(-1)!;
            if (
              Math.hypot(
                (point.x - previous.x) * rect.width,
                (point.y - previous.y) * rect.height,
              ) < 2
            )
              return;
            if (drawing.current.points.length >= 1900)
              drawing.current.points = drawing.current.points.filter((_, index) => index % 2 === 0);
            drawing.current = { ...drawing.current, points: [...drawing.current.points, point] };
            setLive(drawing.current);
          }}
          onPointerUp={(event) => {
            if (drawing.current) {
              replace([...strokesRef.current, drawing.current]);
              drawing.current = null;
              setLive(null);
            }
            erased.current = false;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => {
            drawing.current = null;
            setLive(null);
            erased.current = false;
          }}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
              event.preventDefault();
              const previous = history.current.pop();
              if (previous) {
                change(previous);
                setUndoCount(history.current.length);
              }
            }
          }}
        >
          <StrokeLayer strokes={[...strokes, ...(live ? [live] : [])]} />
        </svg>
        <PinLayer strokes={strokes} />
      </div>
      <p className="muted">{t.drawingHelp}</p>
    </div>
  );
}
