import type {
  CaptureObject,
  CapturePoint,
  CaptureRect,
  CaptureSpace,
} from '../../shared/capture-drawing';

const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export function distToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const qx = a.x + t * dx,
    qy = a.y + t * dy;
  return Math.hypot(p.x - qx, p.y - qy);
}
export function captureObjectBounds(object: CaptureObject, space: CaptureSpace): CaptureRect {
  if (object.kind === 'text') {
    const padding = object.style === 'plain' ? 0 : 16,
      maxWidth = Math.min(space.width, 360),
      letter = object.fontSize * 0.58;
    const lines = object.text.split('\n'),
      width = Math.min(
        space.width,
        Math.max(
          object.fontSize,
          Math.min(maxWidth, Math.max(...lines.map((line) => line.length * letter))),
        ) + padding,
      );
    const rows = lines.reduce(
        (n, line) =>
          n + Math.max(1, Math.ceil((line.length * letter) / Math.max(1, maxWidth - padding))),
        0,
      ),
      height = Math.min(space.height, rows * object.fontSize * 1.25 + padding);
    return {
      x: clamp(object.point.x, 0, Math.max(0, 1 - width / space.width)),
      y: clamp(object.point.y, 0, Math.max(0, 1 - height / space.height)),
      width: width / space.width,
      height: height / space.height,
    };
  }
  if (object.kind === 'comment') {
    const radius = object.size || 11;
    return {
      x: object.point.x - radius / space.width,
      y: object.point.y - radius / space.height,
      width: (radius * 2) / space.width,
      height: (radius * 2) / space.height,
    };
  }
  const xs = object.points.map((point) => point.x),
    ys = object.points.map((point) => point.y),
    minX = Math.min(...xs),
    minY = Math.min(...ys);
  const margin = 'shape' in object && object.shape === 'rect' ? 0 : object.width / 2;
  return {
    x: minX - margin / space.width,
    y: minY - margin / space.height,
    width: Math.max(1 / space.width, Math.max(...xs) - minX + (margin * 2) / space.width),
    height: Math.max(1 / space.height, Math.max(...ys) - minY + (margin * 2) / space.height),
  };
}
export function transformCaptureObject(
  object: CaptureObject,
  before: CaptureRect,
  after: CaptureRect,
): CaptureObject {
  const map = (p: CapturePoint) => ({
    x: clamp(after.x + ((p.x - before.x) * after.width) / Math.max(before.width, 1e-8)),
    y: clamp(after.y + ((p.y - before.y) * after.height) / Math.max(before.height, 1e-8)),
  });
  const scale = Math.sqrt(
    Math.abs((after.width * after.height) / Math.max(before.width * before.height, 1e-10)),
  );
  if (object.kind === 'text')
    return {
      ...object,
      point: map(object.point),
      fontSize: clamp(object.fontSize * scale, 8, 512),
      ...(object.tail ? { tail: map(object.tail) } : {}),
    };
  if (object.kind === 'comment')
    return {
      ...object,
      point: map(object.point),
      size: clamp((object.size || 11) * scale, 8, 256),
    };
  const points = object.points.map(map);
  if (object.kind === 'arrow')
    return {
      ...object,
      points: [points[0], points[1]],
      width: clamp(object.width * scale, 1, 128),
    };
  return {
    ...object,
    points,
    width: clamp(
      object.width * scale,
      1,
      object.kind === 'pen' ? 128 : object.kind === 'highlight' ? 256 : 512,
    ),
  };
}
export function moveCaptureObject(object: CaptureObject, delta: CapturePoint, space: CaptureSpace) {
  const before = captureObjectBounds(object, space),
    after = {
      ...before,
      x: clamp(before.x + delta.x, 0, Math.max(0, 1 - before.width)),
      y: clamp(before.y + delta.y, 0, Math.max(0, 1 - before.height)),
    };
  return transformCaptureObject(object, before, after);
}
export function captureEditorPlacement(
  anchor: { x: number; y: number },
  size: { width: number; height: number },
  viewport: { x: number; y: number; width: number; height: number },
) {
  const margin = 12,
    gap = 14,
    width = Math.min(320, viewport.width - margin * 2),
    height = Math.min(size.height, viewport.height - margin * 2);
  const left = anchor.x < viewport.x + viewport.width / 2 ? anchor.x + gap : anchor.x - width - gap;
  const top =
    anchor.y < viewport.y + viewport.height / 2 ? anchor.y + gap : anchor.y - height - gap;
  return {
    left: clamp(
      left,
      viewport.x + margin,
      Math.max(viewport.x + margin, viewport.x + viewport.width - width - margin),
    ),
    top: clamp(
      top,
      viewport.y + margin,
      Math.max(viewport.y + margin, viewport.y + viewport.height - height - margin),
    ),
    width,
    maxHeight: height,
  };
}
