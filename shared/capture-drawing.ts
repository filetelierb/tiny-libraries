import { z } from 'zod';

export const MAX_CAPTURE_ITEMS = 12;
export const MAX_CAPTURE_OBJECTS = 100;
export const MAX_CAPTURE_POINTS = 3000;
export const MAX_CAPTURE_DRAWING_BYTES = 256 * 1024;
export const capturePointSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();
export type CapturePoint = z.infer<typeof capturePointSchema>;
export const captureRectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .refine(
    (rect) => rect.x + rect.width <= 1 + 1e-9 && rect.y + rect.height <= 1 + 1e-9,
    'Region must remain within the base image',
  );
export type CaptureRect = z.infer<typeof captureRectSchema>;
export const captureSpaceSchema = z
  .object({ width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) })
  .strict()
  .refine(
    (size) => size.width * size.height <= 16 * 1024 * 1024,
    'Image dimensions exceed the capture limit',
  );
export type CaptureSpace = z.infer<typeof captureSpaceSchema>;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const id = z.string().uuid();
const points = z.array(capturePointSchema).min(1).max(2000);
const region = { shape: z.enum(['rect', 'stroke']), points, width: z.number().min(1).max(128) };
export const captureObjectSchema = z.discriminatedUnion('kind', [
  z
    .object({ id, kind: z.literal('pen'), points, color, width: z.number().min(1).max(24) })
    .strict(),
  z
    .object({ id, kind: z.literal('highlight'), points, color, width: z.number().min(1).max(64) })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('arrow'),
      points: z.tuple([capturePointSchema, capturePointSchema]),
      color,
      width: z.number().min(1).max(24),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('text'),
      point: capturePointSchema,
      text: z.string().trim().min(1).max(2000),
      color,
      fontSize: z.number().min(8).max(96),
      style: z.enum(['plain', 'sticky', 'bubble']),
      tail: capturePointSchema.optional(),
    })
    .strict()
    .refine((value) => value.style === 'bubble' || !value.tail, 'Only bubble text may have a tail'),
  z
    .object({
      id,
      kind: z.literal('comment'),
      point: capturePointSchema,
      number: z.number().int().min(1).max(100),
      text: z.string().trim().min(1).max(2000),
      color,
    })
    .strict(),
  z.object({ id, kind: z.literal('redact'), ...region }).strict(),
  z
    .object({
      id,
      kind: z.literal('mosaic'),
      ...region,
      pixelSize: z.number().int().min(4).max(64),
    })
    .strict(),
  z
    .object({
      id,
      kind: z.literal('spotlight'),
      ...region,
      color,
      caption: z.string().max(500).optional(),
    })
    .strict(),
]);
export type CaptureObject = z.infer<typeof captureObjectSchema>;
export const captureDrawingSchema = z
  .object({
    format: z.literal(1),
    space: captureSpaceSchema,
    objects: z.array(captureObjectSchema).max(MAX_CAPTURE_OBJECTS),
    crop: captureRectSchema.optional(),
  })
  .strict()
  .superRefine((drawing, ctx) => {
    if (new Set(drawing.objects.map((item) => item.id)).size !== drawing.objects.length)
      ctx.addIssue({ code: 'custom', message: 'Capture object identities must be unique' });
    if (
      drawing.objects.reduce((sum, item) => sum + ('points' in item ? item.points.length : 1), 0) >
      MAX_CAPTURE_POINTS
    )
      ctx.addIssue({ code: 'custom', message: 'Capture drawing has too many points' });
    if (
      drawing.objects.some(
        (item) => 'shape' in item && item.shape === 'rect' && item.points.length !== 2,
      )
    )
      ctx.addIssue({ code: 'custom', message: 'A rectangular region requires two corners' });
    if (new TextEncoder().encode(JSON.stringify(drawing)).length > MAX_CAPTURE_DRAWING_BYTES)
      ctx.addIssue({ code: 'custom', message: 'Capture drawing exceeds 256 KB' });
  });
export type CaptureDrawing = z.infer<typeof captureDrawingSchema>;
export const wholeCapture: CaptureRect = { x: 0, y: 0, width: 1, height: 1 };
export function emptyCaptureDrawing(space: CaptureSpace): CaptureDrawing {
  return captureDrawingSchema.parse({ format: 1, space, objects: [] });
}
export function captureRectangle(a: CapturePoint, b: CapturePoint): CaptureRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}
/** Pointer coordinates are projected through the current crop into immutable base coordinates. */
export function capturePointFromView(
  point: CapturePoint,
  crop: CaptureRect = wholeCapture,
): CapturePoint {
  return {
    x: Math.max(0, Math.min(1, crop.x + point.x * crop.width)),
    y: Math.max(0, Math.min(1, crop.y + point.y * crop.height)),
  };
}
export function capturePointToView(
  point: CapturePoint,
  crop: CaptureRect = wholeCapture,
): CapturePoint {
  return { x: (point.x - crop.x) / crop.width, y: (point.y - crop.y) / crop.height };
}
/** Crop output always covers at least one pixel and never samples outside the base. */
export function capturePixelCrop(space: CaptureSpace, crop: CaptureRect = wholeCapture) {
  const x = Math.min(space.width - 1, Math.floor(crop.x * space.width)),
    y = Math.min(space.height - 1, Math.floor(crop.y * space.height));
  return {
    x,
    y,
    width: Math.min(
      space.width - x,
      Math.max(1, Math.ceil((crop.x + crop.width) * space.width) - x),
    ),
    height: Math.min(
      space.height - y,
      Math.max(1, Math.ceil((crop.y + crop.height) * space.height) - y),
    ),
  };
}
export function captureCommentText(drawing: CaptureDrawing) {
  return drawing.objects
    .filter((item) => item.kind === 'comment')
    .sort((a, b) => a.number - b.number)
    .map((item) => `${item.number}. ${item.text}`)
    .join('\n');
}
