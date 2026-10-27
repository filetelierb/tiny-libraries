import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureTime,
  captureContentUrl,
  sourceLocationStamp,
  formatCaptureTime,
} from '../shared/capture-source';
import { sourceStampsSchema, stampIdentity } from '../shared/captures';
import { requireCaptureOriginContext } from '../worker/capture-context';
import { MemoryStore } from './storage';
const source = { id: crypto.randomUUID(), version: 3, name: 'Sampling recording' };
test('frame choices preserve zero and precision, stay before the end, and reject indeterminate recordings', () => {
  assert.equal(captureTime(0, 8, true), 0);
  assert.equal(captureTime(2.3456, 8, true), 2.346);
  assert.equal(captureTime(99, 8, true), 7.999);
  assert.equal(captureTime(8, 8), 8);
  assert.equal(captureTime(-1, 8, true), 0);
  assert.equal(captureTime(999999, 999999, true), 86400);
  for (const [value, duration] of [
    [NaN, 8],
    [1, Infinity],
    [1, 0],
    [1, -1],
  ])
    assert.throws(() => captureTime(value, duration, true));
  assert.ok(captureTime(3.5, 3.123456, true) < 3.123456);
});
test('source locations retain independent resource versions and zero, with one hundred unique locators', () => {
  const start = sourceLocationStamp(source, { seconds: 0 }),
    again = sourceLocationStamp(source, { seconds: 0 }),
    newVersion = sourceLocationStamp({ ...source, version: 4 }, { seconds: 0 });
  assert.equal(start.location.seconds, 0);
  assert.notEqual(start.id, again.id);
  assert.equal(stampIdentity(start), stampIdentity(again));
  assert.notEqual(stampIdentity(start), stampIdentity(newVersion));
  const stamps = Array.from({ length: 100 }, (_, seconds) =>
    sourceLocationStamp(source, { seconds }),
  );
  assert.equal(sourceStampsSchema.parse(stamps).length, 100);
  assert.equal(
    sourceStampsSchema.safeParse([...stamps, sourceLocationStamp(source, { seconds: 100 })])
      .success,
    false,
  );
  assert.equal(sourceStampsSchema.safeParse([start, again]).success, false);
  assert.throws(() => sourceLocationStamp(source, {}));
  assert.throws(() => sourceLocationStamp(source, { page: 1, seconds: 0 }));
  assert.equal(captureContentUrl(source), `/api/files/${source.id}/content?version=3`);
});

test('capture labels distinguish fractional frame locations without dropping zero or hour boundaries', () => {
  assert.equal(formatCaptureTime(0), '0:00');
  assert.equal(formatCaptureTime(2.345), '0:02.345');
  assert.equal(formatCaptureTime(59.9996), '1:00');
  assert.equal(formatCaptureTime(3602.5), '1:00:02.500');
});

test('captured image origins validate their independent resource version, availability and location ownership', async () => {
  const storage = new MemoryStore(),
    image = { ...source, kind: 'image', folder: '', trashed: false, archived: false };
  await storage.put(`file:${source.id}`, image);
  const capture = { origin: 'image' as const, originSource: source };
  await requireCaptureOriginContext(storage, capture);
  await assert.rejects(() =>
    requireCaptureOriginContext(storage, { ...capture, originSource: { ...source, version: 4 } }),
  );
  await assert.rejects(() =>
    requireCaptureOriginContext(storage, { ...capture, origin: 'pdf_page' }),
  );
  await assert.rejects(() =>
    requireCaptureOriginContext(storage, {
      ...capture,
      stamp: sourceLocationStamp({ ...source, id: crypto.randomUUID() }, { quote: 'A label' }),
    }),
  );
  await storage.put(`file:${source.id}`, { ...image, trashed: true });
  await assert.rejects(() => requireCaptureOriginContext(storage, capture));
  await requireCaptureOriginContext(storage, { origin: 'image' });
});
