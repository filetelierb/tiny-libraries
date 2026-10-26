import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Learning, PublicLearning, Attempt } from '../shared/domain';
import { publicLearning } from '../shared/domain';
import {
  chapterLocations,
  completedChapter,
  crossedChapter,
  currentChapter,
  chapterRuns,
} from '../shared/chapters';
import { recordAttempt } from '../worker/practice';
import { MemoryStore } from './storage';

const sourceId = '31c90f6e-93ee-4018-87ab-03964476cb22';
const learning: Learning = {
  sourceId,
  sourceVersion: 1,
  createdAt: 'revision-one',
  locale: 'en',
  model: 'test',
  segments: [
    { id: 'first', text: 'An interval is time between samples.', start: 0, end: 5, page: 1 },
    { id: 'second', text: 'A rate counts samples per second.', start: 5, end: 10, page: 2 },
  ],
  synthesis: {
    title: 'Sampling',
    glossary: [],
    artifact: null,
    chapters: [
      {
        id: 'interval',
        title: 'Intervals',
        summary: 'Time between measurements.',
        segmentIds: ['first'],
        questions: [
          {
            id: 'q1',
            kind: 'single',
            prompt: 'What is an interval?',
            choices: ['Elapsed time', 'A count'],
            correctIndex: 0,
            expectedAnswer: null,
            rubric: null,
            explanation: 'It is elapsed time.',
            concept: 'Interval',
            segmentIds: ['first'],
          },
          {
            id: 'q2',
            kind: 'short',
            prompt: 'Explain the time interval.',
            choices: [],
            correctIndex: null,
            expectedAnswer: 'Elapsed time between samples.',
            rubric: 'Mentions elapsed time and samples.',
            explanation: 'Time between samples.',
            concept: 'Interval',
            segmentIds: ['first'],
          },
        ],
      },
      {
        id: 'rate',
        title: 'Rate',
        summary: 'Measurements per second.',
        segmentIds: ['second'],
        questions: [
          {
            id: 'q3',
            kind: 'single',
            prompt: 'What is rate?',
            choices: ['A count per second', 'A colour'],
            correctIndex: 0,
            expectedAnswer: null,
            rubric: null,
            explanation: 'Count per second.',
            concept: 'Rate',
            segmentIds: ['second'],
          },
        ],
      },
    ],
  },
};
const material: PublicLearning = publicLearning(learning);
const base = {
  sourceId,
  sourceVersion: 1,
  learningVersion: learning.createdAt,
  chapterId: 'interval',
  runId: crypto.randomUUID(),
};
async function fixture() {
  const store = new MemoryStore();
  await store.put(`file:${sourceId}`, {
    id: sourceId,
    version: 1,
    folder: 'Examples',
    archived: false,
    trashed: false,
  });
  await store.put(`learning:${sourceId}`, learning);
  return store;
}
const grade = async () => ({
  status: 'correct' as const,
  explanation: 'Elapsed time is correctly described.',
});

