import { z } from 'zod';
import {
  captureDescriptorSchema,
  captureDigest,
  captureDigestSchema,
  captureSelectionsSchema,
  publishedCaptureSchema,
  type CaptureDescriptor,
  type CaptureSelection,
  type PublishedCapture,
} from '../shared/captures';
import {
  captureDrawingSchema,
  capturePixelCrop,
  captureSpaceSchema,
  emptyCaptureDrawing,
  type CaptureDrawing,
  type CaptureSpace,
} from '../shared/capture-drawing';
import type { GlossaryStorage } from './glossary';

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export type CaptureObjects = {
  read(key: string): Promise<Uint8Array | null>;
  write(key: string, data: Uint8Array): Promise<void>;
};
export type CaptureRenderer = (
  base: Uint8Array,
  drawing: CaptureDrawing,
) => Promise<{ bytes: Uint8Array; width: number; height: number }>;
const baseSchema = z.object({
  digest: captureDigestSchema,
  size: z
    .number()
    .int()
    .positive()
    .max(8 * 1024 * 1024),
  space: captureSpaceSchema,
  emptyDrawingDigest: captureDigestSchema,
});
const recordSchema = z.object({
  format: z.literal(1),
  descriptor: captureDescriptorSchema,
  fingerprint: captureDigestSchema,
  createdAt: z.string(),
  base: baseSchema.optional(),
});
export type CaptureRecord = z.infer<typeof recordSchema>;
const identity = z.string().uuid();
export function captureBaseKey(owner: string, id: string, digest: string) {
  return `capture/${identity.parse(owner)}/${identity.parse(id)}/base/${captureDigestSchema.parse(digest)}`;
}
const drawingKey = (owner: string, id: string, digest: string) =>
  `capture/${owner}/${id}/drawing/${digest}`;
const previewKey = (owner: string, id: string, digest: string) =>
  `capture/${owner}/${id}/preview/${digest}`;
const recordKey = (owner: string, id: string) => `capture-base:${owner}:${id}`;
const versionKey = (owner: string, id: string, digest: string) =>
  `capture-version:${owner}:${id}:${digest}`;
