import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DraftWriteQueue, mergeNoteChanges, editableNote } from '../src/annotations/draftStore';
import {
  captureObjectBounds,
  moveCaptureObject,
  transformCaptureObject,
  captureEditorPlacement,
} from '../src/annotations/drawingGeometry';
import { annotationSnapshotSchema, plainDocument, type Annotation } from '../shared/annotations';
import { captureDrawingSchema } from '../shared/capture-drawing';
const id = () => crypto.randomUUID();
const note: Annotation = {
  id: id(),
  sessionId: id(),
  sourceId: null,
  sourceVersion: null,
  title: 'Reading notes',
  document: plainDocument('Original content'),
  location: {},
  strokes: [],
  references: [],
  origin: 'manual',
  revision: 1,
  text: 'Original content',
  deleted: false,
  createdAt: '2026-10-27T00:00:00Z',
  updatedAt: '2026-10-27T00:00:00Z',
};
test('draft write recovery retains failed assets and collapses only later metadata writes', async () => {
  let release!: () => void,
    fail = true;
  const gate = new Promise<void>((resolve) => (release = resolve)),
    records: unknown[] = [];
  const queue = new DraftWriteQueue(async (changes) => {
    await gate;
    if (fail) {
      fail = false;
      throw new Error('disk temporarily unavailable');
    }
    records.push(changes);
  });
  const first = queue
    .enqueue([{ table: 'images', key: 'base', value: 'immutable' }])
    .catch(() => {});
  const second = queue
    .enqueue([{ table: 'notes', key: 'owner', value: 'earlier' }], 'note')
    .catch(() => {});
  const third = queue
    .enqueue([{ table: 'notes', key: 'owner', value: 'latest' }], 'note')
    .catch(() => {});
  release();
  await Promise.all([first, second, third]);
  assert.equal(queue.idle, false);
  await queue.flush();
  assert.equal(queue.idle, true);
  assert.deepEqual(records, [
    [{ table: 'images', key: 'base', value: 'immutable' }],
    [{ table: 'notes', key: 'owner', value: 'latest' }],
  ]);
});
test('disjoint annotation edits merge while simultaneous fields and explicit empty capture selections require review', () => {
  const base = editableNote(note),
    local = { ...base, title: 'My title' },
    remote = { ...base, document: plainDocument('Another window') };
  const merge = mergeNoteChanges(base, local, remote);
  assert.deepEqual(merge.conflicts, []);
  assert.equal(merge.merged.title, 'My title');
  assert.deepEqual(merge.merged.document, remote.document);
  const concurrent = mergeNoteChanges(
    base,
    { ...local, captures: [] },
    {
      ...remote,
      title: 'Other title',
      captures: [{ id: id(), drawingDigest: 'a'.repeat(64), label: '' }],
    },
  );
  assert.deepEqual(concurrent.conflicts, ['title', 'captures']);
  assert.deepEqual(mergeNoteChanges(undefined, local, remote).conflicts, ['title', 'document']);
  assert.equal(annotationSnapshotSchema.parse(note).kind, 'annotation');
});
test('object movement and resize retain canonical positions and stay inside the source image', () => {
  const space = { width: 1600, height: 900 },
    object = {
      id: id(),
      kind: 'text' as const,
      point: { x: 0.2, y: 0.3 },
      text: 'A multiline\nnote',
      fontSize: 28,
      color: '#007f78',
      style: 'bubble' as const,
      tail: { x: 0.3, y: 0.5 },
    };
  const before = captureObjectBounds(object, space),
    moved = moveCaptureObject(object, { x: 10, y: -10 }, space);
  assert.ok(moved.kind === 'text');
  const bounds = captureObjectBounds(moved, space);
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1 + 1e-9);
  assert.ok(moved.tail!.x <= 1 && moved.tail!.y >= 0);
  const resized = transformCaptureObject(object, before, {
    ...before,
    width: before.width * 2,
    height: before.height * 2,
  });
  assert.ok(resized.kind === 'text');
  assert.equal(resized.fontSize, 56);
  const comment = {
    id: id(),
    kind: 'comment' as const,
    point: { x: 0.5, y: 0.5 },
    number: 1,
    text: 'Review',
    size: 40,
    color: '#007f78',
  };
  assert.equal(captureObjectBounds(comment, space).width, 80 / 1600);
  assert.doesNotThrow(() =>
    captureDrawingSchema.parse({ format: 1, space, objects: [comment, resized] }),
  );
});
test('anchored editors remain visible in every viewport quadrant and with an on-screen keyboard', () => {
  for (const viewport of [
    { x: 0, y: 0, width: 390, height: 844 },
    { x: 0, y: 215, width: 390, height: 300 },
    { x: 0, y: 0, width: 844, height: 390 },
  ])
    for (const x of [0, viewport.width])
      for (const y of [viewport.y, viewport.y + viewport.height]) {
        const place = captureEditorPlacement({ x, y }, { width: 320, height: 240 }, viewport);
        assert.ok(place.left >= viewport.x + 12);
        assert.ok(place.top >= viewport.y + 12);
        assert.ok(place.left + place.width <= viewport.x + viewport.width - 12 + 1e-9);
        assert.ok(place.top + place.maxHeight <= viewport.y + viewport.height - 12 + 1e-9);
      }
});
