import { z } from 'zod';
import {
  annotationSnapshotSchema,
  annotationInputSchema,
  richDocumentSchema,
  drawingSchema,
  locationSchema,
  type Annotation,
  type AnnotationInput,
} from '../../shared/annotations';
import {
  captureDescriptorSchema,
  publishedCaptureSchema,
  sourceStampsSchema,
  captureDigestSchema,
  type PublishedCapture,
} from '../../shared/captures';

const contextSchema = z.object({
  sessionId: z.string().uuid(),
  sourceId: z.string().uuid().nullable(),
  sourceVersion: z.number().int().positive().nullable(),
});
export const noteDraftSchema = z
  .object({
    format: z.literal(1),
    ownerId: z.string().uuid(),
    context: contextSchema,
    stamp: z.string().uuid(),
    title: z.string().max(240),
    document: richDocumentSchema,
    markdown: z.string().max(120000),
    sourceMode: z.boolean(),
    strokes: drawingSchema,
    location: locationSchema.optional(),
    references: z.array(z.string().uuid()).max(20).optional(),
    base: annotationSnapshotSchema.optional(),
    unverified: z.boolean().optional(),
    migratedDrafts: z
      .array(z.object({ key: z.string().max(1000), value: z.string().max(1024 * 1024) }))
      .max(2)
      .optional(),
    pending: z
      .object({
        input: annotationInputSchema,
        noteStamp: z.string().uuid(),
        collectionStamp: z.string().uuid(),
      })
      .optional(),
  })
  .refine(
    (value) => !value.pending || value.pending.input.id === value.ownerId,
    'Saved changes belong to another note',
  );
export type NoteDraft = z.infer<typeof noteDraftSchema>;
export const captureEntrySchema = z.object({
  descriptor: captureDescriptorSchema,
  label: z.string().max(240),
  version: publishedCaptureSchema.optional(),
  baseDigest: captureDigestSchema.optional(),
  localDrawingDigest: captureDigestSchema.optional(),
  hasBlob: z.boolean().optional(),
  original: z.boolean().optional(),
});
export type CaptureEntry = z.infer<typeof captureEntrySchema>;
export const collectionDraftSchema = z
  .object({
    format: z.literal(1),
    ownerId: z.string().uuid(),
    stamp: z.string().uuid(),
    managed: z.boolean(),
    stampsManaged: z.boolean(),
    items: z.array(captureEntrySchema).max(12),
    stamps: sourceStampsSchema,
  })
  .refine(
    (value) =>
      new Set(value.items.map((item) => item.descriptor.id)).size === value.items.length &&
      value.items.every((item) => item.descriptor.annotationId === value.ownerId),
    'Capture draft identities do not match',
  );
export type CollectionDraft = z.infer<typeof collectionDraftSchema>;
export const draftTables = ['notes', 'collections', 'images', 'drawings', 'working'] as const;
export type DraftTable = (typeof draftTables)[number];
export type DraftChange = { table: DraftTable; key: string; value?: unknown; remove?: boolean };
let database: Promise<IDBDatabase> | undefined, lane: string | undefined;
export function browserDraftLane() {
  if (lane) return lane;
  try {
    lane = sessionStorage.getItem('tl:annotation-draft-lane') || crypto.randomUUID();
    sessionStorage.setItem('tl:annotation-draft-lane', lane);
  } catch {
    lane = 'default';
  }
  return lane;
}
export const collectionKey = (owner: string) => `${owner}:${browserDraftLane()}`;
export const imageDraftKey = (owner: string, id: string) => `${owner}:${id}`;
export const visualDraftKey = (owner: string, id: string, digest: string) =>
  `${owner}:${id}:${digest}`;
export const workingDraftKey = (owner: string, id: string) =>
  `${owner}:${id}:${browserDraftLane()}`;
