import { z } from 'zod';
import { locationSchema } from './locations';
import {
  MAX_CAPTURE_ITEMS,
  captureSpaceSchema,
  captureDrawingSchema,
  type CaptureDrawing,
} from './capture-drawing';

export const captureDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const captureOriginSchema = z.enum(['pdf_page', 'video_frame', 'image', 'text_excerpt']);
export const sourceStampSchema = z
  .object({
    id: z.string().uuid(),
    sourceId: z.string().uuid(),
    sourceVersion: z.number().int().positive(),
    label: z.string().max(240),
    location: locationSchema,
  })
  .strict()
  .refine(
    (value) =>
      (value.location.page !== undefined ||
        value.location.seconds !== undefined ||
        !!value.location.quote?.trim()) &&
      !(value.location.page !== undefined && value.location.seconds !== undefined),
    'Choose one source page, time or excerpt',
  );
export type SourceStamp = z.infer<typeof sourceStampSchema>;
export function stampIdentity(stamp: SourceStamp) {
  const where =
    stamp.location.page !== undefined
      ? `page:${stamp.location.page}`
      : stamp.location.seconds !== undefined
        ? `time:${stamp.location.seconds.toFixed(3)}`
        : `quote:${stamp.location.quote}`;
  return `${stamp.sourceId}:v${stamp.sourceVersion}:${where}`;
}
export const sourceStampsSchema = z
  .array(sourceStampSchema)
  .max(40)
  .refine(
    (items) =>
      new Set(items.map((item) => item.id)).size === items.length &&
      new Set(items.map(stampIdentity)).size === items.length,
    'Source locations must be unique',
  );
export const captureDescriptorSchema = z
  .object({
    annotationId: z.string().uuid(),
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    sourceId: z.string().uuid().nullable(),
    sourceVersion: z.number().int().positive().nullable(),
    origin: captureOriginSchema,
    stamp: sourceStampSchema.optional(),
  })
  .strict()
  .refine(
    (value) => !!value.sourceId === (value.sourceVersion !== null),
    'Keep source identity and version together',
  );
export type CaptureDescriptor = z.infer<typeof captureDescriptorSchema>;
export const captureSelectionSchema = z.object({
  id: z.string().uuid(),
  drawingDigest: captureDigestSchema,
  label: z.string().max(240),
});
export type CaptureSelection = z.infer<typeof captureSelectionSchema>;
export const captureSelectionsSchema = z
  .array(captureSelectionSchema)
  .max(MAX_CAPTURE_ITEMS)
  .refine(
    (items) => new Set(items.map((item) => item.id)).size === items.length,
    'Capture identities must be unique',
  );
export const publishedCaptureSchema = captureSelectionSchema.extend({
  baseDigest: captureDigestSchema,
  previewDigest: captureDigestSchema,
  width: z.number().int().min(1).max(1600),
  height: z.number().int().min(1).max(1600),
  size: z
    .number()
    .int()
    .min(1)
    .max(3 * 1024 * 1024),
  origin: captureOriginSchema,
  space: captureSpaceSchema,
  stamp: sourceStampSchema.optional(),
});
export type PublishedCapture = z.infer<typeof publishedCaptureSchema>;
export async function captureDigest(value: Uint8Array | string) {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export function captureDrawingDigest(value: CaptureDrawing) {
  return captureDigest(JSON.stringify(captureDrawingSchema.parse(value)));
}
