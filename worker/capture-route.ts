import { z } from 'zod';
import { captureDescriptorSchema, captureDigest, type CaptureDescriptor } from '../shared/captures';
import { captureDrawingSchema } from '../shared/capture-drawing';
import type { Annotation } from '../shared/annotations';
import type { GlossaryStorage } from './glossary';
import { CaptureError } from './capture-store';
import { captureStore, boundedCaptureBytes } from './capture-runtime';
import { requireAnnotationContext, requireStampContext } from './annotations';

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
async function writable(storage: GlossaryStorage, descriptor: CaptureDescriptor) {
  const parent = await storage.get<Annotation>(`annotation:${descriptor.annotationId}`);
  if (parent?.deleted)
    throw new CaptureError('Restore the annotation before editing captures', 409);
  if (
    parent &&
    (parent.kind === 'bookmark' ||
      parent.sessionId !== descriptor.sessionId ||
      parent.sourceId !== descriptor.sourceId ||
      parent.sourceVersion !== descriptor.sourceVersion)
  )
    throw new CaptureError('Keep the original annotation source and session', 409);
  await requireAnnotationContext(storage, descriptor);
  if (descriptor.stamp) await requireStampContext(storage, descriptor.stamp);
}
async function strokeIdentity(captureId: string, index: number) {
  const digest = await captureDigest(`${captureId}:stroke:${index}`);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
/** Collection routes stage immutable assets; only the annotation PUT publishes their selection. */
export async function captureRoute(
  request: Request,
  env: Env,
  storage: GlossaryStorage,
  body: () => Promise<unknown>,
): Promise<Response | null> {
  const url = new URL(request.url),
    match = url.pathname.match(
      /^\/api\/annotations\/([a-f0-9-]+)\/captures\/([a-f0-9-]+)(?:\/(base|import|drawings|previews)(?:\/([a-f0-9]{64}))?)?$/,
    );
  if (!match) return null;
  const owner = z.string().uuid().parse(match[1]),
    id = z.string().uuid().parse(match[2]),
    part = match[3],
    digest = match[4],
    store = captureStore(env, storage);
  if (!part) {
    if (request.method === 'GET') return json(await store.record(owner, id));
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const descriptor = captureDescriptorSchema.parse(await body());
    if (descriptor.annotationId !== owner || descriptor.id !== id)
      throw new CaptureError('Capture identity does not match its URL');
    await writable(storage, descriptor);
    return json(await store.create(descriptor), 201);
  }
  if (part === 'import') {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const parent = await storage.get<Annotation>(`annotation:${owner}`);
    if (!parent?.capture || parent.capture.id !== id)
      throw new CaptureError('Original capture not found', 404);
    let record;
    try {
      record = await store.record(owner, id);
    } catch (error) {
      if (!(error instanceof CaptureError && error.status === 404)) throw error;
    }
    const descriptor: CaptureDescriptor = record?.descriptor || {
      annotationId: owner,
      id,
      sessionId: parent.sessionId,
      sourceId: parent.sourceId,
      sourceVersion: parent.sourceVersion,
      origin:
        parent.location.page !== undefined
          ? 'pdf_page'
          : parent.location.seconds !== undefined
            ? 'video_frame'
            : 'image',
      ...(parent.sourceId &&
      (parent.location.page !== undefined ||
        parent.location.seconds !== undefined ||
        parent.location.quote?.trim())
        ? {
            stamp: {
              id,
              sourceId: parent.sourceId,
              sourceVersion: parent.sourceVersion!,
              label: parent.title,
              location: parent.location,
            },
          }
        : {}),
    };
    await writable(storage, descriptor);
    await store.create(descriptor);
    const object = await env.FILES.get(`annotation/${owner}/${id}`);
    if (!object || object.size > 8 * 1024 * 1024)
      throw new CaptureError('Original capture image is unavailable', 404);
    const saved = await store.putBase(owner, id, new Uint8Array(await object.arrayBuffer()));
    const drawing = captureDrawingSchema.parse({
      format: 1,
      space: saved.base!.space,
      objects: await Promise.all(
        parent.strokes.map(async (stroke, index) => ({
          id: await strokeIdentity(id, index),
          kind: stroke.width >= 10 ? 'highlight' : 'pen',
          points: stroke.points,
          color: stroke.color,
          width: stroke.width,
        })),
      ),
    });
    const version = await store.putDrawing(
      owner,
      id,
      await captureDigest(JSON.stringify(drawing)),
      drawing,
    );
    return json({ record: saved, version: { ...version, label: parent.title } });
  }
  const record = await store.record(owner, id);
  if (part === 'base' && request.method === 'PUT' && !digest) {
    await writable(storage, record.descriptor);
    if (request.headers.get('Content-Type') !== 'image/png')
      throw new CaptureError('Capture base must be PNG', 415);
    const bytes = await boundedCaptureBytes(request.body, 8 * 1024 * 1024);
    return json(await store.putBase(owner, id, bytes));
  }
  if (part === 'drawings' && request.method === 'PUT' && digest) {
    await writable(storage, record.descriptor);
    return json(await store.putDrawing(owner, id, digest, await body()));
  }
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (part === 'drawings' && digest) return json(await store.drawing(owner, id, digest));
  let bytes: Uint8Array;
  if (part === 'base' && !digest) bytes = await store.base(owner, id);
  else if (part === 'previews' && digest) bytes = (await store.preview(owner, id, digest)).bytes;
  else return json({ error: 'Capture route not found' }, 404);
  return new Response(bytes, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(bytes.length),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    },
  });
}
