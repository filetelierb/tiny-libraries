import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PARALLEL_CALLS, runAtOnce } from '../shared/parallel';
import { translateStep, translationKey } from '../worker/translate-stage';
import type { Segment } from '../shared/domain';

const pause = () => new Promise((resolve) => setTimeout(resolve, 2));

test('runAtOnce stays within its limit and reaches every item', async () => {
  let running = 0,
    busiest = 0;
  const seen: number[] = [];
  await runAtOnce([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
    busiest = Math.max(busiest, ++running);
    await pause();
    seen.push(item);
    running--;
  });
  assert.equal(busiest, 3);
  assert.deepEqual(
    seen.sort((a, b) => a - b),
    [1, 2, 3, 4, 5, 6, 7],
  );
});

test('runAtOnce lets calls in flight finish, starts no more and throws the first error', async () => {
  const finished: number[] = [];
  await assert.rejects(
    runAtOnce([1, 2, 3, 4], 2, async (item) => {
      if (item === 1) throw new Error('first');
      await pause();
      finished.push(item);
    }),
    /first/,
  );
  assert.deepEqual(finished, [2]);
});

const segmentsOf = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => ({ id: `s${index}`, text: `text ${index}` }) as unknown as Segment,
  );
function memory() {
  const saved = new Map<string, Segment[]>();
  return {
    saved,
    get: async (key: string) => saved.get(key),
    put: async (key: string, value: Segment[]) => void saved.set(key, value),
  };
}
const upper = async (batch: Segment[]) => ({
  translated: batch.map((segment) => ({ ...segment, text: segment.text.toUpperCase() })),
});

test('translation takes several batches per step and keeps the source order', async () => {
  const segments = segmentsOf(80 * (PARALLEL_CALLS + 2) - 1),
    store = memory(),
    progress: number[] = [];
  let running = 0,
    busiest = 0;
  const translate = async (batch: Segment[]) => {
    busiest = Math.max(busiest, ++running);
    await pause();
    running--;
    return upper(batch);
  };
  const onBatch = async (completed: number) => void progress.push(completed);
  assert.equal(await translateStep(segments, store, translate, onBatch), null);
  assert.equal(busiest, PARALLEL_CALLS);
  assert.equal(store.saved.size, PARALLEL_CALLS);
  const finished = await translateStep(segments, store, translate, onBatch);
  assert.deepEqual(
    finished?.map((segment) => segment.id),
    segments.map((segment) => segment.id),
  );
  assert.equal(finished?.[0].text, 'TEXT 0');
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7]);
});

test('a failed translation step repeats only the batches that are missing', async () => {
  const segments = segmentsOf(240),
    store = memory(),
    asked: string[] = [];
  const failing = async (batch: Segment[]) => {
    asked.push(batch[0].id);
    if (batch[0].id === 's80') throw new Error('rate limit');
    return upper(batch);
  };
  await assert.rejects(
    translateStep(segments, store, failing, async () => {}),
    /rate limit/,
  );
  assert.deepEqual([...store.saved.keys()].sort(), [translationKey(0), translationKey(160)].sort());
  asked.length = 0;
  const finished = await translateStep(
    segments,
    store,
    async (batch) => {
      asked.push(batch[0].id);
      return upper(batch);
    },
    async () => {},
  );
  assert.deepEqual(asked, ['s80']);
  assert.equal(finished?.length, 240);
});

test('a source with nothing to translate finishes at once', async () => {
  assert.deepEqual(await translateStep([], memory(), upper, async () => {}), []);
});