function pngSpace(data: Uint8Array, maximum: number): CaptureSpace {
  if (
    data.length < 33 ||
    data.length > maximum ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => data[i] === v)
  )
    throw new CaptureError('Capture must be a bounded PNG image', 413);
  const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return captureSpaceSchema.parse({ width: header.getUint32(16), height: header.getUint32(20) });
}
/** Binary assets and visual documents are staged before the parent publishes a selection. */
export class CaptureStore {
  constructor(
    private readonly storage: GlossaryStorage,
    private readonly objects: CaptureObjects,
    private readonly render: CaptureRenderer,
  ) {}
  async create(raw: CaptureDescriptor): Promise<CaptureRecord> {
    const descriptor = captureDescriptorSchema.parse(raw),
      fingerprint = await captureDigest(JSON.stringify(descriptor));
    return this.storage.transaction(async (tx) => {
      const key = recordKey(descriptor.annotationId, descriptor.id),
        existing = await tx.get<CaptureRecord>(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint)
          throw new CaptureError(
            'Capture identity already belongs to different source context',
            409,
          );
        return recordSchema.parse(existing);
      }
      const value: CaptureRecord = {
        format: 1,
        descriptor,
        fingerprint,
        createdAt: new Date().toISOString(),
      };
      await tx.put(key, value);
      return value;
    });
  }
  async record(owner: string, id: string) {
    identity.parse(owner);
    identity.parse(id);
    const value = await this.storage.get<CaptureRecord>(recordKey(owner, id));
    if (!value) throw new CaptureError('Capture draft not found', 404);
    return recordSchema.parse(value);
  }
  private async read(key: string, digest: string, maximum: number) {
    const value = await this.objects.read(key);
    if (!value || value.length > maximum || (await captureDigest(value)) !== digest)
      throw new CaptureError(
        'Capture data is unavailable or changed; the saved note has not been replaced',
        503,
      );
    return value;
  }
  async base(owner: string, id: string) {
    const record = await this.record(owner, id);
    if (!record.base) throw new CaptureError('Capture base has not been uploaded', 409);
    return this.read(
      captureBaseKey(owner, id, record.base.digest),
      record.base.digest,
      8 * 1024 * 1024,
    );
  }
  private async stageVersion(
    record: CaptureRecord,
    base: { digest: string; space: CaptureSpace },
    bytes: Uint8Array,
    drawing: CaptureDrawing,
  ) {
    const { annotationId: owner, id } = record.descriptor,
      serialized = JSON.stringify(drawing),
      drawingDigest = await captureDigest(serialized);
    const existing = await this.storage.get<PublishedCapture>(versionKey(owner, id, drawingDigest));
    if (existing) return publishedCaptureSchema.parse(existing);
    const image = await this.render(bytes, drawing),
      actual = pngSpace(image.bytes, 3 * 1024 * 1024),
      crop = capturePixelCrop(drawing.space, drawing.crop),
      scale = Math.min(1, 1600 / Math.max(crop.width, crop.height));
    if (
      image.width !== actual.width ||
      image.height !== actual.height ||
      image.width !== Math.max(1, Math.round(crop.width * scale)) ||
      image.height !== Math.max(1, Math.round(crop.height * scale))
    )
      throw new CaptureError('Capture renderer returned incompatible dimensions', 502);
    const previewDigest = await captureDigest(image.bytes);
    const version = publishedCaptureSchema.parse({
      id,
      label: '',
      baseDigest: base.digest,
      drawingDigest,
      previewDigest,
      space: base.space,
      width: image.width,
      height: image.height,
      size: image.bytes.length,
      origin: record.descriptor.origin,
      ...(record.descriptor.stamp ? { stamp: record.descriptor.stamp } : {}),
    });
    await this.objects.write(
      drawingKey(owner, id, drawingDigest),
      new TextEncoder().encode(serialized),
    );
    await this.objects.write(previewKey(owner, id, previewDigest), image.bytes);
    return version;
  }
  async putBase(owner: string, id: string, bytes: Uint8Array) {
    const record = await this.record(owner, id),
      space = pngSpace(bytes, 8 * 1024 * 1024),
      digest = await captureDigest(bytes);
    if (record.base) {
      if (record.base.digest !== digest)
        throw new CaptureError(
          'This capture already has a different immutable image; create another capture',
          409,
        );
      return record;
    }
    const drawing = emptyCaptureDrawing(space),
      version = await this.stageVersion(record, { digest, space }, bytes, drawing);
    await this.objects.write(captureBaseKey(owner, id, digest), bytes);
    return this.storage.transaction(async (tx) => {
      const current = await tx.get<CaptureRecord>(recordKey(owner, id));
      if (!current) throw new CaptureError('Capture draft is unavailable', 503);
      if (current.base) {
        if (current.base.digest !== digest)
          throw new CaptureError('A different image was already saved for this capture', 409);
        return current;
      }
      const next: CaptureRecord = {
        ...current,
        base: { digest, size: bytes.length, space, emptyDrawingDigest: version.drawingDigest },
      };
      await tx.put(versionKey(owner, id, version.drawingDigest), version);
      await tx.put(recordKey(owner, id), next);
      return next;
    });
  }
  async putDrawing(owner: string, id: string, expectedDigest: string, raw: unknown) {
    captureDigestSchema.parse(expectedDigest);
    const record = await this.record(owner, id);
    if (!record.base) throw new CaptureError('Upload the capture base first', 409);
    const drawing = captureDrawingSchema.parse(raw),
      digest = await captureDigest(JSON.stringify(drawing));
    if (digest !== expectedDigest)
      throw new CaptureError('Drawing identity does not match its content', 409);
    if (JSON.stringify(drawing.space) !== JSON.stringify(record.base.space))
      throw new CaptureError('Drawing belongs to a different image size', 409);
    const previous = await this.storage.get<PublishedCapture>(versionKey(owner, id, digest));
    if (previous) return publishedCaptureSchema.parse(previous);
    const version = await this.stageVersion(
      record,
      record.base,
      await this.base(owner, id),
      drawing,
    );
    return this.storage.transaction(async (tx) => {
      const existing = await tx.get<PublishedCapture>(versionKey(owner, id, digest));
      if (existing) return publishedCaptureSchema.parse(existing);
      await tx.put(versionKey(owner, id, digest), version);
      return version;
    });
  }
  async version(owner: string, id: string, digest: string) {
    await this.record(owner, id);
    captureDigestSchema.parse(digest);
    const value = await this.storage.get<PublishedCapture>(versionKey(owner, id, digest));
    if (!value) throw new CaptureError('Rendered capture revision is not ready', 404);
    return publishedCaptureSchema.parse(value);
  }
  async drawing(owner: string, id: string, digest: string) {
    const version = await this.version(owner, id, digest),
      data = await this.read(drawingKey(owner, id, digest), version.drawingDigest, 256 * 1024);
    return captureDrawingSchema.parse(JSON.parse(new TextDecoder().decode(data)));
  }
  async preview(owner: string, id: string, digest: string) {
    const version = await this.version(owner, id, digest);
    return {
      version,
      bytes: await this.read(
        previewKey(owner, id, version.previewDigest),
        version.previewDigest,
        3 * 1024 * 1024,
      ),
    };
  }
  async resolve(
    owner: string,
    context: Pick<CaptureDescriptor, 'sessionId' | 'sourceId' | 'sourceVersion'>,
    raw: CaptureSelection[],
  ) {
    const selections = captureSelectionsSchema.parse(raw),
      resolved: PublishedCapture[] = [];
    for (const selection of selections) {
      const record = await this.record(owner, selection.id);
      if (
        record.descriptor.sessionId !== context.sessionId ||
        record.descriptor.sourceId !== context.sourceId ||
        record.descriptor.sourceVersion !== context.sourceVersion
      )
        throw new CaptureError('Capture source context does not match its annotation', 409);
      const version = await this.version(owner, selection.id, selection.drawingDigest);
      await this.base(owner, selection.id);
      await this.drawing(owner, selection.id, selection.drawingDigest);
      await this.preview(owner, selection.id, selection.drawingDigest);
      resolved.push({ ...version, label: selection.label });
    }
    return resolved;
  }
}
