import { api } from '../api';
import {
  captureDescriptorSchema,
  captureDigest,
  captureDrawingDigest,
  publishedCaptureSchema,
  type CaptureDescriptor,
  type PublishedCapture,
  type SourceStamp,
} from '../../shared/captures';
import { captureDrawingSchema, type CaptureDrawing } from '../../shared/capture-drawing';
import type { Annotation, SourceLocation } from '../../shared/annotations';
import type { Source } from '../../shared/domain';
import {
  DraftWriteQueue,
  editorDrafts,
  collectionDraftSchema,
  collectionKey,
  imageDraftKey,
  visualDraftKey,
  workingDraftKey,
  type CollectionDraft,
  type CaptureEntry,
} from './draftStore';
import { stageCapture, getCaptureDrawing, capturePath } from './captureClient';

export type CaptureWorkspaceContext = Pick<
  CaptureDescriptor,
  'annotationId' | 'sessionId' | 'sourceId' | 'sourceVersion'
>;
export function locationStamp(
  source: Pick<Source, 'id' | 'version' | 'name'> | null,
  location: SourceLocation,
): SourceStamp | undefined {
  if (
    !source ||
    !(location.page !== undefined || location.seconds !== undefined || location.quote?.trim())
  )
    return;
  return {
    id: crypto.randomUUID(),
    sourceId: source.id,
    sourceVersion: source.version,
    label: source.name,
    location,
  };
}
function descriptor(
  context: CaptureWorkspaceContext,
  origin: CaptureDescriptor['origin'],
  id: string,
  stamp?: SourceStamp,
) {
  return captureDescriptorSchema.parse({ ...context, id, origin, ...(stamp ? { stamp } : {}) });
}
export function entryForVersion(
  context: CaptureWorkspaceContext,
  version: PublishedCapture,
): CaptureEntry {
  return {
    descriptor: descriptor(context, version.origin, version.id, version.stamp),
    label: version.label,
    version,
    baseDigest: version.baseDigest,
  };
}

