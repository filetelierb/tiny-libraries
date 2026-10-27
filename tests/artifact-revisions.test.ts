import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Learning } from '../shared/domain';
import {
  getRevision,
  latestArtifact,
  listRevisions,
  recordGenerated,
  saveEdit,
} from '../worker/artifact-revisions';
import { MemoryStore } from './storage';

const sourceId = '7d0c5b0e-4c55-4a8e-9a39-3a4c2f4f7b10';
const learning: Learning = {
  sourceId,
  sourceVersion: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  locale: 'en',
  model: 'test',
  segments: [
    { id: 'rate', text: 'A rate counts samples per second.' },
    { id: 'alias', text: 'Too few samples alias the signal.' },
  ],
  synthesis: {
    title: 'Sampling',
    artifact: {
      kind: 'signal',
      title: 'Aliasing at 12 Hz',
      explanation: 'An 8 Hz signal sampled at 12 Hz looks like 4 Hz.',
      segmentIds: ['alias'],
      frequency: 8,
      sampling: 12,
      amplitude: 0.8,
    },
    glossary: [],
    chapters: [],
  },
};
async function setup() {
  const memory = new MemoryStore();
  await memory.put(`learning:${sourceId}`, learning);
  return memory;
}
const edit = (expectedRevision: number, changes: Record<string, unknown> = {}) => ({
  expectedRevision,
  artifact: { ...learning.synthesis.artifact, title: 'My aliasing notes', ...changes },
});

test('an artifact prepared before revisions existed is its own first version', async () => {
  const memory = await setup();
  const list = await listRevisions(memory, sourceId);
  assert.deepEqual(
    list.map((item) => [item.revision, item.origin, item.title]),
    [[1, 'generated', 'Aliasing at 12 Hz']],
  );
  assert.equal((await latestArtifact(memory, learning))!.revision, 1);
});

test('saving an edit keeps every earlier version and becomes the latest', async () => {
  const memory = await setup();
  const saved = await saveEdit(memory.storage(), sourceId, edit(1));
  assert.equal(saved.revision, 2);
  assert.equal(saved.origin, 'edited');
  assert.deepEqual(
    (await listRevisions(memory, sourceId)).map((item) => [item.revision, item.title]),
    [
      [2, 'My aliasing notes'],
      [1, 'Aliasing at 12 Hz'],
    ],
  );
  assert.equal((await getRevision(memory, sourceId, 1)).artifact.title, 'Aliasing at 12 Hz');
  assert.equal((await latestArtifact(memory, learning))!.artifact.title, 'My aliasing notes');
});

test('edits are rejected when stale, retyped, uncited or reparameterized', async () => {
  const memory = await setup();
  await saveEdit(memory.storage(), sourceId, edit(1));
  await assert.rejects(saveEdit(memory.storage(), sourceId, edit(1)), { status: 409 });
  await assert.rejects(
    saveEdit(memory.storage(), sourceId, edit(2, { segmentIds: ['invented'] })),
    { status: 422 },
  );
  await assert.rejects(
    saveEdit(memory.storage(), sourceId, {
      expectedRevision: 2,
      artifact: {
        kind: 'comparison',
        title: 'x',
        explanation: 'y',
        segmentIds: ['rate'],
        rows: [{ label: 'a', left: 'b', right: 'c' }],
        leftTitle: 'L',
        rightTitle: 'R',
      },
    }),
    { status: 422 },
  );
  const saved = await saveEdit(memory.storage(), sourceId, edit(2, { frequency: 20 }));
  assert.equal(saved.artifact.kind === 'signal' && saved.artifact.frequency, 8);
});

test('a new preparation is appended after earlier edits', async () => {
  const memory = await setup();
  await saveEdit(memory.storage(), sourceId, edit(1));
  const prepared: Learning = {
    ...learning,
    sourceVersion: 2,
    synthesis: {
      ...learning.synthesis,
      artifact: { ...learning.synthesis.artifact!, title: 'Regenerated' },
    },
  };
  await memory.put(`learning:${sourceId}`, prepared);
  await recordGenerated(memory, prepared);
  const list = await listRevisions(memory, sourceId);
  assert.deepEqual(
    list.map((item) => [item.revision, item.origin, item.sourceVersion]),
    [
      [3, 'generated', 2],
      [2, 'edited', 1],
      [1, 'generated', 1],
    ],
  );
});
