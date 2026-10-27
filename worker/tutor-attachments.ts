import {
  attachmentInputSchema,
  attachmentIdsSchema,
  questionAttachmentSchema,
  attachmentSegments,
  MAX_ATTACHMENT_IMAGE_BYTES,
  MAX_QUESTION_IMAGE_BYTES,
  MAX_ATTACHMENT_TEXT_BYTES,
  type AttachmentInput,
  type QuestionAttachment,
  type AttachmentSegment,
  type AttachmentContent,
} from '../shared/tutor-attachments';
import type { Annotation, DrawingStroke } from '../shared/annotations';
import type { Source, Directory, Learning, Segment } from '../shared/domain';
import { sourceState } from '../shared/directories';
import type { GlossaryStorage } from './glossary';
import type { R2Bucket } from '@cloudflare/workers-types';

export class AttachmentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export type AttachmentStore = GlossaryStorage;
type StoredAttachment = QuestionAttachment & { input: string };
type Files = Pick<R2Bucket, 'get' | 'put' | 'delete'>;
type Compose = (bytes: Uint8Array, strokes: DrawingStroke[]) => Promise<Uint8Array>;
const recordKey = (id: string) => `tutor-attachment:${id}`;
const segmentKey = (id: string, index: number) =>
  `tutor-attachment-part:${id}:${String(index).padStart(4, '0')}`;
export const attachmentImageKey = (id: string, imageId: string) =>
  `tutor-attachment/${id}/${imageId}`;

async function availableSource(
  storage: Pick<AttachmentStore, 'get' | 'list'>,
  id: string,
  version: number | null,
) {
  const source = await storage.get<Source>(`file:${id}`);
  const directories = [...(await storage.list<Directory>({ prefix: 'directory:' })).values()];
  if (!source || source.version !== version || sourceState(source, directories) === 'trash')
    throw new AttachmentError(
      'The attachment source changed or is in Trash. Choose it again.',
      409,
    );
  return source;
}
async function originalBytes(files: Files, key: string, limit: number) {
  const object = await files.get(key);
  if (!object) throw new AttachmentError('Attachment bytes are unavailable', 404);
  if (!object.size || object.size > limit)
    throw new AttachmentError('Attachment exceeds its size limit', 413);
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length > limit) throw new AttachmentError('Attachment exceeds its size limit', 413);
  return bytes;
}

