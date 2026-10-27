import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import {
  captureDrawingSchema,
  capturePixelCrop,
  type CaptureDrawing,
  type CaptureObject,
  type CapturePoint,
} from '../shared/capture-drawing';

type Region = Extract<CaptureObject, { kind: 'redact' | 'mosaic' | 'spotlight' }>;
function point(p: CapturePoint, drawing: CaptureDrawing) {
  return { x: p.x * drawing.space.width, y: p.y * drawing.space.height };
}
function path(ctx: SKRSContext2D, points: CapturePoint[], drawing: CaptureDrawing) {
  ctx.beginPath();
  points.forEach((p, i) => {
    const v = point(p, drawing);
    if (i === 0) ctx.moveTo(v.x, v.y);
    else ctx.lineTo(v.x, v.y);
  });
}
/** Closed positive-area subpaths make overlapping brush regions a union. */
function regionPath(ctx: SKRSContext2D, object: Region, drawing: CaptureDrawing) {
  ctx.beginPath();
  const pts = object.points.map((p) => point(p, drawing));
  if (object.shape === 'rect') {
    const [a, b] = pts;
    ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    return;
  }
  const radius = object.width / 2;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    ctx.moveTo(a.x + radius, a.y);
    ctx.arc(a.x, a.y, radius, 0, Math.PI * 2);
    const b = pts[i + 1];
    if (!b) continue;
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    if (!distance) continue;
    const dx = (-(b.y - a.y) * radius) / distance,
      dy = ((b.x - a.x) * radius) / distance;
    ctx.moveTo(a.x - dx, a.y - dy);
    ctx.lineTo(b.x - dx, b.y - dy);
    ctx.lineTo(b.x + dx, b.y + dy);
    ctx.lineTo(a.x + dx, a.y + dy);
    ctx.closePath();
  }
}
function lines(text: string, ctx: SKRSContext2D, maxWidth: number) {
  const result: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > maxWidth && line) {
        result.push(line);
        line = word;
      } else line = next;
    }
    if (line || !paragraph) result.push(line);
  }
  return result.slice(0, 100);
}
function textObject(
  ctx: SKRSContext2D,
  object: Extract<CaptureObject, { kind: 'text' }>,
  drawing: CaptureDrawing,
) {
  const anchor = point(object.point, drawing),
    fontSize = object.fontSize,
    padding = object.style === 'plain' ? 0 : 8;
  ctx.font = `${fontSize}px "Times New Roman", serif`;
  ctx.textBaseline = 'top';
  const content = lines(
    object.text,
    ctx,
    Math.max(fontSize, Math.min(360, drawing.space.width - 2 * padding)),
  );
  const width = Math.min(
    drawing.space.width,
    Math.max(fontSize, ...content.map((line) => ctx.measureText(line).width)) + 2 * padding,
  );
  const height = content.length * fontSize * 1.25 + padding * 2;
  const x = Math.max(0, Math.min(anchor.x, drawing.space.width - width)),
    y = Math.max(
      0,
      Math.min(anchor.y, drawing.space.height - Math.min(height, drawing.space.height)),
    );
  if (object.style !== 'plain') {
    ctx.fillStyle = '#202f36';
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    if (object.style === 'bubble' && object.tail) {
      const tail = point(object.tail, drawing);
      ctx.beginPath();
      ctx.moveTo(x + width * 0.35, y + height);
      ctx.lineTo(tail.x, tail.y);
      ctx.lineTo(x + width * 0.65, y + height);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 6);
    ctx.fill();
    ctx.stroke();
  }
  ctx.fillStyle = object.style === 'plain' ? object.color : '#ffffff';
  content.forEach((line, i) => ctx.fillText(line, x + padding, y + padding + i * fontSize * 1.25));
}

