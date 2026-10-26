import { z } from 'zod';
import {
  annotationInputSchema,
  annotationSummary,
  migratedAnnotations,
  richText,
  type Annotation,
  type AnnotationSummary,
} from '../shared/annotations';
import type { StudySession, Source, Directory } from '../shared/domain';
import { sourceState } from '../shared/directories';

export class AnnotationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
async function saveAnnotation(storage: Pick<DurableObjectStorage, 'put'>, annotation: Annotation) {
  await storage.put(`annotation:${annotation.id}`, annotation);
  await storage.put(
    `annotation-summary:${annotation.sessionId}:${annotation.id}`,
    annotationSummary(annotation),
  );
}
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
async function requireContext(
  storage: DurableObjectStorage,
  value: { sessionId: string; sourceId: string | null; sourceVersion: number | null },
) {
  if (!(await storage.get(`session:${value.sessionId}`)))
    throw new AnnotationError('Session not found', 404);
  if (!value.sourceId) {
    if (value.sourceVersion !== null) throw new AnnotationError('Unexpected source version');
    return;
  }
  const source = await storage.get<Source>(`file:${value.sourceId}`);
  if (!source || source.version !== value.sourceVersion)
    throw new AnnotationError('Source changed or is unavailable', 409);
  const directories = [...(await storage.list<Directory>({ prefix: 'directory:' })).values()];
  if (sourceState(source, directories) === 'trash')
    throw new AnnotationError('Restore the source before editing its annotations', 409);
}
async function importNotes(storage: DurableObjectStorage, sessionId: string) {
  const session = await storage.get<StudySession>(`session:${sessionId}`);
  if (!session) throw new AnnotationError('Session not found', 404);
  const files = [...(await storage.list<Source>({ prefix: 'file:' })).values()];
  for (const annotation of await migratedAnnotations(session, files))
    await storage.transaction(async (tx) => {
      const key = `annotation:${annotation.id}`;
      if (!(await tx.get(key))) await saveAnnotation(tx, annotation);
    });
}
export async function annotationRoute(
  request: Request,
  env: Env,
  storage: DurableObjectStorage,
  body: () => Promise<unknown>,
): Promise<Response | null> {
  const url = new URL(request.url),
    list = url.pathname === '/api/annotations',
    match = url.pathname.match(/^\/api\/annotations\/([a-f0-9-]+)(\/capture)?$/);
  if (!list && !match) return null;
  if (list) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const sessionId = z.string().uuid().parse(url.searchParams.get('sessionId'));
    await importNotes(storage, sessionId);
    const sourceId = url.searchParams.get('sourceId');
    const entries = await storage.list<AnnotationSummary>({
      prefix: `annotation-summary:${sessionId}:`,
      limit: 100,
      ...(url.searchParams.get('after') ? { startAfter: url.searchParams.get('after')! } : {}),
    });
    const annotations = [...entries.values()].filter(
      (item) => !sourceId || item.sourceId === sourceId,
    );
    return json({
      items: annotations,
      nextCursor: entries.size === 100 ? [...entries.keys()].at(-1) : null,
    });
  }
  const id = z.string().uuid().parse(match![1]),
    key = `annotation:${id}`,
    existing = await storage.get<Annotation>(key);
  if (match![2]) {
    if (!existing) throw new AnnotationError('Annotation not found', 404);
    if (request.method === 'GET') {
      if (!existing.capture) throw new AnnotationError('Capture not found', 404);
      const object = await env.FILES.get(`annotation/${id}/${existing.capture.id}`);
      if (!object) throw new AnnotationError('Capture not found', 404);
      return new Response(object.body, {
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    await requireContext(storage, existing);
    const expectedRevision = z.coerce
        .number()
        .int()
        .positive()
        .parse(url.searchParams.get('revision')),
      width = z.coerce.number().int().min(1).max(4096).parse(url.searchParams.get('width')),
      height = z.coerce.number().int().min(1).max(4096).parse(url.searchParams.get('height'));
    if (request.headers.get('Content-Type') !== 'image/png' || !request.body)
      throw new AnnotationError('Capture must be PNG');
    const reader = request.body.getReader(),
      parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new AnnotationError('Capture exceeds 8 MB', 413);
      }
      parts.push(value);
    }
    const data = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      data.set(part, offset);
      offset += part.length;
    }
    if (
      size < 24 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => data[index] === byte)
    )
      throw new AnnotationError('Invalid PNG capture');
    const png = new DataView(data.buffer);
    if (png.getUint32(16) !== width || png.getUint32(20) !== height)
      throw new AnnotationError('Capture dimensions do not match PNG');
    const operationId = z.string().uuid().parse(url.searchParams.get('operationId'));
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
      .map((value) => value.toString(16).padStart(2, '0'))
      .join('');
    if (existing.capture?.operationId === operationId) {
      if (existing.capture.digest !== digest)
        throw new AnnotationError('Capture retry used different image data', 409);
      return json(existing);
    }
    const captureId = crypto.randomUUID(),
      objectKey = `annotation/${id}/${captureId}`;
    await env.FILES.put(objectKey, data, { httpMetadata: { contentType: 'image/png' } });
    try {
      const updated = await storage.transaction(async (tx) => {
        const current = await tx.get<Annotation>(key);
        if (current?.capture?.operationId === operationId) {
          if (current.capture.digest !== digest)
            throw new AnnotationError('Capture retry used different image data', 409);
          return { value: current, published: false };
        }
        if (current?.deleted)
          throw new AnnotationError('Restore the annotation before editing', 409);
        if (!current || current.revision !== expectedRevision)
          throw new AnnotationError(
            'This annotation changed in another window. Reopen it before saving.',
            409,
          );
        const value: Annotation = {
          ...current,
          capture: { id: captureId, width, height, size, operationId, digest },
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        await saveAnnotation(tx, value);
        return { value, published: true };
      });
      if (!updated.published) await env.FILES.delete(objectKey);
      return json(updated.value);
    } catch (error) {
      await env.FILES.delete(objectKey);
      throw error;
    }
  }
  if (request.method === 'GET') {
    if (!existing) throw new AnnotationError('Annotation not found', 404);
    return json(existing);
  }
  if (request.method === 'PUT') {
    const input = annotationInputSchema.parse(await body());
    if (input.id !== id) throw new AnnotationError('Annotation identity mismatch');
    await requireContext(storage, input);
    for (const ref of input.references)
      if (!(await storage.get(`file:${ref}`)))
        throw new AnnotationError('Reference not found', 404);
    const value = await storage.transaction(async (tx) => {
      const current = await tx.get<Annotation>(key);
      if (current?.deleted) throw new AnnotationError('Restore the annotation before editing', 409);
      if (
        current?.revision === 1 &&
        input.expectedRevision === 0 &&
        JSON.stringify([
          current.sessionId,
          current.sourceId,
          current.sourceVersion,
          current.title,
          current.document,
          current.location,
          current.strokes,
          current.origin,
          current.references,
        ]) ===
          JSON.stringify([
            input.sessionId,
            input.sourceId,
            input.sourceVersion,
            input.title,
            input.document,
            input.location,
            input.strokes,
            input.origin,
            input.references,
          ])
      )
        return current;
      if ((current?.revision || 0) !== input.expectedRevision)
        throw new AnnotationError(
          'This annotation changed in another window. Reopen it before saving.',
          409,
        );
      if (
        current &&
        (current.sourceId !== input.sourceId ||
          current.sessionId !== input.sessionId ||
          current.sourceVersion !== input.sourceVersion)
      )
        throw new AnnotationError('Keep the original annotation source and session');
      const { expectedRevision: _revision, ...data } = input;
      const next: Annotation = {
        ...data,
        text: richText(data.document),
        revision: (current?.revision || 0) + 1,
        deleted: current?.deleted || false,
        createdAt: current?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(current?.capture ? { capture: current.capture } : {}),
      };
      if (new TextEncoder().encode(JSON.stringify(next)).length > 120000)
        throw new AnnotationError('Annotation is too large; split it into separate notes', 413);
      await saveAnnotation(tx, next);
      return next;
    });
    return json(value, existing ? 200 : 201);
  }
  if (request.method === 'PATCH') {
    const input = z
      .object({ deleted: z.boolean(), expectedRevision: z.number().int().positive() })
      .parse(await body());
    const value = await storage.transaction(async (tx) => {
      const current = await tx.get<Annotation>(key);
      if (!current) throw new AnnotationError('Annotation not found', 404);
      if (current.revision !== input.expectedRevision)
        throw new AnnotationError(
          'This annotation changed in another window. Reopen it before saving.',
          409,
        );
      const next = {
        ...current,
        deleted: input.deleted,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await saveAnnotation(tx, next);
      return next;
    });
    return json(value);
  }
  return json({ error: 'Method not allowed' }, 405);
}
