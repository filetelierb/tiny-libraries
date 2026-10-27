import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { z } from 'zod';
import {
  ArrowUpRight,
  Crop,
  Eraser,
  Highlighter,
  MousePointer2,
  MessageCircle,
  PenLine,
  Type,
  Square,
  Grid2X2,
  Focus,
  Undo2,
  Redo2,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  captureDrawingSchema,
  capturePointFromView,
  captureRectangle,
  wholeCapture,
  type CaptureDrawing,
  type CaptureObject,
  type CapturePoint,
  type CaptureRect,
} from '../../shared/capture-drawing';
import type { PublishedCapture } from '../../shared/captures';
import { Button, IconButton, Modal } from '../design/components';
import type { T } from '../i18n';
import { CaptureWorkspace } from './CaptureWorkspace';
import { type CaptureEntry, editorDrafts, DraftWriteQueue, workingDraftKey } from './draftStore';
import { captureBaseUrl, capturePreviewUrl, stageCaptureDrawing } from './captureClient';
import {
  captureEditorPlacement,
  captureObjectBounds,
  moveCaptureObject,
  transformCaptureObject,
} from './drawingGeometry';

type Tool =
  | 'select'
  | 'highlight'
  | 'comment'
  | 'arrow'
  | 'text'
  | 'pen'
  | 'eraser'
  | 'redact'
  | 'mosaic'
  | 'spotlight'
  | 'crop';