export async function createQuestionAttachment(
  storage: AttachmentStore,
  files: Files,
  input: AttachmentInput,
  compose: Compose,
): Promise<QuestionAttachment> {
  const fingerprint = JSON.stringify(input),
    key = recordKey(input.id);
  const previous = await storage.get<StoredAttachment>(key);
  if (previous) {
    if (previous.input !== fingerprint)
      throw new AttachmentError('Attachment retry used different content', 409);
    return questionAttachmentSchema.parse(previous);
  }
  if (!(await storage.get(`session:${input.sessionId}`)))
    throw new AttachmentError('Study session not found', 404);
  let source: Source | undefined,
    annotation: Annotation | undefined,
    bytes: Uint8Array | undefined,
    mime: 'image/png' | 'image/jpeg' = 'image/png',
    segments: Segment[] = [],
    kind: QuestionAttachment['kind'] = 'file',
    name = '';
  if (input.kind === 'file') {
    source = await availableSource(storage, input.sourceId, input.sourceVersion);
    name = source.name;
    const learning = await storage.get<Learning>(`learning:${source.id}`);
    if (source.kind === 'image') {
      mime = /\.png$/i.test(source.name) ? 'image/png' : 'image/jpeg';
      bytes = await originalBytes(
        files,
        `original/${source.id}/${source.version}`,
        MAX_ATTACHMENT_IMAGE_BYTES,
      );
      const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
      const jpeg = bytes[0] === 255 && bytes[1] === 216;
      if ((mime === 'image/png' && !png) || (mime === 'image/jpeg' && !jpeg))
        throw new AttachmentError('Attachment image does not match its format');
      segments = [
        {
          id: 'image',
          text: 'Attached original image. Visual evidence is supplied separately; this label is not extracted text.',
        },
      ];
    } else if (learning?.sourceVersion === source.version) segments = learning.segments;
    else if (['markdown', 'text'].includes(source.kind)) {
      const data = await originalBytes(
        files,
        `original/${source.id}/${source.version}`,
        MAX_ATTACHMENT_TEXT_BYTES,
      );
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data);
      } catch {
        throw new AttachmentError('Text attachments must use UTF-8');
      }
      segments = [{ id: 'document', text }];
    } else
      throw new AttachmentError(
        'Prepare this PDF or recording in Chapters before attaching its text/transcript',
        409,
      );
  } else {
    annotation = await storage.get<Annotation>(`annotation:${input.annotationId}`);
    if (!annotation || annotation.deleted || annotation.revision !== input.revision)
      throw new AttachmentError('This annotation changed or is deleted. Choose it again.', 409);
    if (!annotation.sourceId && annotation.sessionId !== input.sessionId)
      throw new AttachmentError('This session note belongs to another study session', 409);
    if (annotation.sourceId)
      source = await availableSource(storage, annotation.sourceId, annotation.sourceVersion);
    name = annotation.title || source?.name || 'Annotation';
    kind = annotation.capture
      ? 'capture'
      : annotation.kind === 'bookmark'
        ? 'bookmark'
        : 'annotation';
    const text = [annotation.title, annotation.text, annotation.location.quote]
      .filter(Boolean)
      .join('\n\n');
    if (text.trim())
      segments = [
        {
          id: 'note',
          text,
          ...(annotation.location.page ? { page: annotation.location.page } : {}),
          ...(annotation.location.seconds != null ? { start: annotation.location.seconds } : {}),
        },
      ];
    if (annotation.capture) {
      const original = await originalBytes(
        files,
        `annotation/${annotation.id}/${annotation.capture.id}`,
        MAX_ATTACHMENT_IMAGE_BYTES,
      );
      bytes = await compose(original, annotation.strokes);
      if (bytes.length > MAX_ATTACHMENT_IMAGE_BYTES)
        throw new AttachmentError('Drawn capture exceeds 3 MB', 413);
      if (!segments.length)
        segments = [
          {
            id: 'capture',
            text: 'Attached annotated capture. Visual evidence is supplied separately; this label is not extracted text.',
            ...(annotation.location.page ? { page: annotation.location.page } : {}),
            ...(annotation.location.seconds != null ? { start: annotation.location.seconds } : {}),
          },
        ];
    }
  }
  let parts: AttachmentSegment[];
  try {
    parts = attachmentSegments(input.id, segments);
  } catch (error) {
    throw new AttachmentError(error instanceof Error ? error.message : 'Invalid attachment');
  }
  const imageId = bytes ? crypto.randomUUID() : undefined;
  const snapshot = questionAttachmentSchema.parse({
    id: input.id,
    sessionId: input.sessionId,
    kind,
    name,
    sourceId: source?.id || null,
    sourceVersion: source?.version || null,
    sourceName: source?.name || null,
    ...(annotation ? { annotationId: annotation.id, annotationRevision: annotation.revision } : {}),
    location: annotation?.location || {},
    segmentCount: parts.length,
    textBytes: parts.reduce((sum, part) => sum + new TextEncoder().encode(part.text).length, 0),
    ...(bytes
      ? {
          image: {
            id: imageId,
            mime,
            size: bytes.length,
            digest: [
              ...new Uint8Array(
                await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer),
              ),
            ]
              .map((byte) => byte.toString(16).padStart(2, '0'))
              .join(''),
          },
        }
      : {}),
    createdAt: new Date().toISOString(),
  });
  if (bytes)
    await files.put(attachmentImageKey(input.id, imageId!), bytes, {
      httpMetadata: { contentType: mime },
    });
  try {
    const result = await storage.transaction(async (tx) => {
      const existing = await tx.get<StoredAttachment>(key);
      if (existing) {
        if (existing.input !== fingerprint)
          throw new AttachmentError('Attachment retry used different content', 409);
        return { value: questionAttachmentSchema.parse(existing), published: false };
      }
      if (!(await tx.get(`session:${input.sessionId}`)))
        throw new AttachmentError('Study session not found', 404);
      if (source) await availableSource(tx, source.id, source.version);
      if (annotation) {
        const current = await tx.get<Annotation>(`annotation:${annotation.id}`);
        if (!current || current.deleted || current.revision !== annotation.revision)
          throw new AttachmentError(
            'This annotation changed during attachment creation. Choose it again.',
            409,
          );
      }
      for (let i = 0; i < parts.length; i++) await tx.put(segmentKey(input.id, i), parts[i]);
      await tx.put(key, { ...snapshot, input: fingerprint });
      return { value: snapshot, published: true };
    });
    if (imageId && !result.published) await files.delete(attachmentImageKey(input.id, imageId));
    return result.value;
  } catch (error) {
    if (imageId) await files.delete(attachmentImageKey(input.id, imageId));
    throw error;
  }
}

