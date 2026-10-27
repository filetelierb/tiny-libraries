import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readDrafts,
  recordDraft,
  recoverPositions,
  settleDrafts,
} from '../src/workspace/positionDrafts';

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};
test('unsaved positions are recovered until the save that carries them succeeds', () => {
  const storage = memory();
  recordDraft('s1', 'a', 42, storage, 1);
  recordDraft('s1', 'b', 7, storage, 2);
  assert.deepEqual(recoverPositions('s1', { a: 10, c: 3 }, storage), { a: 42, b: 7, c: 3 });
  assert.equal(recoverPositions('s2', { a: 10 }, storage), null);
  settleDrafts('s1', { a: 42, b: 6 }, storage);
  assert.deepEqual(Object.keys(readDrafts('s1', storage)), ['b']);
  settleDrafts('s1', { b: 7 }, storage);
  assert.equal(recoverPositions('s1', { b: 7 }, storage), null);
});
