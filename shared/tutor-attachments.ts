import { z } from 'zod';
import { locationSchema } from './annotations';
import type { Segment } from './domain';

export const MAX_QUESTION_ATTACHMENTS = 6;
export const MAX_ATTACHMENT_TEXT_BYTES = 1024 * 1024;
export const MAX_ATTACHMENT_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_QUESTION_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_ATTACHMENT_SEGMENTS = 600;
export const attachmentIdsSchema = z
  .array(z.string().uuid())
  .max(MAX_QUESTION_ATTACHMENTS)
  .refine((ids) => new Set(ids).size === ids.length, 'Choose each attachment once');
const createBase = z.object({ id: z.string().uuid(), sessionId: z.string().uuid() });
export const attachmentInputSchema = z.discriminatedUnion('kind', [
  createBase.extend({
    kind: z.literal('file'),
    sourceId: z.string().uuid(),
    sourceVersion: z.number().int().positive(),
  }),
  createBase.extend({
    kind: z.literal('annotation'),
    annotationId: z.string().uuid(),
    revision: z.number().int().positive(),
  }),
]);
export type AttachmentInput = z.infer<typeof attachmentInputSchema>;
export const questionAttachmentSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  kind: z.enum(['file', 'annotation', 'bookmark', 'capture']),
  name: z.string().min(1).max(240),
  sourceId: z.string().uuid().nullable(),
  sourceVersion: z.number().int().positive().nullable(),
  sourceName: z.string().max(240).nullable(),
  annotationId: z.string().uuid().optional(),
  annotationRevision: z.number().int().positive().optional(),
  location: locationSchema,
  segmentCount: z.number().int().min(1).max(MAX_ATTACHMENT_SEGMENTS),
  textBytes: z.number().int().min(0).max(MAX_ATTACHMENT_TEXT_BYTES),
  image: z
    .object({
      id: z.string().uuid(),
      mime: z.enum(['image/png', 'image/jpeg']),
      size: z.number().int().positive().max(MAX_ATTACHMENT_IMAGE_BYTES),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
  createdAt: z.string(),
});
export type QuestionAttachment = z.infer<typeof questionAttachmentSchema>;
export const attachmentMentionSchema = questionAttachmentSchema.pick({
  id: true,
  kind: true,
  name: true,
});
export const attachmentMentionsSchema = z
  .array(attachmentMentionSchema)
  .max(MAX_QUESTION_ATTACHMENTS)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length);
export type AttachmentMention = z.infer<typeof attachmentMentionSchema>;
export function attachmentMention(value: QuestionAttachment): AttachmentMention {
  return { id: value.id, kind: value.kind, name: value.name };
}
export type AttachmentSegment = Segment & { originalId?: string };
export type AttachmentContent = { attachment: QuestionAttachment; segments: AttachmentSegment[] };
export const attachmentEvidenceId = (id: string, index: number) =>
  `attachment.${id}.part-${index + 1}`;

/** Split evidence without losing its source page/time or dropping the end of a long passage. */
export function attachmentSegments(id: string, segments: Segment[]): AttachmentSegment[] {
  const bytes = segments.reduce((sum, item) => sum + new TextEncoder().encode(item.text).length, 0);
  if (bytes > MAX_ATTACHMENT_TEXT_BYTES)
    throw new Error('Attachment text exceeds 1 MB; choose a smaller source or passage');
  const result: AttachmentSegment[] = [];
  for (const original of segments) {
    if (original.id.length > 500)
      throw new Error('Source evidence identifier is too long; prepare this source again');
    const characters = Array.from(original.text);
    for (let start = 0; start < characters.length; start += 2000) {
      result.push({
        ...original,
        id: attachmentEvidenceId(id, result.length),
        originalId: original.id,
        text: characters.slice(start, start + 2000).join(''),
      });
      if (result.length > MAX_ATTACHMENT_SEGMENTS)
        throw new Error('Attachment has too many passages; choose a smaller source');
    }
  }
  if (!result.length) throw new Error('This attachment has no text or image');
  return result;
}