export async function readQuestionAttachments(
  storage: Pick<AttachmentStore, 'get'>,
  sessionId: string,
  ids: string[],
): Promise<AttachmentContent[]> {
  const result: AttachmentContent[] = [];
  let imageBytes = 0;
  for (const id of attachmentIdsSchema.parse(ids)) {
    const stored = await storage.get<StoredAttachment>(recordKey(id));
    if (!stored || stored.sessionId !== sessionId)
      throw new AttachmentError('Attachment is unavailable in this study session', 409);
    const attachment = questionAttachmentSchema.parse(stored);
    imageBytes += attachment.image?.size || 0;
    if (imageBytes > MAX_QUESTION_IMAGE_BYTES)
      throw new AttachmentError(
        'Question images exceed 12 MB. Remove an image before sending.',
        413,
      );
    const segments: AttachmentSegment[] = [];
    for (let index = 0; index < attachment.segmentCount; index++) {
      const part = await storage.get<AttachmentSegment>(segmentKey(id, index));
      if (!part) throw new AttachmentError('Attachment snapshot is incomplete', 409);
      segments.push(part);
    }
    result.push({ attachment, segments });
  }
  return result;
}

export async function getQuestionAttachment(storage: Pick<AttachmentStore, 'get'>, id: string) {
  const value = await storage.get<StoredAttachment>(recordKey(id));
  if (!value) throw new AttachmentError('Attachment not found', 404);
  return questionAttachmentSchema.parse(value);
}
export async function attachmentImageData(files: Files, attachment: QuestionAttachment) {
  if (!attachment.image) return undefined;
  const bytes = await originalBytes(
    files,
    attachmentImageKey(attachment.id, attachment.image.id),
    MAX_ATTACHMENT_IMAGE_BYTES,
  );
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.buffer))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  if (digest !== attachment.image.digest)
    throw new AttachmentError('Attachment image integrity check failed', 409);
  let binary = '';
  for (let start = 0; start < bytes.length; start += 32768)
    binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
  return `data:${attachment.image.mime};base64,${btoa(binary)}`;
}
export async function attachmentSegmentPage(
  storage: Pick<AttachmentStore, 'get'>,
  attachment: QuestionAttachment,
  start: number,
) {
  if (!Number.isSafeInteger(start) || start < 0 || start >= attachment.segmentCount)
    throw new AttachmentError('Invalid attachment cursor');
  const end = Math.min(start + 20, attachment.segmentCount),
    items: AttachmentSegment[] = [];
  for (let index = start; index < end; index++) {
    const part = await storage.get<AttachmentSegment>(segmentKey(attachment.id, index));
    if (!part) throw new AttachmentError('Attachment snapshot is incomplete', 409);
    items.push(part);
  }
  return { items, nextCursor: end < attachment.segmentCount ? end : null };
}