const toolIcons = {
  select: MousePointer2,
  highlight: Highlighter,
  comment: MessageCircle,
  arrow: ArrowUpRight,
  text: Type,
  pen: PenLine,
  eraser: Eraser,
  redact: Square,
  mosaic: Grid2X2,
  spotlight: Focus,
  crop: Crop,
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
const DEFAULT_COLOR = '#ff3b30',
  SPOTLIGHT_DEFAULT_COLOR = '#ffffff';
const initialStyles = () =>
  Object.fromEntries(
    (Object.keys(toolIcons) as Tool[]).map((name) => [
      name,
      { color: name === 'spotlight' ? SPOTLIGHT_DEFAULT_COLOR : DEFAULT_COLOR, width: 3 },
    ]),
  ) as Record<Tool, { color: string; width: number }>;
const textEditSchema = z.object({
  kind: z.enum(['text', 'comment']),
  id: z.string().uuid(),
  point: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  text: z.string().max(2000),
  style: z.enum(['plain', 'sticky', 'bubble']),
  color: z.string().regex(/^#[a-f0-9]{6}$/i),
  fontSize: z.number().min(8).max(512),
  number: z.number().int().min(1).max(100),
  size: z.number().min(8).max(256),
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
    [textStyle, setTextStyle] = useState<'plain' | 'sticky' | 'bubble'>('plain'),
    [shape, setShape] = useState<'rect' | 'stroke'>('rect'),
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
    [live, setLive] = useState<CaptureObject | null>(null),
    [liveCrop, setLiveCrop] = useState<CaptureRect | null>(null);
  const model = useRef(drawing),
    text = useRef(editing),
    svg = useRef<SVGSVGElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    editor = useRef<HTMLTextAreaElement>(null),
    writes = useRef(new DraftWriteQueue()),
    history = useRef<CaptureDrawing[]>([]),
    future = useRef<CaptureDrawing[]>([]),
    alive = useRef(true),
    [position, setPosition] = useState({ left: 12, top: 100, width: 300, maxHeight: 300 });
  const { color, width } = styles[tool];
  const setColor = (value: string) =>
    setStyles((current) => ({ ...current, [tool]: { ...current[tool], color: value } }));
  const setWidth = (value: number) =>
    setStyles((current) => ({ ...current, [tool]: { ...current[tool], width: value } }));
  const gesture = useRef<{
    id: number;
    start: CapturePoint;
    points: CapturePoint[];
    object?: CaptureObject;
    mode: 'draw' | 'move' | 'resize' | 'tail';
    before: CaptureDrawing;
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
  const labels: Record<Tool, string> = {
    select: t.captureSelect,
    highlight: t.captureHighlight,
    comment: t.captureComment,
    arrow: t.captureArrow,
    text: t.captureText,
    pen: t.capturePen,
    eraser: t.captureEraser,
    redact: t.captureRedact,
    mosaic: t.captureMosaic,
    spotlight: t.captureSpotlight,
    crop: t.captureCrop,
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
    if (!editing) return;
    const update = () => {
      const rect = svg.current?.getBoundingClientRect();
      if (!rect) return;
      const view = window.visualViewport,
        area = {
          x: view?.offsetLeft || 0,
          y: view?.offsetTop || 0,
          width: view?.width || window.innerWidth,
          height: view?.height || window.innerHeight,
        };
      setPosition(
        captureEditorPlacement(
          {
            x: rect.left + ((editing.point.x - crop.x) / crop.width) * rect.width,
            y: rect.top + ((editing.point.y - crop.y) / crop.height) * rect.height,
          },
          { width: 320, height: 240 },
          area,
        ),
      );
      if (editor.current) {
        editor.current.style.height = 'auto';
        editor.current.style.height = `${Math.min(160, Math.max(72, editor.current.scrollHeight))}px`;
      }
    };
    update();
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    scroll.current?.addEventListener('scroll', update);
    editor.current?.focus();
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      scroll.current?.removeEventListener('scroll', update);
    };
  }, [editing, zoom, viewport, crop]);
  function finishText() {
    const edit = text.current;
    if (!edit) return true;
    if (!edit.text.trim()) {
      editText(null);
      return true;
    }
    const prior = model.current.objects.find((o) => o.id === edit.id);
    const object: CaptureObject =
      edit.kind === 'comment'
        ? {
            id: edit.id,
            kind: 'comment',
            point: edit.point,
            text: edit.text.trim(),
            number: edit.number,
            color: edit.color,
            size: edit.size,
          }
        : {
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
    if (object.kind !== 'text' && object.kind !== 'comment') return;
    setSelected(object.id);
    editText({
      kind: object.kind,
      id: object.id,
      point: object.point,
      text: object.text,
      color: object.color,
      fontSize: object.kind === 'text' ? object.fontSize : 17,
      style: object.kind === 'text' ? object.style : 'plain',
      number: object.kind === 'comment' ? object.number : 1,
      size: object.kind === 'comment' ? object.size || 11 : 11,
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
    return [...model.current.objects].reverse().find((o) => {
      const b = captureObjectBounds(o, space),
        m = 5 / scale;
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
      width: clamp(
        width / scale,
        1,
        tool === 'highlight' ? 256 : tool === 'pen' || tool === 'arrow' ? 128 : 512,
      ),
    };
    if (tool === 'pen' || tool === 'highlight') return { ...base, kind: tool };
    if (tool === 'arrow') return { ...base, kind: 'arrow', points: [points[0], points.at(-1)!] };
    if (tool === 'redact' || tool === 'mosaic' || tool === 'spotlight')
      return {
        id: base.id,
        kind: tool,
        points: shape === 'rect' ? [points[0], points.at(-1)!] : points,
        width: clamp((width * 5) / scale, 1, 512),
        shape,
        ...(tool === 'mosaic'
          ? { pixelSize: Math.round(clamp(12 / scale, 4, 256)) }
          : tool === 'spotlight'
            ? {
                color,
                captionFontSize: clamp(17 / scale, 8, 512),
                borderWidth: clamp(2 / scale, 1, 64),
              }
            : {}),
      } as CaptureObject;
    return null;
  }
  function down(event: ReactPointerEvent<SVGSVGElement>) {
    if (busy || event.button !== 0 || gesture.current) return;
    if (!finishText()) return;
    const p = point(event);
    event.currentTarget.focus();
    event.preventDefault();
    if (tool === 'text' || tool === 'comment') {
      const n =
        Math.max(
          0,
          ...model.current.objects.filter((o) => o.kind === 'comment').map((o) => o.number),
        ) + 1;
      if (n > 100 && tool === 'comment') {
        setError(t.captureLimit);
        return;
      }
      editText({
        kind: tool,
        id: crypto.randomUUID(),
        point: p,
        text: '',
        color,
        style: textStyle,
        fontSize: clamp(17 / scale, 8, 512),
        number: n,
        size: clamp(11 / scale, 8, 256),
      });
      return;
    }
    const selectedObject = model.current.objects.find((o) => o.id === selected),
      target = (event.target as SVGElement).dataset.handle;
    if (tool === 'eraser') {
      const object = hit(p);
      if (object)
        commit({
          ...model.current,
          objects: model.current.objects.filter((o) => o.id !== object.id),
        });
      return;
    }
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
      mode: target === 'resize' ? 'resize' : target === 'tail' ? 'tail' : object ? 'move' : 'draw',
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
    else if (g.mode === 'draw') {
      const last = g.points.at(-1)!;
      if (Math.hypot((last.x - p.x) * space.width, (last.y - p.y) * space.height) * scale < 2)
        return;
      if (g.points.length >= 1900) g.points = g.points.filter((_, i) => i % 2 === 0);
      g.points.push(p);
      if (tool === 'crop') setLiveCrop(captureRectangle(g.start, p));
      else setLive(makeObject(g.points));
    }
  }
  function up(event: ReactPointerEvent<SVGSVGElement>) {
    const g = gesture.current;
    if (!g || g.id !== event.pointerId) return;
    const p = point(event);
    gesture.current = null;
    setLive(null);
    setLiveCrop(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (g.mode === 'draw' && tool === 'crop') {
      const rect = captureRectangle(g.start, p);
      if (rect.width * space.width * scale >= 3 && rect.height * space.height * scale >= 3)
        commit({ ...model.current, crop: rect });
      return;
    }
    let object: CaptureObject | null = null;
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
    else object = makeObject([...g.points, p]);
    if (
      object &&
      commit({
        ...model.current,
        objects: g.object
          ? model.current.objects.map((o) => (o.id === object!.id ? object! : o))
          : [...model.current.objects, object],
      })
    )
      setSelected(object.id);
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
  function patchSelected(patch: Record<string, unknown>) {
    if (active)
      commit({
        ...model.current,
        objects: model.current.objects.map((o) =>
          o.id === active.id ? ({ ...o, ...patch } as CaptureObject) : o,
        ),
      });
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
              value={width}
              onChange={(e) => {
                setWidth(Number(e.target.value));
                if (active && 'points' in active)
                  patchSelected({
                    width: clamp(
                      Number(e.target.value) / scale,
                      1,
                      active.kind === 'pen' || active.kind === 'arrow'
                        ? 128
                        : active.kind === 'highlight'
                          ? 256
                          : 512,
                    ),
                  });
              }}
            />
          </label>
          {(tool === 'text' || active?.kind === 'text') && (
            <select
              aria-label={t.textStyle}
              value={active?.kind === 'text' ? active.style : textStyle}
              onChange={(e) => {
                const next = e.target.value as typeof textStyle;
                setTextStyle(next);
                if (active?.kind === 'text')
                  patchSelected({
                    style: next,
                    tail:
                      next === 'bubble'
                        ? active.tail || {
                            x: clamp(active.point.x + 0.06),
                            y: clamp(active.point.y + 0.14),
                          }
                        : undefined,
                  });
              }}
            >
              <option value="plain">{t.capturePlain}</option>
              <option value="sticky">{t.captureSticky}</option>
              <option value="bubble">{t.captureBubble}</option>
            </select>
          )}
          {['redact', 'mosaic', 'spotlight'].includes(tool) && (
            <select
              aria-label={t.captureBrush}
              value={shape}
              onChange={(e) => setShape(e.target.value as typeof shape)}
            >
              <option value="rect">{t.captureRect}</option>
              <option value="stroke">{t.captureBrush}</option>
            </select>
          )}
          {active?.kind === 'text' && (
            <label>
              {t.captureFontSize}
              <input
                type="number"
                min="8"
                max="512"
                value={Math.round(active.fontSize)}
                onChange={(e) => {
                  if (e.target.value)
                    patchSelected({ fontSize: clamp(Number(e.target.value), 8, 512) });
                }}
              />
            </label>
          )}
          {active?.kind === 'spotlight' && (
            <input
              aria-label={t.captureCaption}
              placeholder={t.captureCaption}
              maxLength={500}
              value={active.caption || ''}
              onChange={(e) => patchSelected({ caption: e.target.value })}
            />
          )}
          {active && (active.kind === 'text' || active.kind === 'comment') && (
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
              cursor: tool === 'select' ? 'default' : 'crosshair',
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
              setLiveCrop(null);
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
            {preview &&
              (() => {
                const pc = preview.drawing.crop || wholeCapture;
                return (
                  <image
                    href={capturePreviewUrl(owner, preview.version)}
                    x={pc.x * space.width}
                    y={pc.y * space.height}
                    width={pc.width * space.width}
                    height={pc.height * space.height}
                  />
                );
              })()}
            {live &&
              ('points' in live ? (
                (live.kind === 'redact' || live.kind === 'mosaic' || live.kind === 'spotlight') &&
                live.shape === 'rect' ? (
                  <rect
                    x={Math.min(live.points[0].x, live.points.at(-1)!.x) * space.width}
                    y={Math.min(live.points[0].y, live.points.at(-1)!.y) * space.height}
                    width={Math.abs(live.points.at(-1)!.x - live.points[0].x) * space.width}
                    height={Math.abs(live.points.at(-1)!.y - live.points[0].y) * space.height}
                    fill={live.kind === 'redact' ? '#000' : '#007f7833'}
                    stroke="#007f78"
                    strokeWidth={2 / scale}
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
            {liveCrop && (
              <rect
                x={liveCrop.x * space.width}
                y={liveCrop.y * space.height}
                width={liveCrop.width * space.width}
                height={liveCrop.height * space.height}
                fill="#007f7822"
                stroke="#007f78"
                strokeWidth={2 / scale}
                strokeDasharray={`${5 / scale} ${3 / scale}`}
                pointerEvents="none"
              />
            )}
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
                />
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
      <details className="capture-object-list">
        <summary>
          {t.captureObjects} · {drawing.objects.length}
        </summary>
        {!drawing.objects.length ? (
          <p>{t.captureNoObjects}</p>
        ) : (
          drawing.objects.map((o, i) => (
            <Button
              key={o.id}
              aria-pressed={selected === o.id}
              onClick={() => {
                finishText();
                setTool('select');
                setSelected(o.id);
              }}
            >
              {i + 1}. {labels[o.kind]}
              {'text' in o
                ? ` — ${o.text.slice(0, 70)}`
                : o.kind === 'spotlight' && o.caption
                  ? ` — ${o.caption}`
                  : ''}
            </Button>
          ))
        )}
      </details>
      <p id="capture-keyboard-help" className="sr-only">
        {t.captureKeyboardHelp}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <div
          className="capture-text-editor"
          style={{ position: 'fixed', ...position }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              editText(null);
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              finishText();
              svg.current?.focus();
            }
          }}
        >
          <label>
            {t.captureTextBody}
            <textarea
              ref={editor}
              aria-label={t.captureTextBody}
              maxLength={2000}
              value={editing.text}
              onChange={(e) => editText({ ...editing, text: e.target.value })}
            />
          </label>
          <div className="modal-actions">
            <Button
              variant="primary"
              onClick={() => {
                finishText();
                svg.current?.focus();
              }}
            >
              {t.captureApplyText}
            </Button>
            <Button
              onClick={() => {
                editText(null);
                svg.current?.focus();
              }}
            >
              {t.cancel}
            </Button>
          </div>
        </div>
      )}
      <span className="sr-only">{revision}</span>
    </Modal>
  );
}
