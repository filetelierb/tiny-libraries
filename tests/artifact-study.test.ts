import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Learning } from '../shared/domain';
import { artifactChapters, type ArtifactStudyPlan } from '../shared/artifact-study';
import {
  artifactQuestion,
  artifactStudySnapshot,
  startArtifactStudy,
} from '../worker/artifact-study';
import { saveEdit } from '../worker/artifact-revisions';
import { MemoryStore } from './storage';

const sourceId = '5b8f1f39-8a8e-4a45-9a51-0c1f6d1b8a01';
const explanation =
  'Intro.\n\n## Sampling\n\nCount samples.\n\n```widget\n## not a chapter\n```\n\n## Aliasing\n\nToo few samples alias.';
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
      title: 'Aliasing',
      explanation,
      segmentIds: ['alias'],
      frequency: 8,
      sampling: 12,
      amplitude: 0.8,
    },
    glossary: [],
    chapters: [],
  },
};
const question = (segmentId: string) => ({
  id: 'q',
  kind: 'single' as const,
  prompt: 'Which?',
  choices: ['a', 'b'],
  correctIndex: 1,
  expectedAnswer: null,
  rubric: null,
  explanation: 'Because.',
  concept: 'sampling',
  segmentIds: [segmentId],
});
const plan = (segmentId = 'rate'): ArtifactStudyPlan => ({
  chapters: [0, 1].map((index) => ({
    index,
    questions: [question(segmentId)],
    cards: [
      { front: 'F1', back: 'B1', segmentIds: ['rate'] },
      { front: 'F2', back: 'B2', segmentIds: ['alias'] },
    ],
  })),
});
async function setup() {
  const memory = new MemoryStore();
  await memory.put(`learning:${sourceId}`, learning);
  return memory;
}
async function generate(memory: MemoryStore, value: () => Promise<ArtifactStudyPlan>) {
  const tasks: Promise<unknown>[] = [];
  const snapshot = await startArtifactStudy(memory.storage(), sourceId, {
    owner: 'test',
    start: (task) => tasks.push(task),
    generate: value,
  });
  await Promise.all(tasks);
  return snapshot;
}

test('artifact chapters are its ## headings outside code and widget blocks', () => {
  assert.deepEqual(
    artifactChapters(explanation).map((chapter) => [chapter.index, chapter.title]),
    [
      [0, 'Sampling'],
      [1, 'Aliasing'],
    ],
  );
  assert.deepEqual(artifactChapters('No headings at all.'), []);
});

test('chapter quizzes and cards are generated for the latest version without answers', async () => {
  const memory = await setup();
  assert.equal((await artifactStudySnapshot(memory, sourceId)).status, 'pending');
  // An instant fake generator may already have finished when the request returns.
  assert.ok(['generating', 'ready'].includes((await generate(memory, async () => plan())).status));
  const ready = await artifactStudySnapshot(memory, sourceId);
  assert.equal(ready.status, 'ready');
  if (ready.status !== 'ready') return;
  assert.deepEqual(
    ready.chapters.map((chapter) => [chapter.id, chapter.title, chapter.cards.length]),
    [
      ['artifact-v1-ch1', 'Sampling', 2],
      ['artifact-v1-ch2', 'Aliasing', 2],
    ],
  );
  assert.equal('correctIndex' in ready.chapters[0].questions[0], false);
  const found = await artifactQuestion(memory, sourceId, {
    chapterId: 'artifact-v1-ch2',
    questionId: 'artifact-v1-ch2-q1',
    learningVersion: ready.version,
  });
  assert.equal(found?.question.correctIndex, 1);
  assert.equal(found?.learning.createdAt, ready.version);
});

test('uncited plans fail visibly and a new version needs new questions', async () => {
  const memory = await setup();
  await generate(memory, async () => plan('invented'));
  const failed = await artifactStudySnapshot(memory, sourceId);
  assert.equal(failed.status, 'failed');
  await generate(memory, async () => plan());
  assert.equal((await artifactStudySnapshot(memory, sourceId)).status, 'ready');
  await saveEdit(memory.storage(), sourceId, {
    expectedRevision: 1,
    artifact: { ...learning.synthesis.artifact, title: 'Edited' },
  });
  assert.deepEqual(await artifactStudySnapshot(memory, sourceId), {
    status: 'pending',
    revision: 2,
  });
  assert.equal(
    await artifactQuestion(memory, sourceId, {
      chapterId: 'artifact-v1-ch1',
      questionId: 'artifact-v1-ch1-q1',
    }),
    null,
  );
});
