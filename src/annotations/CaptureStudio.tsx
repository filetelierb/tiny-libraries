import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { z } from 'zod';
import {
  ArrowUpRight,
  Highlighter,
  MousePointer2,
  PenLine,
  Square,
  Type,
  Undo2,
  Redo2,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  captureDrawingSchema,
  capturePointFromView,
  wholeCapture,
  type CaptureDrawing,
  type CaptureObject,
  type CapturePoint,
} from '../../shared/capture-drawing';
import type { PublishedCapture } from '../../shared/captures';
import { Button, IconButton, Modal } from '../design/components';
import type { T } from '../i18n';
import { CaptureWorkspace } from './CaptureWorkspace';
import { type CaptureEntry, editorDrafts, DraftWriteQueue, workingDraftKey } from './draftStore';
import { captureBaseUrl, capturePreviewUrl, stageCaptureDrawing } from './captureClient';
import {
  captureObjectBounds,
  distToSegment,
  moveCaptureObject,
  transformCaptureObject,
} from './drawingGeometry';

type Tool = 'select' | 'highlight' | 'text' | 'pen' | 'arrow' | 'highlightBox';
const toolIcons = {
  select: MousePointer2,
  highlight: Highlighter,
  text: Type,
  pen: PenLine,
  arrow: ArrowUpRight,
  highlightBox: Square,
};
/** Ten capture swatches, in display order, plus the per-tool defaults. */
const PALETTE = [
  '#ffffff',
  '#000000',
  '#f52e33',
  '#ff7a14',
  '#ffd114',
  '#38c759',
  '#1ac7d1',
  '#1f7afa',
  '#944df5',
  '#f53894',
];
const DEFAULT_COLOR = '#f52e33';
const STYLE_STORAGE_KEY = 'tl:capture:style';
const initialStyles = (): Record<Tool, { color: string; width: number }> => {
  const base = Object.fromEntries(
    (Object.keys(toolIcons) as Tool[]).map((name) => [name, { color: DEFAULT_COLOR, width: 3 }]),
  ) as Record<Tool, { color: string; width: number }>;
  try {
    const raw = localStorage.getItem(STYLE_STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<Record<Tool, { color?: string; width?: number }>>;
    for (const name of Object.keys(toolIcons) as Tool[]) {
      const entry = parsed[name];
      if (entry?.color && /^#[0-9a-f]{6}$/i.test(entry.color)) base[name].color = entry.color;
      if (typeof entry?.width === 'number' && entry.width >= 1 && entry.width <= 512)
        base[name].width = entry.width;
    }
  } catch {}
  return base;
};
const persistStyles = (styles: Record<Tool, { color: string; width: number }>) => {
  try {
    localStorage.setItem(STYLE_STORAGE_KEY, JSON.stringify(styles));
  } catch {}
};
const textEditSchema = z.object({
  kind: z.literal('text'),
  id: z.string().uuid(),
  point: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  text: z.string().max(2000),
  style: z.enum(['plain', 'sticky', 'bubble']),
  color: z.string().regex(/^#[a-f0-9]{6}$/i),
  fontSize: z.number().min(8).max(512),
});
type TextEdit = z.infer<typeof textEditSchema>;
const workingSchema = z.object({
  format: z.literal(1),
  baseDigest: z.string(),
  drawing: captureDrawingSchema,
  editing: textEditSchema.nullable(),
});
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));

export function CaptureStudio({
  workspace,
  entry,
  t,
  close,
}: {
  workspace: CaptureWorkspace;
  entry: CaptureEntry;
  t: T;
  close: () => void;
}) {
  const [loaded, setLoaded] = useState<{
      drawing: CaptureDrawing;
      editing: TextEdit | null;
    } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void (async () => {
      const drawing = await workspace.loadDrawing(entry.descriptor.id),
        raw = await editorDrafts.get(
          'working',
          workingDraftKey(workspace.context.annotationId, entry.descriptor.id),
        );
      if (raw === undefined) return { drawing, editing: null };
      const parsed = workingSchema.parse(raw);
      if (
        parsed.baseDigest !== entry.version?.baseDigest ||
        JSON.stringify(parsed.drawing.space) !== JSON.stringify(drawing.space)
      )
        throw new Error(t.captureRecoveryError);
      return { drawing: parsed.drawing, editing: parsed.editing };
    })()
      .then((value) => {
        if (alive) setLoaded(value);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : t.error);
      });
    return () => {
      alive = false;
    };
  }, []);
  return loaded ? (
    <StudioBody workspace={workspace} entry={entry} initial={loaded} t={t} close={close} />
  ) : (
    <Modal title={t.captureStudio} close={close} closeLabel={t.close}>
      <p role={error ? 'alert' : 'status'}>{error || t.captureLoading}</p>
    </Modal>
  );
}
function StudioBody({
  workspace,
  entry,
  initial,
  t,
  close,
}: {
  workspace: CaptureWorkspace;
  entry: CaptureEntry;
  initial: { drawing: CaptureDrawing; editing: TextEdit | null };
  t: T;
  close: () => void;
}) {
  const [drawing, setDrawing] = useState(initial.drawing),
    [editing, setEditing] = useState(initial.editing),
    [tool, setTool] = useState<Tool>('highlight'),
    [selected, setSelected] = useState<string | null>(null),
    // Each tool keeps its own colour and width, as in the reference capture tools.
    [styles, setStyles] = useState(initialStyles),
    [zoom, setZoom] = useState(1),
    [viewport, setViewport] = useState({ width: 800, height: 500 }),
    [revision, setRevision] = useState(0),
    [preview, setPreview] = useState<{ version: PublishedCapture; drawing: CaptureDrawing } | null>(
      null,
    ),
    [rendering, setRendering] = useState(false),
    [dirty, setDirty] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [live, setLive] = useState<CaptureObject | null>(null);
  const model = useRef(drawing),
    text = useRef(editing),
    svg = useRef<SVGSVGElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    editor = useRef<HTMLTextAreaElement>(null),
    writes = useRef(new DraftWriteQueue()),
    history = useRef<CaptureDrawing[]>([]),
    widthHistorySnapshot = useRef<CaptureDrawing | null>(null),
    future = useRef<CaptureDrawing[]>([]),
    alive = useRef(true);
  const { color, width } = styles[tool];
  const setColor = (value: string) =>
    setStyles((current) => {
      const next = { ...current, [tool]: { ...current[tool], color: value } };
      persistStyles(next);
      return next;
    });
  const setWidth = (value: number) =>
    setStyles((current) => {
      const next = { ...current, [tool]: { ...current[tool], width: value } };
      persistStyles(next);
      return next;
    });
  const gesture = useRef<{
    id: number;
    start: CapturePoint;
    points: CapturePoint[];
    object?: CaptureObject;
    mode: 'draw' | 'move' | 'resize' | 'tail' | 'text' | 'arrowTip' | 'arrowTail';
    before: CaptureDrawing;
    pendingText?: TextEdit;
  } | null>(null);
  const owner = workspace.context.annotationId,
    id = entry.descriptor.id,
    crop = drawing.crop || wholeCapture,
    space = drawing.space,
    cropWidth = crop.width * space.width,
    cropHeight = crop.height * space.height;
  const fit = Math.min(
      1,
      Math.max(0.005, (viewport.width - 32) / cropWidth),
      Math.max(0.005, (viewport.height - 32) / cropHeight),
    ),
    scale = fit * zoom;
  // Older drawings may still hold comment, redaction, mosaic or spotlight objects; they stay
  // visible, movable and removable even though the toolbar no longer creates them.
  const labels: Record<Tool | CaptureObject['kind'], string> = {
    select: t.captureSelect,
    highlight: t.captureHighlight,
    comment: t.captureComment,
    arrow: t.captureArrow,
    text: t.captureText,
    pen: t.capturePen,
    highlightBox: t.captureHighlightBox,
    redact: t.captureRedact,
    mosaic: t.captureMosaic,
    spotlight: t.captureHighlightBox,
  };
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  useEffect(() => {
    const el = scroll.current;
    if (!el) return;
    const obs = new ResizeObserver(() =>
      setViewport({ width: el.clientWidth, height: el.clientHeight }),
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
  function persist(next: CaptureDrawing, edit: TextEdit | null) {
    setDirty(true);
    void writes.current
      .enqueue(
        [
          {
            table: 'working',
            key: workingDraftKey(owner, id),
            value: {
              format: 1,
              baseDigest: entry.version!.baseDigest,
              drawing: next,
              editing: edit,
            },
          },
        ],
        'working',
      )
      .then(() => {
        if (alive.current) setDirty(false);
      })
      .catch((e) => {
        if (alive.current) setError(e instanceof Error ? e.message : t.captureDraftError);
      });
  }
  function editText(next: TextEdit | null) {
    text.current = next;
    setEditing(next);
    persist(model.current, next);
  }
  function commit(next: CaptureDrawing, remember = true) {
    const parsed = captureDrawingSchema.safeParse(next);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return false;
    }
    if (remember) {
      history.current = [...history.current.slice(-39), model.current];
      future.current = [];
    }
    model.current = parsed.data;
    setDrawing(parsed.data);
    setRevision((n) => n + 1);
    setError('');
    persist(parsed.data, text.current);
    return true;
  }
  useEffect(() => {
    let valid = true;
    const timeout = setTimeout(() => {
      setRendering(true);
      void stageCaptureDrawing(entry, drawing)
        .then((version) => {
          if (valid) {
            setPreview({ version, drawing });
            setError('');
          }
        })
        .catch((e) => {
          if (valid) setError(e instanceof Error ? e.message : t.error);
        })
        .finally(() => {
          if (valid) setRendering(false);
        });
    }, 180);
    return () => {
      valid = false;
      clearTimeout(timeout);
    };
  }, [drawing]);
  useEffect(() => {
    if (!selected || editing) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      )
        return;
      event.preventDefault();
      removeSelected();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selected, editing]);
  useEffect(() => {
    if (!editing) return;
    const handle = window.requestAnimationFrame(() => {
      const el = editor.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
    return () => window.cancelAnimationFrame(handle);
  }, [editing?.id]);
  function finishText() {
    const edit = text.current;
    if (!edit) return true;
    if (!edit.text.trim()) {
      editText(null);
      return true;
    }
    const prior = model.current.objects.find((o) => o.id === edit.id);
    const object: CaptureObject = {
      id: edit.id,
      kind: 'text',
      point: edit.point,
      text: edit.text.trim(),
      color: edit.color,
      fontSize: edit.fontSize,
      style: edit.style,
      ...(edit.style === 'bubble'
        ? {
            tail:
              prior?.kind === 'text' && prior.tail
                ? prior.tail
                : { x: clamp(edit.point.x + 0.06), y: clamp(edit.point.y + 0.14) },
          }
        : {}),
    };
    text.current = null;
    setEditing(null);
    const accepted = commit({
      ...model.current,
      objects: prior
        ? model.current.objects.map((o) => (o.id === object.id ? object : o))
        : [...model.current.objects, object],
    });
    if (!accepted) {
      text.current = edit;
      setEditing(edit);
      return false;
    }
    setSelected(object.id);
    return true;
  }
  function openText(object: CaptureObject) {
    if (object.kind !== 'text') return;
    setSelected(object.id);
    editText({
      kind: 'text',
      id: object.id,
      point: object.point,
      text: object.text,
      color: object.color,
      fontSize: object.fontSize,
      style: object.style,
    });
  }
  function point(event: ReactPointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return capturePointFromView(
      {
        x: clamp((event.clientX - rect.left) / rect.width),
        y: clamp((event.clientY - rect.top) / rect.height),
      },
      model.current.crop,
    );
  }
  function hit(p: CapturePoint) {
    const tolerance = 5 / scale;
    const pView = { x: p.x * space.width, y: p.y * space.height };
    return [...model.current.objects].reverse().find((o) => {
      if ('points' in o && !('shape' in o && o.shape === 'rect')) {
        const threshold = o.width / 2 + tolerance;
        const pts = o.points;
        if (pts.length === 1) {
          const a = { x: pts[0].x * space.width, y: pts[0].y * space.height };
          return Math.hypot(pView.x - a.x, pView.y - a.y) <= threshold;
        }
        for (let i = 1; i < pts.length; i++) {
          const a = { x: pts[i - 1].x * space.width, y: pts[i - 1].y * space.height };
          const b = { x: pts[i].x * space.width, y: pts[i].y * space.height };
          if (distToSegment(pView, a, b) <= threshold) return true;
        }
        return false;
      }
      const b = captureObjectBounds(o, space),
        m = tolerance;
      return (
        p.x >= b.x - m / space.width &&
        p.x <= b.x + b.width + m / space.width &&
        p.y >= b.y - m / space.height &&
        p.y <= b.y + b.height + m / space.height
      );
    });
  }
  function makeObject(points: CapturePoint[]): CaptureObject | null {
    const base = {
      id: crypto.randomUUID(),
      points,
      color,
      width: clamp(width / scale, 1, tool === 'highlight' ? 256 : 128),
    };
    if (tool === 'pen' || tool === 'highlight') return { ...base, kind: tool };
    if (tool === 'arrow') return { ...base, kind: 'arrow', points: [points[0], points.at(-1)!] };
    if (tool === 'highlightBox') {
      const a = points[0];
      const b = points.at(-1)!;
      const dx = Math.abs(b.x - a.x) * space.width * scale;
      const dy = Math.abs(b.y - a.y) * space.height * scale;
      if (dx < 3 || dy < 3) return null;
      const strokeWidth = clamp(width / scale, 1, 64);
      return {
        id: base.id,
        kind: 'spotlight',
        shape: 'rect',
        points: [a, b],
        color,
        width: strokeWidth,
        borderWidth: strokeWidth,
      };
    }
    return null;
  }
  function down(event: ReactPointerEvent<SVGSVGElement>) {
    if (busy || event.button !== 0 || gesture.current) return;
    const dismissedTextThisGesture = text.current !== null;
    if (!finishText()) return;
    const p = point(event);
    event.currentTarget.focus();
    event.preventDefault();
    if (tool === 'text') {
      if (dismissedTextThisGesture) return;
      const existing = hit(p);
      if (existing && existing.kind === 'text') {
        openText(existing);
        return;
      }
      event.currentTarget.setPointerCapture(event.pointerId);
      gesture.current = {
        id: event.pointerId,
        start: p,
        points: [p],
        mode: 'text',
        before: model.current,
        pendingText: {
          kind: 'text',
          id: crypto.randomUUID(),
          point: p,
          text: '',
          color,
          style: 'plain',
          fontSize: clamp(17 / scale, 8, 512),
        },
      };
      return;
    }
    const selectedObject = model.current.objects.find((o) => o.id === selected),
      target = (event.target as SVGElement).dataset.handle;
    const object = tool === 'select' ? (target ? selectedObject : hit(p)) : undefined;
    if (tool === 'select') {
      setSelected(object?.id || null);
      if (!object) return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      id: event.pointerId,
      start: p,
      points: [p],
      object,
      mode:
        target === 'resize'
          ? 'resize'
          : target === 'tail'
            ? 'tail'
            : target === 'arrowTip'
              ? 'arrowTip'
              : target === 'arrowTail'
                ? 'arrowTail'
                : object
                  ? 'move'
                  : 'draw',
      before: model.current,
    };
  }
  function move(event: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const p = point(event);
    if (g.mode === 'move' && g.object)
      setLive(moveCaptureObject(g.object, { x: p.x - g.start.x, y: p.y - g.start.y }, space));
    else if (g.mode === 'resize' && g.object) {
      const bounds = captureObjectBounds(g.object, space);
      setLive(
        transformCaptureObject(g.object, bounds, {
          ...bounds,
          width: Math.max(8 / scale / space.width, p.x - bounds.x),
          height: Math.max(8 / scale / space.height, p.y - bounds.y),
        }),
      );
    } else if (g.mode === 'tail' && g.object?.kind === 'text') setLive({ ...g.object, tail: p });
    else if ((g.mode === 'arrowTip' || g.mode === 'arrowTail') && g.object?.kind === 'arrow') {
      const [tail, tip] = g.object.points;
      setLive({
        ...g.object,
        points: g.mode === 'arrowTip' ? [tail, p] : [p, tip],
      });
    } else if (g.mode === 'draw') {
      const last = g.points.at(-1)!;
      if (Math.hypot((last.x - p.x) * space.width, (last.y - p.y) * space.height) * scale < 2)
        return;
      if (g.points.length >= 1900) g.points = g.points.filter((_, i) => i % 2 === 0);
      g.points.push(p);
      setLive(makeObject(g.points));
    }
  }
  function up(event: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const p = point(event);
    gesture.current = null;
    setLive(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (g.mode === 'text') {
      if (g.pendingText) {
        const dx = (p.x - g.start.x) * space.width * scale;
        const dy = (p.y - g.start.y) * space.height * scale;
        if (Math.hypot(dx, dy) < 5) editText(g.pendingText);
      }
      return;
    }
    let object: CaptureObject | null = null;
    const transient = g.mode === 'move' || g.mode === 'resize';
    if (g.mode === 'move' && g.object)
      object = moveCaptureObject(g.object, { x: p.x - g.start.x, y: p.y - g.start.y }, space);
    else if (g.mode === 'resize' && g.object) {
      const b = captureObjectBounds(g.object, space);
      object = transformCaptureObject(g.object, b, {
        ...b,
        width: Math.min(1 - b.x, Math.max(8 / scale / space.width, p.x - b.x)),
        height: Math.min(1 - b.y, Math.max(8 / scale / space.height, p.y - b.y)),
      });
    } else if (g.mode === 'tail' && g.object?.kind === 'text') object = { ...g.object, tail: p };
    else if ((g.mode === 'arrowTip' || g.mode === 'arrowTail') && g.object?.kind === 'arrow') {
      const [tail, tip] = g.object.points;
      object = {
        ...g.object,
        points: g.mode === 'arrowTip' ? [tail, p] : [p, tip],
      };
    } else object = makeObject([...g.points, p]);
    if (
      object &&
      commit(
        {
          ...model.current,
          objects: g.object
            ? model.current.objects.map((o) => (o.id === object!.id ? object! : o))
            : [...model.current.objects, object],
        },
        !transient,
      )
    ) {
      // Fresh draws don't auto-select so the handles don't flash in; moves/resizes
      // keep the existing selection and do not push a new history entry either.
      if (g.mode !== 'draw' && !transient) setSelected(object.id);
    }
  }
  function abandonGesture() {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    setLive(null);
    const svgEl = svg.current;
    if (svgEl && svgEl.hasPointerCapture(g.id)) svgEl.releasePointerCapture(g.id);
  }
  async function leave(discard = false) {
    if (busy) return;
    setBusy(true);
    try {
      if (!discard && !finishText()) {
        setBusy(false);
        return;
      }
      await writes.current.flush();
      if (discard)
        await editorDrafts.commit([
          { table: 'working', key: workingDraftKey(owner, id), remove: true },
        ]);
      else await workspace.applyDrawing(id, model.current);
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
      setBusy(false);
    }
  }
  function undo(back: boolean) {
    abandonGesture();
    if (editing) {
      editText(null);
      return;
    }
    const from = back ? history : future,
      to = back ? future : history;
    const value = from.current.pop();
    if (!value) return;
    to.current.push(model.current);
    commit(value, false);
    setSelected(null);
  }
  const active = drawing.objects.find((o) => o.id === selected),
    bounds = active ? captureObjectBounds(live || active, space) : null;
  function removeSelected() {
    if (active) {
      commit({
        ...model.current,
        objects: model.current.objects.filter((o) => o.id !== active.id),
      });
      setSelected(null);
    }
  }
  function patchSelected(patch: Record<string, unknown>, remember = true) {
    if (active)
      commit(
        {
          ...model.current,
          objects: model.current.objects.map((o) =>
            o.id === active.id ? ({ ...o, ...patch } as CaptureObject) : o,
          ),
        },
        remember,
      );
  }
  const pointsPath = (o: CaptureObject) =>
    'points' in o
      ? o.points.map((p) => `${p.x * space.width},${p.y * space.height}`).join(' ')
      : '';
  return (
    <Modal
      title={t.captureStudio}
      close={() => {
        if (text.current) editText(null);
        else void leave();
      }}
      closeLabel={t.back}
      className="capture-studio"
    >
      <p className="capture-studio-notice">{t.captureDraftNotice}</p>
      <fieldset disabled={busy} className="capture-tool-controls">
        <div className="capture-tool-row" role="toolbar" aria-label={t.captureStudio}>
          {(Object.keys(toolIcons) as Tool[]).map((name) => {
            const Icon = toolIcons[name];
            return (
              <IconButton
                key={name}
                label={labels[name]}
                aria-pressed={tool === name}
                onClick={() => {
                  if (finishText()) {
                    setTool(name);
                    setSelected(null);
                  }
                }}
              >
                <Icon />
              </IconButton>
            );
          })}
          <span className="capture-tool-divider" />
          <IconButton label={t.undo} disabled={!history.current.length} onClick={() => undo(true)}>
            <Undo2 />
          </IconButton>
          <IconButton label={t.redo} disabled={!future.current.length} onClick={() => undo(false)}>
            <Redo2 />
          </IconButton>
          <IconButton label={t.captureDeleteObject} disabled={!active} onClick={removeSelected}>
            <Trash2 />
          </IconButton>
        </div>
        <div className="capture-properties">
          <div className="capture-swatches" role="group" aria-label={t.captureColor}>
            {PALETTE.map((swatch) => {
              const current = (active && 'color' in active ? active.color : color).toLowerCase();
              return (
                <button
                  key={swatch}
                  type="button"
                  className="capture-swatch"
                  style={{ background: swatch }}
                  aria-label={`${t.captureColor} ${swatch}`}
                  aria-pressed={current === swatch}
                  onClick={() => {
                    setColor(swatch);
                    if (active && 'color' in active) patchSelected({ color: swatch });
                  }}
                />
              );
            })}
          </div>
          <label>
            {t.captureWidth}
            <input
              type="range"
              min="1"
              max="24"
              value={
                active && 'points' in active
                  ? clamp(Math.round(active.width * scale), 1, 24)
                  : width
              }
              onPointerDown={() => {
                widthHistorySnapshot.current = model.current;
              }}
              onPointerUp={() => {
                const snapshot = widthHistorySnapshot.current;
                widthHistorySnapshot.current = null;
                if (snapshot && snapshot !== model.current) {
                  history.current = [...history.current.slice(-39), snapshot];
                  future.current = [];
                }
              }}
              onChange={(e) => {
                setWidth(Number(e.target.value));
                if (active && 'points' in active)
                  patchSelected(
                    {
                      width: clamp(
                        Number(e.target.value) / scale,
                        1,
                        active.kind === 'pen' || active.kind === 'arrow'
                          ? 128
                          : active.kind === 'highlight'
                            ? 256
                            : 512,
                      ),
                    },
                    false,
                  );
              }}
            />
          </label>
          {active?.kind === 'text' && (
            <Button onClick={() => openText(active)}>{t.captureObjectEdit}</Button>
          )}
          {drawing.crop && (
            <Button onClick={() => commit({ ...model.current, crop: undefined })}>
              {t.captureResetCrop}
            </Button>
          )}
        </div>
      </fieldset>
      <div className="capture-work-area" ref={scroll}>
        <div
          className="capture-surface-wrap"
          style={{
            width: Math.max(viewport.width, cropWidth * scale + 32),
            height: Math.max(viewport.height, cropHeight * scale + 32),
          }}
        >
          <svg
            ref={svg}
            className="capture-canvas"
            style={{
              width: cropWidth * scale,
              height: cropHeight * scale,
              cursor:
                tool === 'select'
                  ? 'default'
                  : tool === 'text'
                    ? 'text'
                    : 'crosshair',
            }}
            viewBox={`${crop.x * space.width} ${crop.y * space.height} ${cropWidth} ${cropHeight}`}
            tabIndex={0}
            role="application"
            aria-label={t.drawingSurface}
            aria-describedby="capture-keyboard-help"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={() => {
              gesture.current = null;
              setLive(null);
            }}
            onDoubleClick={(e) => {
              if (tool === 'select') {
                const found = hit(point(e as unknown as ReactPointerEvent<SVGSVGElement>));
                if (found) openText(found);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                removeSelected();
              } else if (e.key === 'Enter' && active) {
                e.preventDefault();
                openText(active);
              } else if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
                e.preventDefault();
                undo(!e.shiftKey);
              } else if (
                active &&
                ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
              ) {
                e.preventDefault();
                const delta = (e.shiftKey ? 10 : 1) / scale;
                patchSelected(
                  moveCaptureObject(
                    active,
                    {
                      x:
                        (e.key === 'ArrowLeft' ? -delta : e.key === 'ArrowRight' ? delta : 0) /
                        space.width,
                      y:
                        (e.key === 'ArrowUp' ? -delta : e.key === 'ArrowDown' ? delta : 0) /
                        space.height,
                    },
                    space,
                  ),
                );
              }
            }}
          >
            <image href={captureBaseUrl(owner, id)} width={space.width} height={space.height} />
            {drawing.objects.map((obj) => {
              const o = live && live.id === obj.id ? live : obj;
              if (o.kind === 'pen' || o.kind === 'highlight')
                return (
                  <polyline
                    key={o.id}
                    points={pointsPath(o)}
                    fill="none"
                    stroke={o.color}
                    strokeWidth={o.width}
                    strokeOpacity={o.kind === 'highlight' ? 0.3 : 1}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                );
              if (o.kind === 'arrow') {
                const [a, b] = o.points;
                const ax = a.x * space.width,
                  ay = a.y * space.height,
                  bx = b.x * space.width,
                  by = b.y * space.height;
                const angle = Math.atan2(by - ay, bx - ax);
                const head = Math.max(10, o.width * 3);
                const hx1 = bx - head * Math.cos(angle - Math.PI / 6);
                const hy1 = by - head * Math.sin(angle - Math.PI / 6);
                const hx2 = bx - head * Math.cos(angle + Math.PI / 6);
                const hy2 = by - head * Math.sin(angle + Math.PI / 6);
                return (
                  <g key={o.id} stroke={o.color} strokeWidth={o.width} fill="none" strokeLinecap="round" strokeLinejoin="round">
                    <line x1={ax} y1={ay} x2={bx} y2={by} />
                    <polyline points={`${hx1},${hy1} ${bx},${by} ${hx2},${hy2}`} />
                  </g>
                );
              }
              if (o.kind === 'spotlight' && o.shape === 'rect') {
                const [p1, p2] = [o.points[0], o.points.at(-1)!];
                return (
                  <rect
                    key={o.id}
                    x={Math.min(p1.x, p2.x) * space.width}
                    y={Math.min(p1.y, p2.y) * space.height}
                    width={Math.abs(p2.x - p1.x) * space.width}
                    height={Math.abs(p2.y - p1.y) * space.height}
                    fill={`${o.color}1a`}
                    stroke={o.color}
                    strokeWidth={o.borderWidth ?? o.width}
                  />
                );
              }
              if (o.kind === 'text' && (!editing || editing.id !== o.id)) {
                return (
                  <foreignObject
                    key={o.id}
                    x={o.point.x * space.width}
                    y={o.point.y * space.height}
                    width={Math.min(space.width, 420)}
                    height={Math.max(40, o.fontSize * 2)}
                    style={{ overflow: 'visible', pointerEvents: tool === 'select' ? 'auto' : 'none' }}
                  >
                    <div
                      style={{
                        fontFamily: '"Times New Roman", serif',
                        fontSize: `${o.fontSize}px`,
                        lineHeight: 1.3,
                        color: o.color,
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {o.text}
                    </div>
                  </foreignObject>
                );
              }
              return null;
            })}
            {preview &&
              !drawing.objects.some((o) =>
                ['comment', 'redact', 'mosaic'].includes(o.kind),
              ) ? null : preview ? (
              (() => {
                const pc = preview.drawing.crop || wholeCapture;
                return (
                  <image
                    href={capturePreviewUrl(owner, preview.version)}
                    x={pc.x * space.width}
                    y={pc.y * space.height}
                    width={pc.width * space.width}
                    height={pc.height * space.height}
                    opacity={0.001}
                  />
                );
              })()
            ) : null}
            {live &&
              ('points' in live ? (
                (live.kind === 'redact' || live.kind === 'mosaic' || live.kind === 'spotlight') &&
                live.shape === 'rect' ? (
                  <rect
                    x={Math.min(live.points[0].x, live.points.at(-1)!.x) * space.width}
                    y={Math.min(live.points[0].y, live.points.at(-1)!.y) * space.height}
                    width={Math.abs(live.points.at(-1)!.x - live.points[0].x) * space.width}
                    height={Math.abs(live.points.at(-1)!.y - live.points[0].y) * space.height}
                    fill={
                      live.kind === 'redact'
                        ? '#000'
                        : live.kind === 'spotlight'
                          ? `${live.color}1a`
                          : '#007f7833'
                    }
                    stroke={live.kind === 'spotlight' ? live.color : '#007f78'}
                    strokeWidth={
                      live.kind === 'spotlight' ? (live.borderWidth ?? 2) : 2 / scale
                    }
                  />
                ) : (
                  <polyline
                    points={pointsPath(live)}
                    fill="none"
                    stroke={
                      'color' in live ? live.color : live.kind === 'redact' ? '#000' : '#64748b'
                    }
                    strokeWidth={live.width}
                    strokeOpacity={live.kind === 'highlight' ? 0.3 : 1}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )
              ) : (
                <circle
                  cx={live.point.x * space.width}
                  cy={live.point.y * space.height}
                  r={8 / scale}
                  fill={live.color}
                />
              ))}
            {bounds && (
              <>
                <rect
                  x={bounds.x * space.width}
                  y={bounds.y * space.height}
                  width={bounds.width * space.width}
                  height={bounds.height * space.height}
                  fill="none"
                  stroke="#007f78"
                  strokeWidth={1.5 / scale}
                  strokeDasharray={`${5 / scale} ${3 / scale}`}
                  pointerEvents="none"
                />
                {active?.kind === 'arrow' ? (
                  <>
                    <circle
                      data-handle="arrowTail"
                      aria-label={t.captureTail}
                      cx={(live && 'points' in live ? live.points[0].x : active.points[0].x) * space.width}
                      cy={(live && 'points' in live ? live.points[0].y : active.points[0].y) * space.height}
                      r={8 / scale}
                      fill="#fff"
                      stroke="#007f78"
                      strokeWidth={2 / scale}
                      style={{ cursor: 'grab' }}
                    />
                    <circle
                      data-handle="arrowTip"
                      aria-label={t.captureTip}
                      cx={(live && 'points' in live ? live.points[1].x : active.points[1].x) * space.width}
                      cy={(live && 'points' in live ? live.points[1].y : active.points[1].y) * space.height}
                      r={8 / scale}
                      fill="#fff"
                      stroke="#007f78"
                      strokeWidth={2 / scale}
                      style={{ cursor: 'grab' }}
                    />
                  </>
                ) : (
                  <rect
                    data-handle="resize"
                    aria-label={t.captureResize}
                    x={(bounds.x + bounds.width) * space.width - 7 / scale}
                    y={(bounds.y + bounds.height) * space.height - 7 / scale}
                    width={14 / scale}
                    height={14 / scale}
                    fill="#fff"
                    stroke="#007f78"
                    strokeWidth={2 / scale}
                    style={{ cursor: 'nwse-resize' }}
                  />
                )}
                {active?.kind === 'text' && active.tail && (
                  <circle
                    data-handle="tail"
                    aria-label={t.captureTail}
                    cx={active.tail.x * space.width}
                    cy={active.tail.y * space.height}
                    r={8 / scale}
                    fill="#fff"
                    stroke="#007f78"
                    strokeWidth={2 / scale}
                  />
                )}
              </>
            )}
            {editing &&
              (() => {
                const anchorX = editing.point.x * space.width;
                const anchorY = editing.point.y * space.height;
                const maxWidth = Math.min(420, Math.max(editing.fontSize * 8, space.width - anchorX));
                const estLines = Math.max(
                  1,
                  Math.ceil((editing.text || ' ').length / 30) +
                    (editing.text.match(/\n/g)?.length || 0),
                );
                const height = Math.min(
                  space.height - anchorY,
                  estLines * editing.fontSize * 1.3 + 24,
                );
                return (
                  <foreignObject
                    x={Math.max(0, anchorX)}
                    y={Math.max(0, anchorY)}
                    width={maxWidth}
                    height={height}
                    style={{ overflow: 'visible' }}
                  >
                    <textarea
                      ref={editor}
                      autoFocus
                      aria-label={t.captureTextBody}
                      maxLength={2000}
                      value={editing.text}
                      onChange={(e) => editText({ ...editing, text: e.target.value })}
                      onBlur={() => finishText()}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          editText(null);
                          svg.current?.focus();
                        } else if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          finishText();
                          svg.current?.focus();
                        }
                      }}
                      style={{
                        fontFamily: '"Times New Roman", serif',
                        fontSize: `${editing.fontSize}px`,
                        lineHeight: 1.3,
                        color: editing.color,
                        background: 'rgba(255,255,255,0.08)',
                        border: `1px dashed ${editing.color}`,
                        borderRadius: '4px',
                        padding: '2px 4px',
                        margin: 0,
                        width: '100%',
                        height: '100%',
                        resize: 'none',
                        outline: 'none',
                        overflow: 'hidden',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    />
                  </foreignObject>
                );
              })()}
          </svg>
        </div>
      </div>
      <div className="capture-studio-footer">
        <div className="capture-tool-row">
          <IconButton
            label={t.captureZoomOut}
            disabled={zoom <= 0.5}
            onClick={() => setZoom((v) => Math.max(0.5, v / 1.25))}
          >
            <ZoomOut />
          </IconButton>
          <Button onClick={() => setZoom(1)}>
            {t.captureFit} · {Math.round(scale * 100)}%
          </Button>
          <IconButton
            label={t.captureZoomIn}
            disabled={zoom >= 4}
            onClick={() => setZoom((v) => Math.min(4, v * 1.25))}
          >
            <ZoomIn />
          </IconButton>
          <span role="status">
            {dirty
              ? t.captureDraftSaving
              : rendering
                ? t.capturePreviewUpdating
                : t.captureDraftSaved}
          </span>
        </div>
        <div className="modal-actions">
          <Button disabled={busy} variant="primary" onClick={() => void leave()}>
            {t.captureKeepDrawing}
          </Button>
          <Button disabled={busy} onClick={() => void leave(true)}>
            {t.captureDiscardDrawing}
          </Button>
        </div>
      </div>
      <p id="capture-keyboard-help" className="sr-only">
        {t.captureKeyboardHelp}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <span className="sr-only">{revision}</span>
    </Modal>
  );
}
