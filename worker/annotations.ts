import { requireCaptureOriginContext } from './capture-context';
import { z } from 'zod';
import {
  annotationInputSchema,
  annotationQuerySchema,
  readAnnotationQueryPage,
  annotationScopeKey,
  annotationSummary,
  migratedAnnotations,
  migratedBookmarks,
  stableAnnotationId,
  plainDocument,
  type SourceLocation,
  richText,
  type Annotation,
  type AnnotationSummary,
} from '../shared/annotations';
import { captureDigest, type SourceStamp } from '../shared/captures';
import { captureStore } from './capture-runtime';
import type { StudySession, Source, Directory } from '../shared/domain';
import { sourceState } from '../shared/directories';
import { deletePrefix, purgePrefix } from './purge';

export class AnnotationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export async function saveAnnotation(
  storage: Pick<import('./glossary').GlossaryStore, 'put'>,
  annotation: Annotation,
) {
  await storage.put(`annotation:${annotation.id}`, annotation);
  await storage.put(
    `annotation-summary:${annotation.sessionId}:${annotation.id}`,
    annotationSummary(annotation),
  );
  await storage.put(annotationScopeKey(annotation), annotationSummary(annotation));
}
/** Deletes an annotation for good: the record, its list entries, receipts and saved captures. */
export async function deleteAnnotation(
  env: Env,
  storage: DurableObjectStorage,
  existing: Annotation,
) {
  const id = existing.id;
  await storage.transaction(async (tx) => {
    await tx.delete([
      `annotation:${id}`,
      `annotation-summary:${existing.sessionId}:${id}`,
      annotationScopeKey(existing),
    ]);
    for (const prefix of [
      `annotation-receipt:${id}:`,
      `annotation-receipt-value:${id}:`,
      `capture-base:${id}:`,
      `capture-version:${id}:`,
    ])
      await deletePrefix(tx, prefix);
  });
  for (const prefix of [`annotation/${id}/`, `capture/${id}/`]) await purgePrefix(env, prefix);
}
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function requireAnnotationContext(
  storage: Pick<import('./glossary').GlossaryStore, 'get' | 'list'>,
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
async function receipt(
  storage: Pick<import('./glossary').GlossaryStore, 'get'>,
  id: string,
  mutationId: string,
  fingerprint: string,
) {
  const key = `annotation-receipt:${id}:${mutationId}`,
    saved = await storage.get<string>(key);
  if (!saved) return null;
  if (saved !== fingerprint)
    throw new AnnotationError('Annotation retry used different changes', 409);
  const value = await storage.get<Annotation>(`annotation-receipt-value:${id}:${mutationId}`);
  if (!value)
    throw new AnnotationError(
      'Saved annotation receipt is unavailable. Reload before making another change.',
      503,
    );
  return value;
}
export async function requireStampContext(
  storage: Pick<import('./glossary').GlossaryStore, 'get' | 'list'>,
  stamp: SourceStamp,
) {
  const file = await storage.get<Source>(`file:${stamp.sourceId}`);
  if (!file || file.version !== stamp.sourceVersion)
    throw new AnnotationError('A source location changed. Choose its current version again.', 409);
  if (stamp.location.page !== undefined && file.kind !== 'pdf')
    throw new AnnotationError('Choose a PDF page for this source location');
  if (stamp.location.seconds !== undefined && !['audio', 'video'].includes(file.kind))
    throw new AnnotationError('Choose an audio or video time for this source location');
  const directories = [...(await storage.list<Directory>({ prefix: 'directory:' })).values()];
  if (sourceState(file, directories) === 'trash')
    throw new AnnotationError('Restore the source before adding its location', 409);
}
async function importNotes(
  storage: import('./glossary').GlossaryStorage,
  sessionId: string,
  snapshot?: StudySession,
  sources?: Source[],
) {
  const session = snapshot || (await storage.get<StudySession>(`session:${sessionId}`));
  if (!session) throw new AnnotationError('Session not found', 404);
  const fingerprint = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify([session.notes, session.bookmarks])),
      ),
    ),
  ]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  const migrationKey = `annotation-note-import:${sessionId}`;
  if ((await storage.get(migrationKey)) === fingerprint) return;
  const files = sources || [...(await storage.list<Source>({ prefix: 'file:' })).values()];
  for (const annotation of [
    ...(await migratedAnnotations(session, files)),
    ...(await migratedBookmarks(session, files)),
  ])
    await storage.transaction(async (tx) => {
      const key = `annotation:${annotation.id}`;
      if (!(await tx.get(key))) await saveAnnotation(tx, annotation);
    });
  await storage.put(migrationKey, fingerprint);
}

