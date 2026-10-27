import { createCanvas, loadImage } from '@napi-rs/canvas';
import { drawingSchema, type DrawingStroke } from '../shared/annotations';
import { MAX_ATTACHMENT_IMAGE_BYTES } from '../shared/tutor-attachments';

/** Composite only bounded PNG bytes; URLs and filesystem paths are never accepted. */
export async function composeCapture(bytes: Uint8Array, strokes: DrawingStroke[]) {
  if (
    bytes.length < 33 ||
    bytes.length > MAX_ATTACHMENT_IMAGE_BYTES ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  )
    throw new Error('Capture must be a PNG of 3 MB or less');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    width = view.getUint32(16),
    height = view.getUint32(20);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16 * 1024 * 1024)
    throw new Error('Capture dimensions are too large');
  const validated = drawingSchema.parse(strokes);
  const image = await loadImage(Buffer.from(bytes));
  const scale = Math.min(1, 1600 / Math.max(width, height));
  const canvas = createCanvas(
      Math.max(1, Math.round(width * scale)),
      Math.max(1, Math.round(height * scale)),
    ),
    ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  // SVG drawing uses a normalized 1000x1000 view box with non-scaling strokes.
  for (const stroke of validated) {
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.globalAlpha = stroke.width >= 10 ? 0.3 : 1;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    stroke.points.forEach((point, index) => {
      const x = point.x * canvas.width,
        y = point.y * canvas.height;
      if (!index) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (stroke.points.length === 1) {
      const point = stroke.points[0];
      ctx.arc(point.x * canvas.width, point.y * canvas.height, stroke.width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else ctx.stroke();
  }
  const result = canvas.toBuffer('image/png');
  if (result.length > MAX_ATTACHMENT_IMAGE_BYTES) throw new Error('Drawn capture exceeds 3 MB');
  return result;
}