/** Flatten only local bounded PNG bytes. Cropped or redacted pixels never travel in the output. */
export async function renderCapture(bytes: Uint8Array, raw: CaptureDrawing) {
  const drawing = captureDrawingSchema.parse(raw);
  if (
    bytes.length < 33 ||
    bytes.length > 8 * 1024 * 1024 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  )
    throw new Error('Capture base must be a PNG of 8 MB or less');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(16) !== drawing.space.width || header.getUint32(20) !== drawing.space.height)
    throw new Error('Drawing dimensions do not match its immutable base');
  const image = await loadImage(Buffer.from(bytes));
  const crop = capturePixelCrop(drawing.space, drawing.crop);
  const scale = Math.min(1, 1600 / Math.max(crop.width, crop.height));
  const width = Math.max(1, Math.round(crop.width * scale)),
    height = Math.max(1, Math.round(crop.height * scale));
  const canvas = createCanvas(width, height),
    ctx = canvas.getContext('2d');
  ctx.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
  const sx = width / crop.width,
    sy = height / crop.height,
    tx = -crop.x * sx,
    ty = -crop.y * sy;
  ctx.setTransform(sx, 0, 0, sy, tx, ty);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const redactions = drawing.objects.filter((object) => object.kind === 'redact');
  const redactMask = redactions.length ? createCanvas(width, height) : null;
  if (redactMask) {
    const mask = redactMask.getContext('2d');
    mask.setTransform(sx, 0, 0, sy, tx, ty);
    mask.fillStyle = '#000000';
    for (const object of redactions) {
      regionPath(mask, object, drawing);
      mask.fill();
    }
    const pixels = mask.getImageData(0, 0, width, height);
    for (let i = 0; i < pixels.data.length; i += 4)
      if (pixels.data[i + 3]) {
        pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 0;
        pixels.data[i + 3] = 255;
      }
    mask.resetTransform();
    mask.putImageData(pixels, 0, 0);
    // Remove covered pixels before any sampling/filtering, then enforce the mask again on export.
    ctx.save();
    ctx.resetTransform();
    ctx.drawImage(redactMask, 0, 0);
    ctx.restore();
  }
  const spotlights = drawing.objects.filter((object) => object.kind === 'spotlight');
  if (spotlights.length) {
    const mask = createCanvas(width, height),
      shadow = mask.getContext('2d');
    shadow.fillStyle = 'rgba(0,0,0,.52)';
    shadow.fillRect(0, 0, width, height);
    shadow.setTransform(sx, 0, 0, sy, tx, ty);
    shadow.globalCompositeOperation = 'destination-out';
    shadow.fillStyle = '#000000';
    for (const object of spotlights) {
      regionPath(shadow, object, drawing);
      shadow.fill();
    }
    ctx.save();
    ctx.resetTransform();
    ctx.drawImage(mask, 0, 0);
    ctx.restore();
  }
  for (const object of drawing.objects) {
    ctx.save();
    ctx.globalAlpha = 1;
    if (object.kind === 'pen' || object.kind === 'highlight') {
      ctx.strokeStyle = object.color;
      ctx.fillStyle = object.color;
      ctx.lineWidth = object.width;
      ctx.globalAlpha = object.kind === 'highlight' ? 0.3 : 1;
      path(ctx, object.points, drawing);
      if (object.points.length === 1) {
        const p = point(object.points[0], drawing);
        ctx.arc(p.x, p.y, object.width / 2, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.stroke();
    } else if (object.kind === 'arrow') {
      const [a, b] = object.points.map((p) => point(p, drawing));
      ctx.strokeStyle = object.color;
      ctx.fillStyle = object.color;
      ctx.lineWidth = object.width;
      path(ctx, object.points, drawing);
      ctx.stroke();
      const angle = Math.atan2(b.y - a.y, b.x - a.x),
        size = Math.max(10, object.width * 4);
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(
        b.x - size * Math.cos(angle - Math.PI / 6),
        b.y - size * Math.sin(angle - Math.PI / 6),
      );
      ctx.lineTo(
        b.x - size * Math.cos(angle + Math.PI / 6),
        b.y - size * Math.sin(angle + Math.PI / 6),
      );
      ctx.closePath();
      ctx.fill();
    } else if (object.kind === 'text') textObject(ctx, object, drawing);
    else if (object.kind === 'comment') {
      const p = point(object.point, drawing);
      ctx.fillStyle = object.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(object.number), p.x, p.y);
    } else if (object.kind === 'mosaic') {
      // Rasterize before clipping; nearest-neighbor expansion is a cosmetic pixel effect.
      const small = createCanvas(
        Math.max(1, Math.ceil(width / (object.pixelSize * sx))),
        Math.max(1, Math.ceil(height / (object.pixelSize * sy))),
      );
      small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
      regionPath(ctx, object, drawing);
      ctx.clip();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, crop.x, crop.y, crop.width, crop.height);
    } else if (object.kind === 'spotlight') {
      regionPath(ctx, object, drawing);
      ctx.strokeStyle = object.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (object.caption)
        textObject(
          ctx,
          {
            id: object.id,
            kind: 'text',
            point: object.points[0],
            text: object.caption,
            color: object.color,
            fontSize: 17,
            style: 'sticky',
          },
          drawing,
        );
    }
    ctx.restore();
  }
  if (redactMask) {
    ctx.save();
    ctx.resetTransform();
    ctx.drawImage(redactMask, 0, 0);
    ctx.restore();
  }
  const png = canvas.toBuffer('image/png');
  if (png.length > 3 * 1024 * 1024) throw new Error('Flattened capture exceeds 3 MB');
  return { bytes: png, width, height };
}