test('chapter locators resolve time, page and text independently and keep current ranges bounded', () => {
  const media = chapterLocations(material, 'audio');
  assert.deepEqual(
    media.map((r) => [r.start, r.end]),
    [
      [0, 5],
      [5, 10],
    ],
  );
  assert.equal(currentChapter(media, 5)?.chapter.id, 'rate');
  assert.equal(currentChapter(media, 10)?.chapter.id, 'rate');
  assert.equal(currentChapter(media, NaN), null);
  const pages = chapterLocations(material, 'pdf');
  assert.equal(currentChapter(pages, 1)?.chapter.id, 'interval');
  assert.equal(currentChapter(pages, 2)?.chapter.id, 'rate');
  assert.deepEqual(
    chapterLocations(material, 'markdown').map((r) => [r.start, r.end]),
    [
      [0, 0],
      [1, 1],
    ],
  );
});
test('checkpoints ignore restoration, explicit seeks, reverse travel, completed chapters and repeated boundaries', () => {
  const ranges = chapterLocations(material, 'audio'),
    empty = new Set<string>();
  for (const cause of ['restore', 'seek'] as const)
    assert.equal(crossedChapter(ranges, 0, { value: 6, cause }, empty, empty), null);
  assert.equal(
    crossedChapter(ranges, 4, { value: 5, cause: 'read' }, empty, empty)?.chapter.id,
    'interval',
  );
  assert.equal(crossedChapter(ranges, 5, { value: 4, cause: 'read' }, empty, empty), null);
  assert.equal(
    crossedChapter(ranges, 4, { value: 5, cause: 'read' }, new Set(['interval']), empty),
    null,
  );
  assert.equal(
    crossedChapter(ranges, 4, { value: 5, cause: 'read' }, empty, new Set(['interval'])),
    null,
  );
  assert.equal(crossedChapter(ranges, 9, { value: 10, cause: 'read' }, empty, empty), null);
  assert.equal(
    crossedChapter(chapterLocations(material, 'pdf'), 1, { value: 2, cause: 'read' }, empty, empty)
      ?.chapter.id,
    'interval',
  );
});
test('chapter completion uses one complete run of the same source and learning version', async () => {
  const store = await fixture(),
    chapter = material.synthesis.chapters[0];
  const first = await recordAttempt(
    store.storage(),
    { ...base, questionId: 'q1', selected: 0, requestId: crypto.randomUUID() },
    'process',
    grade,
  );
  assert.equal(completedChapter([first], material, chapter), false);
  const second = await recordAttempt(
    store.storage(),
    {
      ...base,
      questionId: 'q2',
      answer: 'Elapsed time between samples.',
      requestId: crypto.randomUUID(),
    },
    'process',
    grade,
  );
  assert.equal(completedChapter([first, second], material, chapter), true);
  assert.equal(
    completedChapter([first, { ...second, runId: crypto.randomUUID() }], material, chapter),
    false,
  );
  assert.equal(
    completedChapter([first, second], { ...material, createdAt: 'another-revision' }, chapter),
    false,
  );
  assert.equal('correctIndex' in first.question!, false);
  assert.equal('rubric' in first.question!, false);
  assert.equal('explanation' in first.question!, false);
});
test('quiz history keeps repeat runs distinct and counts each question once within a run', async () => {
  const store = await fixture(),
    chapter = material.synthesis.chapters[0];
  const a = await recordAttempt(
    store.storage(),
    { ...base, questionId: 'q1', selected: 0, requestId: crypto.randomUUID() },
    'process',
    grade,
  );
  const b = await recordAttempt(
    store.storage(),
    { ...base, questionId: 'q2', answer: 'Elapsed time.', requestId: crypto.randomUUID() },
    'process',
    grade,
  );
  const secondId = crypto.randomUUID();
  const second = [
    {
      ...a,
      id: crypto.randomUUID(),
      runId: secondId,
      correct: false,
      createdAt: '2026-10-27T00:00:01Z',
    },
    { ...b, id: crypto.randomUUID(), runId: secondId, createdAt: '2026-10-27T00:00:02Z' },
  ];
  const duplicate = { ...second[0], id: crypto.randomUUID(), createdAt: '2026-10-27T00:00:00Z' };
  const runs = chapterRuns([a, b, ...second, duplicate], material, chapter);
  assert.equal(runs.length, 2);
  assert.ok(runs.every((r) => r.complete && r.attempts.length === 2));
  assert.equal(runs.find((r) => r.id === a.runId)!.attempts.filter((a) => a.correct).length, 2);
  assert.equal(runs.find((r) => r.id === secondId)!.attempts.filter((a) => a.correct).length, 1);
});

test('answer retries return the saved result and cannot reuse its identity for changed payloads', async () => {
  const store = await fixture(),
    input = { ...base, questionId: 'q2', answer: 'Elapsed time.', requestId: crypto.randomUUID() };
  let calls = 0;
  const check = async () => {
    calls++;
    return grade();
  };
  const result = await recordAttempt(store.storage(), input, 'process', check);
  assert.deepEqual(await recordAttempt(store.storage(), input, 'process', check), result);
  assert.equal(calls, 1);
  await assert.rejects(
    recordAttempt(store.storage(), { ...input, answer: 'Something else.' }, 'process', check),
    /different answer/,
  );
  await assert.rejects(
    recordAttempt(
      store.storage(),
      { ...input, requestId: crypto.randomUUID(), learningVersion: 'outdated' },
      'process',
      check,
    ),
    /material changed/,
  );
  await assert.rejects(
    recordAttempt(
      store.storage(),
      { ...input, requestId: crypto.randomUUID(), chapterId: 'rate' },
      'process',
      check,
    ),
    /Question not found/,
  );
  assert.equal(calls, 1);
});
test('a running answer has one grading owner and stale source edits cannot publish its result', async () => {
  const store = await fixture(),
    input = { ...base, questionId: 'q2', answer: 'Elapsed time.', requestId: crypto.randomUUID() };
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    begun = new Promise<void>((r) => {
      started = r;
    });
  const running = recordAttempt(store.storage(), input, 'process', async () => {
    started();
    await gate;
    return grade();
  });
  await begun;
  await assert.rejects(
    recordAttempt(store.storage(), input, 'process', grade),
    /still being checked/,
  );
  await store.put(`learning:${sourceId}`, { ...learning, createdAt: 'replaced' });
  release();
  await assert.rejects(running, /material changed/);
  assert.equal(await store.get(`attempt:${input.requestId}`), undefined);
  assert.equal(await store.get(`attempt-claim:${input.requestId}`), undefined);
});