/** Browser draft state is independent of annotation publication and immutable server asset revisions. */
export class CaptureWorkspace {
  private listeners = new Set<() => void>();
  private queue = new DraftWriteQueue();
  private inFlight = new Map<string, Promise<PublishedCapture>>();
  private constructor(
    readonly context: CaptureWorkspaceContext,
    private value: CollectionDraft,
  ) {}
  static async load(
    context: CaptureWorkspaceContext,
    initial: Annotation | undefined,
    source: Source | null,
    location: SourceLocation,
  ) {
    const raw = await editorDrafts.get('collections', collectionKey(context.annotationId)),
      parsed = collectionDraftSchema.safeParse(raw);
    let value: CollectionDraft;
    if (raw !== undefined && !parsed.success)
      throw new Error(
        'This capture draft cannot be read by this version. Its local data has been kept.',
      );
    if (parsed.success) {
      value = parsed.data;
      if (
        value.ownerId !== context.annotationId ||
        value.items.some(
          (item) =>
            item.descriptor.sessionId !== context.sessionId ||
            item.descriptor.sourceId !== context.sourceId ||
            item.descriptor.sourceVersion !== context.sourceVersion,
        )
      )
        throw new Error('This capture draft belongs to another source version');
    } else {
      const stamp = locationStamp(
        source ? { ...source, version: context.sourceVersion || source.version } : null,
        initial?.location || location,
      );
      const items = initial?.captures?.map((item) => entryForVersion(context, item)) || [];
      if (initial?.captures === undefined && initial?.capture)
        items.push({
          descriptor: descriptor(
            context,
            stamp?.location.page !== undefined
              ? 'pdf_page'
              : stamp?.location.seconds !== undefined
                ? 'video_frame'
                : 'image',
            initial.capture.id,
            stamp,
          ),
          label: '',
          original: true,
        });
      value = {
        format: 1,
        ownerId: context.annotationId,
        stamp: crypto.randomUUID(),
        managed: initial?.captures !== undefined,
        stampsManaged: initial?.stamps !== undefined || (!initial && !!stamp),
        items,
        stamps: initial?.stamps || (stamp ? [stamp] : []),
      };
      await editorDrafts.commit([
        { table: 'collections', key: collectionKey(context.annotationId), value },
      ]);
    }
    return new CaptureWorkspace(context, value);
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(
    next: CollectionDraft,
    assets: Parameters<typeof editorDrafts.commit>[0] = [],
    semantic = true,
  ) {
    this.value = collectionDraftSchema.parse({
      ...next,
      ...(semantic ? { stamp: crypto.randomUUID() } : {}),
    });
    const pending = this.queue.enqueue(
      [
        ...assets,
        { table: 'collections', key: collectionKey(this.context.annotationId), value: this.value },
      ],
      assets.length ? undefined : 'collection',
    );
    for (const listener of this.listeners) listener();
    return pending;
  }
  flush = () => this.queue.flush();
  setLabel(id: string, label: string) {
    return this.update({
      ...this.value,
      managed: true,
      items: this.value.items.map((item) =>
        item.descriptor.id === id ? { ...item, label } : item,
      ),
    });
  }
  remove(id: string) {
    return this.update({
      ...this.value,
      managed: true,
      items: this.value.items.filter((item) => item.descriptor.id !== id),
    });
  }
  move(id: string, delta: number) {
    const items = [...this.value.items],
      index = items.findIndex((item) => item.descriptor.id === id),
      target = Math.max(0, Math.min(items.length - 1, index + delta));
    if (index < 0 || target === index) return Promise.resolve();
    const [item] = items.splice(index, 1);
    items.splice(target, 0, item);
    return this.update({ ...this.value, managed: true, items });
  }
  setStamps(stamps: SourceStamp[]) {
    return this.update({ ...this.value, stampsManaged: true, stamps });
  }
  async add(
    blob: Blob,
    origin: CaptureDescriptor['origin'],
    label: string,
    stamp?: SourceStamp,
    deduplicate = false,
  ) {
    const digest = await captureDigest(new Uint8Array(await blob.arrayBuffer()));
    if (
      deduplicate &&
      this.value.items.some(
        (item) => item.baseDigest === digest || item.version?.baseDigest === digest,
      )
    )
      return;
    if (this.value.items.length >= 12) throw new Error('A note can contain up to twelve captures');
    const id = crypto.randomUUID(),
      entry: CaptureEntry = {
        descriptor: descriptor(this.context, origin, id, stamp),
        label,
        baseDigest: digest,
        hasBlob: true,
      };
    await this.update({ ...this.value, managed: true, items: [...this.value.items, entry] }, [
      { table: 'images', key: imageDraftKey(this.context.annotationId, id), value: blob },
    ]);
    return id;
  }
  async applyDrawing(id: string, raw: CaptureDrawing) {
    const drawing = captureDrawingSchema.parse(raw),
      digest = await captureDrawingDigest(drawing);
    await this.update(
      {
        ...this.value,
        managed: true,
        items: this.value.items.map((item) =>
          item.descriptor.id === id ? { ...item, localDrawingDigest: digest } : item,
        ),
      },
      [
        {
          table: 'drawings',
          key: visualDraftKey(this.context.annotationId, id, digest),
          value: drawing,
        },
        { table: 'working', key: workingDraftKey(this.context.annotationId, id), remove: true },
      ],
    );
  }
  loadDrawing(id: string) {
    const entry = this.value.items.find((item) => item.descriptor.id === id);
    if (!entry) throw new Error('Capture is no longer selected');
    return getCaptureDrawing(this.context.annotationId, entry);
  }
  stageOne(id: string) {
    const target = this.value.items.find((item) => item.descriptor.id === id);
    if (!target) return Promise.reject(new Error('Capture is no longer selected'));
    const wanted = target.localDrawingDigest || target.version?.drawingDigest || 'base',
      key = `${id}:${wanted}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const work = (async () => {
      await this.flush();
      let version: PublishedCapture,
        entry = target;
      if (target.original && !target.version) {
        const imported = await api<{
          record: { descriptor: CaptureDescriptor };
          version: PublishedCapture;
        }>(`${capturePath(this.context.annotationId, id)}/import`, 'POST');
        version = publishedCaptureSchema.parse(imported.version);
        entry = {
          ...target,
          descriptor: captureDescriptorSchema.parse(imported.record.descriptor),
        };
        if (target.localDrawingDigest) version = await stageCapture({ ...entry, version });
      } else version = await stageCapture(target);
      const current = this.value.items.find((item) => item.descriptor.id === id);
      if (
        current &&
        (current.localDrawingDigest || current.version?.drawingDigest || 'base') === wanted
      ) {
        await this.update(
          {
            ...this.value,
            items: this.value.items.map((item) =>
              item.descriptor.id === id
                ? {
                    ...item,
                    descriptor: entry.descriptor,
                    version: { ...version, label: item.label },
                    baseDigest: version.baseDigest,
                  }
                : item,
            ),
          },
          [],
          false,
        );
      }
      return { ...version, label: current ? current.label : target.label };
    })();
    this.inFlight.set(key, work);
    void work
      .finally(() => {
        if (this.inFlight.get(key) === work) this.inFlight.delete(key);
      })
      .catch(() => {});
    return work;
  }
  async stageAll() {
    await this.flush();
    const ids = this.value.items.map((item) => item.descriptor.id);
    for (const id of ids) await this.stageOne(id);
    await this.flush();
    const current = this.value;
    return {
      stamp: current.stamp,
      managed: current.managed,
      stampsManaged: current.stampsManaged,
      stamps: current.stamps,
      versions: current.items.map((item) => {
        if (
          !item.version ||
          (item.localDrawingDigest && item.localDrawingDigest !== item.version.drawingDigest)
        )
          throw new Error('A drawing preview is not ready. Retry before saving.');
        return { ...item.version, label: item.label };
      }),
    };
  }
  replace(
    items: PublishedCapture[],
    managed: boolean,
    stamps: SourceStamp[],
    stampsManaged: boolean,
  ) {
    return this.update({
      ...this.value,
      managed,
      stampsManaged,
      stamps,
      items: items.map((item) => entryForVersion(this.context, item)),
    });
  }
}