function open() {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('tailored-library-editor', 1);
    request.onupgradeneeded = () => {
      for (const name of draftTables)
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      database = undefined;
      reject(request.error || new Error('Local draft storage is unavailable'));
    };
    request.onblocked = () => {
      database = undefined;
      reject(new Error('Close older editor windows to finish opening local drafts'));
    };
  });
  return database;
}
function durableTransaction(db: IDBDatabase, names: DraftTable[]) {
  try {
    return db.transaction(names, 'readwrite', { durability: 'strict' });
  } catch (error) {
    if (
      !(error instanceof TypeError) &&
      !(error instanceof DOMException && error.name === 'NotSupportedError')
    )
      throw error;
    return db.transaction(names, 'readwrite');
  }
}
export const editorDrafts = {
  async get<T>(table: DraftTable, key: string): Promise<T | undefined> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(table, 'readonly').objectStore(table).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async commit(
    changes: Array<{ table: DraftTable; key: string; value?: unknown; remove?: boolean }>,
  ) {
    if (!changes.length) return;
    const db = await open(),
      names = [...new Set(changes.map((x) => x.table))];
    const tx = durableTransaction(db, names);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('Local draft could not be saved'));
      tx.onerror = () => reject(tx.error);
      for (const change of changes) {
        const store = tx.objectStore(change.table);
        if (change.remove) store.delete(change.key);
        else store.put(change.value, change.key);
      }
    });
  },
  async acknowledge(
    key: string,
    owner: string,
    pending: NonNullable<NoteDraft['pending']>,
    saved: Annotation,
  ) {
    const db = await open();
    return new Promise<boolean>((resolve, reject) => {
      const tx = durableTransaction(db, ['notes', 'collections']),
        notes = tx.objectStore('notes'),
        collections = tx.objectStore('collections');
      let cleared = false;
      const req = notes.get(key);
      req.onerror = () => tx.abort();
      req.onsuccess = () => {
        const parsed = noteDraftSchema.safeParse(req.result);
        if (!parsed.success) return;
        const current = parsed.data;
        if (current.pending?.input.mutationId !== pending.input.mutationId) return;
        const captures = collections.get(collectionKey(owner));
        captures.onerror = () => tx.abort();
        captures.onsuccess = () => {
          const collection = collectionDraftSchema.safeParse(captures.result);
          if (
            current.stamp === pending.noteStamp &&
            collection.success &&
            collection.data.stamp === pending.collectionStamp
          ) {
            notes.delete(key);
            collections.delete(collectionKey(owner));
            cleared = true;
          } else
            notes.put(
              {
                ...current,
                base: annotationSnapshotSchema.parse(saved),
                pending: undefined,
                unverified: undefined,
              },
              key,
            );
        };
      };
      tx.oncomplete = () => resolve(cleared);
      tx.onabort = () =>
        reject(tx.error || new Error('Saved changes could not be acknowledged locally'));
      tx.onerror = () => reject(tx.error);
    });
  },
};

/** Failed writes stay queued; adjacent metadata updates can collapse without dropping asset writes. */
export class DraftWriteQueue {
  private tasks: Array<{ changes: DraftChange[]; key?: string }> = [];
  private running?: Promise<void>;
  constructor(
    private readonly write: (changes: DraftChange[]) => Promise<void> = editorDrafts.commit,
  ) {}
  get idle() {
    return !this.running && !this.tasks.length;
  }
  enqueue(changes: DraftChange[], key?: string) {
    const last = this.tasks.at(-1),
      protectedFirst = this.tasks.length === 1 && !!this.running;
    if (key && last?.key === key && !protectedFirst) last.changes = changes;
    else this.tasks.push({ changes, key });
    return this.flush();
  }
  async flush() {
    while (this.tasks.length || this.running) {
      if (!this.running) {
        const task = this.tasks[0];
        this.running = (async () => {
          await this.write(task.changes);
          this.tasks.shift();
        })().finally(() => {
          this.running = undefined;
        });
      }
      await this.running;
    }
  }
}

export const noteEditFields = [
  'title',
  'document',
  'location',
  'strokes',
  'references',
  'captures',
  'stamps',
] as const;
export type NoteEditField = (typeof noteEditFields)[number];
export type NoteEdit = Pick<AnnotationInput, NoteEditField>;
const select = (item: PublishedCapture) => ({
  id: item.id,
  drawingDigest: item.drawingDigest,
  label: item.label,
});
export function editableNote(note: Annotation): NoteEdit {
  return {
    title: note.title,
    document: note.document,
    location: note.location,
    strokes: note.strokes,
    references: note.references,
    ...(note.captures !== undefined ? { captures: note.captures.map(select) } : {}),
    ...(note.stamps !== undefined ? { stamps: note.stamps } : {}),
  };
}
/** Merge disjoint fields; any field changed differently on both sides requires an explicit choice. */
export function mergeNoteChanges(base: NoteEdit | undefined, local: NoteEdit, remote: NoteEdit) {
  const merged = { ...local },
    conflicts: NoteEditField[] = [];
  for (const key of noteEditFields) {
    const ours = JSON.stringify(local[key]),
      theirs = JSON.stringify(remote[key]),
      before = base ? JSON.stringify(base[key]) : undefined;
    if (ours === theirs) continue;
    if (base && ours === before) Object.assign(merged, { [key]: remote[key] });
    else if (!base || theirs !== before) conflicts.push(key);
  }
  return { merged, conflicts };
}