export async function ensureSharedAnnotations(storage: import('./glossary').GlossaryStorage) {
  const sessions = await storage.list<StudySession>({ prefix: 'session:' });
  const files = [...(await storage.list<Source>({ prefix: 'file:' })).values()];
  for (const session of sessions.values()) await importNotes(storage, session.id, session, files);
  if (await storage.get('annotation-source-index:v1')) return;
  let after: string | undefined;
  for (;;) {
    const entries = await storage.list<AnnotationSummary>({
      prefix: 'annotation-summary:',
      limit: 100,
      ...(after ? { startAfter: after } : {}),
    });
    for (const summary of entries.values())
      await storage.transaction(async (tx) => {
        // Read the current revision inside the transaction so a concurrent edit wins.
        const value = await tx.get<Annotation>(`annotation:${summary.id}`);
        if (value) await tx.put(annotationScopeKey(value), annotationSummary(value));
      });
    if (entries.size < 100) break;
    after = [...entries.keys()].at(-1);
  }
  await storage.put('annotation-source-index:v1', true);
}
export async function annotationRoute(
  request: Request,
  env: Env,
  storage: DurableObjectStorage,
  body: () => Promise<unknown>,
): Promise<Response | null> {
  const url = new URL(request.url),
    list = url.pathname === '/api/annotations',
    query = url.pathname === '/api/annotations/query',
    match = url.pathname.match(/^\/api\/annotations\/([a-f0-9-]+)(\/capture)?$/);
  if (!list && !match && !query) return null;
  if (query) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const input = annotationQuerySchema.parse(await body());
    if (!(await storage.get(`session:${input.sessionId}`)))
      throw new AnnotationError('Session not found', 404);
    for (const sourceId of input.sourceIds)
      if (!(await storage.get(`file:${sourceId}`)))
        throw new AnnotationError('Source not found', 404);
    await ensureSharedAnnotations(storage);
    const result = await readAnnotationQueryPage(input, (options) =>
      storage.list<AnnotationSummary>(options),
    );
    if ('error' in result) throw new AnnotationError(result.error);
    return json(result);
  }
  if (list) {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const sessionId = z.string().uuid().parse(url.searchParams.get('sessionId'));
    await importNotes(storage, sessionId);
    const sourceId = url.searchParams.get('sourceId');
    const kind = z
      .enum(['annotation', 'bookmark'])
      .parse(url.searchParams.get('kind') || 'annotation');
    const entries = await storage.list<AnnotationSummary>({
      prefix: `annotation-summary:${sessionId}:`,
      limit: 100,
      ...(url.searchParams.get('after') ? { startAfter: url.searchParams.get('after')! } : {}),
    });
    const annotations = [...entries.values()].filter(
      (item) => (!sourceId || item.sourceId === sourceId) && (item.kind || 'annotation') === kind,
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
    if (existing.captures !== undefined)
      throw new AnnotationError('Use the capture collection to edit this annotation', 409);
    await requireAnnotationContext(storage, existing);
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
    const fingerprint = input.mutationId ? await captureDigest(JSON.stringify(input)) : null;
    if (input.mutationId && fingerprint) {
      const saved = await receipt(storage, id, input.mutationId, fingerprint);
      if (saved) return json(saved);
    }
    await requireAnnotationContext(storage, input);
    const resolvedCaptures =
      input.captures === undefined
        ? undefined
        : await captureStore(env, storage).resolve(id, input, input.captures);
    for (const capture of resolvedCaptures || [])
      await requireCaptureOriginContext(storage, capture);
    for (const stamp of [
      ...(input.stamps || []),
      ...(resolvedCaptures || []).flatMap((item) => (item.stamp ? [item.stamp] : [])),
    ])
      await requireStampContext(storage, stamp);
    for (const ref of input.references)
      if (!(await storage.get(`file:${ref}`)))
        throw new AnnotationError('Reference not found', 404);
    const value = await storage.transaction(async (tx) => {
      if (input.mutationId && fingerprint) {
        const saved = await receipt(tx, id, input.mutationId, fingerprint);
        if (saved) return saved;
      }
      const current = await tx.get<Annotation>(key);
      if (current?.deleted) throw new AnnotationError('Restore the annotation before editing', 409);
      if (
        !input.mutationId &&
        current?.revision === 1 &&
        input.expectedRevision === 0 &&
        JSON.stringify([
          current.kind || 'annotation',
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
            input.kind,
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
        ((current.kind || 'annotation') !== input.kind ||
          current.sourceId !== input.sourceId ||
          current.sessionId !== input.sessionId ||
          current.sourceVersion !== input.sourceVersion)
      )
        throw new AnnotationError('Keep the original annotation source and session');
      await requireAnnotationContext(tx, input);
      const {
        expectedRevision: _revision,
        mutationId: _mutation,
        captures: _captures,
        ...data
      } = input;
      const captures = resolvedCaptures ?? current?.captures,
        stamps = input.stamps ?? current?.stamps;
      for (const capture of captures || []) await requireCaptureOriginContext(tx, capture);
      for (const stamp of [
        ...(stamps || []),
        ...(captures || []).flatMap((item) => (item.stamp ? [item.stamp] : [])),
      ])
        await requireStampContext(tx, stamp);
      const references =
        input.captures !== undefined ||
        input.stamps !== undefined ||
        current?.captures !== undefined ||
        current?.stamps !== undefined
          ? [
              ...new Set([
                ...data.references,
                ...(stamps || []).map((item) => item.sourceId),
                ...(captures || []).flatMap((item) => (item.stamp ? [item.stamp.sourceId] : [])),
                ...(captures || []).flatMap((item) =>
                  item.originSource ? [item.originSource.id] : [],
                ),
              ]),
            ]
          : data.references;
      if (references.length > 20)
        throw new AnnotationError('Annotation references exceed 20 sources');
      for (const ref of references)
        if (!(await tx.get(`file:${ref}`))) throw new AnnotationError('Reference not found', 404);
      const next: Annotation = {
        ...data,
        references,
        ...(captures !== undefined ? { captures } : {}),
        ...(stamps !== undefined ? { stamps } : {}),
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
      if (input.mutationId && fingerprint) {
        await tx.put(`annotation-receipt:${id}:${input.mutationId}`, fingerprint);
        await tx.put(`annotation-receipt-value:${id}:${input.mutationId}`, next);
      }
      return next;
    });
    return json(value, existing ? 200 : 201);
  }
  if (request.method === 'DELETE') {
    if (!existing) throw new AnnotationError('Annotation not found', 404);
    await deleteAnnotation(env, storage, existing);
    return json({ deleted: true });
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

export async function createSuggestedBookmark(
  storage: DurableObjectStorage,
  input: {
    sessionId: string;
    sourceId: string;
    sourceVersion: number;
    label: string;
    location: SourceLocation;
    requestId: string;
    segmentId: string;
  },
) {
  const id = await stableAnnotationId(
    `bookmark:${input.requestId}:${input.sourceId}:${input.segmentId}`,
  );
  const data = annotationInputSchema.parse({
    id,
    kind: 'bookmark',
    sessionId: input.sessionId,
    sourceId: input.sourceId,
    sourceVersion: input.sourceVersion,
    title: input.label,
    document: plainDocument(input.label),
    location: input.location,
    strokes: [],
    origin: 'tutor',
    references: [input.sourceId],
    expectedRevision: 0,
  });
  await requireAnnotationContext(storage, data);
  return storage.transaction(async (tx) => {
    const existing = await tx.get<Annotation>(`annotation:${id}`);
    if (existing)
      return {
        id: existing.id,
        label: existing.title,
        location: existing.location,
        deleted: existing.deleted,
      };
    const {
      expectedRevision: _revision,
      mutationId: _mutation,
      captures: _captures,
      ...record
    } = data;
    const value: Annotation = {
      ...record,
      text: input.label,
      revision: 1,
      deleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveAnnotation(tx, value);
    return { id: value.id, label: value.title, location: value.location, deleted: false };
  });
}
