import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { CaptureStore, CaptureError, type CaptureObjects } from '../worker/capture-store';
import {
  captureDigest,
  captureDrawingDigest,
  captureSelectionsSchema,
  sourceStampsSchema,
  type CaptureDescriptor,
} from '../shared/captures';
import { emptyCaptureDrawing, type CaptureDrawing } from '../shared/capture-drawing';
import { annotationInputSchema, plainDocument } from '../shared/annotations';
import { renderCapture } from '../server/capture-render';
import { startBridge } from '../server/bridge';
import { MemoryStore } from './storage';

const id = () => crypto.randomUUID();
const sourceId = id(),
  sessionId = id();
function image(color = '#ffffff') {
  const c = createCanvas(64, 48),
    ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, c.width, c.height);
  return c.toBuffer('image/png');
}
class Objects implements CaptureObjects {
  data = new Map<string, Uint8Array>();
  failWrite = 0;
  async read(key: string) {
    return this.data.get(key)?.slice() || null;
  }
  async write(key: string, data: Uint8Array) {
    if (this.failWrite && --this.failWrite === 0) throw new Error('Synthetic storage interruption');
    this.data.set(key, data.slice());
  }
}
class SmallMetadata extends MemoryStore {
  override async put(key: string, value: unknown) {
    assert.ok(
      JSON.stringify(value).length < 10000,
      'Drawing payload leaked into small metadata storage',
    );
    await super.put(key, value);
  }
}
async function fixture() {
  const storage = new SmallMetadata(),
    objects = new Objects();
  let renders = 0;
  const store = new CaptureStore(storage, objects, async (bytes, drawing) => {
    renders++;
    return renderCapture(bytes, drawing);
  });
  const descriptor: CaptureDescriptor = {
    annotationId: id(),
    id: id(),
    sourceId,
    sourceVersion: 1,
    sessionId,
    origin: 'pdf_page',
    stamp: { id: id(), sourceId, sourceVersion: 1, label: 'Page two', location: { page: 2 } },
  };
  await store.create(descriptor);
  return { store, storage, objects, descriptor, renders: () => renders };
}
async function stage(f: Awaited<ReturnType<typeof fixture>>) {
  return f.store.putBase(f.descriptor.annotationId, f.descriptor.id, image());
}
test('capture identity freezes image bytes and source context, while exact retries do not recompose', async () => {
  const f = await fixture(),
    first = await stage(f);
  assert.deepEqual(
    await f.store.create(f.descriptor),
    await f.store.record(f.descriptor.annotationId, f.descriptor.id),
  );
  assert.deepEqual(await stage(f), first);
  assert.equal(f.renders(), 1);
  await assert.rejects(
    f.store.create({ ...f.descriptor, sourceVersion: 2 }),
    (e) => e instanceof CaptureError && e.status === 409,
  );
  await assert.rejects(
    f.store.putBase(f.descriptor.annotationId, f.descriptor.id, image('#202f36')),
    /different immutable image/,
  );
  assert.deepEqual(await f.store.base(f.descriptor.annotationId, f.descriptor.id), image());
  assert.equal(first.base?.space.width, 64);
});
test('interrupted asset staging never publishes half a capture and resumes using the same identity', async () => {
  const f = await fixture();
  f.objects.failWrite = 2;
  await assert.rejects(stage(f), /Synthetic storage interruption/);
  assert.equal((await f.store.record(f.descriptor.annotationId, f.descriptor.id)).base, undefined);
  const saved = await stage(f);
  assert.ok(saved.base);
  const version = await f.store.version(
    f.descriptor.annotationId,
    f.descriptor.id,
    saved.base.emptyDrawingDigest,
  );
  assert.equal(
    (await f.store.preview(f.descriptor.annotationId, f.descriptor.id, version.drawingDigest)).bytes
      .length,
    version.size,
  );
});
test('drawing revisions retain older previews, keep large documents outside metadata and replay concurrently', async () => {
  const f = await fixture(),
    base = await stage(f),
    owner = f.descriptor.annotationId,
    cid = f.descriptor.id;
  const initial = await f.store.preview(owner, cid, base.base!.emptyDrawingDigest);
  const drawing: CaptureDrawing = {
    ...emptyCaptureDrawing(base.base!.space),
    objects: [
      {
        id: id(),
        kind: 'pen',
        width: 3,
        color: '#007f76',
        points: Array.from({ length: 1500 }, (_, i) => ({ x: i / 1500, y: 0.5 })),
      },
    ],
  };
  const digest = await captureDrawingDigest(drawing);
  const [a, b] = await Promise.all([
    f.store.putDrawing(owner, cid, digest, drawing),
    f.store.putDrawing(owner, cid, digest, drawing),
  ]);
  assert.deepEqual(a, b);
  assert.deepEqual(await f.store.drawing(owner, cid, digest), drawing);
  assert.deepEqual(
    (await f.store.preview(owner, cid, base.base!.emptyDrawingDigest)).bytes,
    initial.bytes,
  );
  assert.notDeepEqual((await f.store.preview(owner, cid, digest)).bytes, initial.bytes);
  const before = f.renders();
  assert.deepEqual(await f.store.putDrawing(owner, cid, digest, drawing), a);
  assert.equal(f.renders(), before);
  await assert.rejects(f.store.putDrawing(owner, cid, '0'.repeat(64), drawing), /identity/);
});
test('capture selections preserve stable order and labels, reject foreign context and require all assets', async () => {
  const f = await fixture(),
    saved = await stage(f),
    owner = f.descriptor.annotationId,
    cid = f.descriptor.id;
  const second = { ...f.descriptor, id: id() };
  await f.store.create(second);
  const secondBase = await f.store.putBase(owner, second.id, image('#007f76'));
  const choices = [
    { id: second.id, drawingDigest: secondBase.base!.emptyDrawingDigest, label: 'Second first' },
    { id: cid, drawingDigest: saved.base!.emptyDrawingDigest, label: 'Original second' },
  ];
  const selected = await f.store.resolve(owner, f.descriptor, choices);
  assert.deepEqual(
    selected.map((x) => x.id),
    [second.id, cid],
  );
  assert.equal(selected[0].label, 'Second first');
  await assert.rejects(
    f.store.resolve(owner, { ...f.descriptor, sessionId: id() }, choices),
    /source context/,
  );
  assert.equal(captureSelectionsSchema.safeParse([...choices, choices[0]]).success, false);
  assert.equal(
    captureSelectionsSchema.safeParse(
      Array.from({ length: 13 }, () => ({ ...choices[0], id: id() })),
    ).success,
    false,
  );
  const preview = [...f.objects.data.keys()].find((key) => key.includes(`/${cid}/preview/`))!;
  f.objects.data.delete(preview);
  await assert.rejects(f.store.resolve(owner, f.descriptor, choices), /unavailable or changed/);
});
test('source locations deduplicate by resource version and page/time, independent of labels', () => {
  const first = {
    id: id(),
    sourceId,
    sourceVersion: 1,
    label: 'First',
    location: { page: 2, quote: 'A quote' },
  };
  assert.equal(
    sourceStampsSchema.safeParse([
      first,
      { ...first, id: id(), label: 'Another label', location: { page: 2 } },
    ]).success,
    false,
  );
  assert.equal(
    sourceStampsSchema.safeParse([first, { ...first, id: id(), sourceVersion: 2 }]).success,
    true,
  );
  assert.equal(sourceStampsSchema.safeParse([{ ...first, location: {} }]).success, false);
  assert.equal(
    sourceStampsSchema.safeParse([{ ...first, location: { page: 2, seconds: 4 } }]).success,
    false,
  );
  assert.equal(
    sourceStampsSchema.safeParse([{ ...first, location: { seconds: 0 } }]).success,
    true,
  );
});
test('collection publication requires a stable mutation identity while older note inputs keep their exact shape', () => {
  const input = {
    id: id(),
    sessionId,
    sourceId,
    sourceVersion: 1,
    title: 'A note',
    document: plainDocument('Text'),
    location: { page: 2 },
    strokes: [],
    origin: 'manual',
    references: [sourceId],
    expectedRevision: 0,
  };
  const old = annotationInputSchema.parse(input);
  assert.deepEqual(old, { ...input, kind: 'annotation' });
  assert.equal('captures' in old, false);
  assert.equal('stamps' in old, false);
  assert.equal(annotationInputSchema.safeParse({ ...input, captures: [] }).success, false);
  assert.equal(
    annotationInputSchema.safeParse({ ...input, captures: [], stamps: [], mutationId: id() })
      .success,
    true,
  );
});
test('authenticated local composition returns the selected cropped image and rejects untrusted bridge callers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'capture-bridge-')),
    bridge = await startBridge('capture-test-token', root, 0);
  t.after(async () => {
    await bridge.shutdownTutor();
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });
  const port = (bridge.address() as AddressInfo).port,
    url = `http://127.0.0.1:${port}/render-capture`;
  const drawing = {
    ...emptyCaptureDrawing({ width: 64, height: 48 }),
    crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
  };
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  const response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer capture-test-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: image().toString('base64'), drawing }),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Capture-Width'), '32');
  assert.equal(response.headers.get('X-Capture-Height'), '24');
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.ok((await response.arrayBuffer()).byteLength > 33);
});

test('immutable capture revisions retain a separately identified image origin without requiring a page stamp', async () => {
  const f = await fixture(),
    originSource = { id: id(), version: 2, name: 'Study image.png' },
    descriptor = {
      ...f.descriptor,
      id: id(),
      origin: 'image' as const,
      stamp: undefined,
      originSource,
    };
  await f.store.create(descriptor);
  const record = await f.store.putBase(descriptor.annotationId, descriptor.id, image());
  const version = await f.store.version(
    descriptor.annotationId,
    descriptor.id,
    record.base!.emptyDrawingDigest,
  );
  assert.deepEqual(version.originSource, originSource);
  assert.equal(version.stamp, undefined);
  await assert.rejects(
    () => f.store.create({ ...descriptor, originSource: { ...originSource, version: 3 } }),
    CaptureError,
  );
});
