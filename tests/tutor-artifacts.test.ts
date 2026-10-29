import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Learning, Source } from '../shared/domain';
import {
  artifactMaterials,
  assembleArtifact,
  chapterIssues,
  materialIds,
  type ArtifactPlan,
  type TutorArtifactJob,
} from '../shared/tutor-artifacts';
import {
  resumeTutorArtifact,
  startTutorArtifact,
  tutorArtifactStatus,
  type TutorArtifactServices,
} from '../worker/tutor-artifacts';
import { MemoryStore } from './storage';

const learning = (sourceId: string, count: number, size = 100) =>
  ({
    sourceId,
    sourceVersion: 1,
    createdAt: '2026-10-29T00:00:00.000Z',
    segments: Array.from({ length: count }, (_, index) => ({
      id: `s${index + 1}`,
      text: `${'x'.repeat(size - 4)} ${index + 1}`.slice(-size),
      page: index + 1,
    })),
    synthesis: { chapters: [{ title: 'Sampling', summary: 'How sampling works.' }] },
  }) as unknown as Learning;
const prose = 'Sampling turns a continuous signal into numbers. '.repeat(10);
const plan: ArtifactPlan = {
  title: 'Sampling guide',
  guidingQuestion: 'Why does sampling need a minimum rate?',
  introduction: 'An introduction.',
  chapters: [
    {
      title: 'Rate',
      objective: 'Explain the rate.',
      keyIdeas: ['Nyquist'],
      widgets: [],
      segmentIds: [],
    },
    {
      title: 'Aliasing',
      objective: 'Explain aliasing.',
      keyIdeas: ['Folding'],
      widgets: [],
      segmentIds: [],
    },
  ],
};

test('materials spread passages across each file within the budget and alias their ids', () => {
  const a = crypto.randomUUID(),
    b = crypto.randomUUID();
  const materials = artifactMaterials(
    [
      { learning: learning(a, 400, 200), name: 'Lecture.pdf' },
      { learning: learning(b, 3), name: 'Notes.md' },
    ],
    20000,
  );
  assert.deepEqual(
    materials.map((material) => material.alias),
    ['r1', 'r2'],
  );
  const size = materials[0].segments.reduce((sum, segment) => sum + segment.text.length, 0);
  assert.ok(size <= 10200, `first file stays near its share (${size})`);
  // Passages come from the whole file, not only its beginning.
  assert.ok(materials[0].segments.at(-1)!.page! > 300);
  assert.equal(materials[1].segments[0].id, 'r2:s1');
  assert.ok(materialIds(materials).has('r1:s1'));
});

test('chapter checks name what to repair', () => {
  const ids = new Set(['r1:s1']);
  assert.deepEqual(chapterIssues(`## Rate\n\n${prose} [r1:s1]`, 'Rate', ids), []);
  const issues = chapterIssues(
    `Intro without heading [r1:s9]\n\n## One\n\n## Two\n\n\`\`\`widget\n{broken\n\`\`\``,
    'Rate',
    ids,
  );
  assert.ok(issues.some((issue) => issue.includes('exactly one ## heading')));
  assert.ok(issues.some((issue) => issue.includes('too short')));
  assert.ok(issues.some((issue) => issue.includes('invalid widget')));
  assert.ok(issues.some((issue) => issue.includes('[r1:s9]')));
  assert.ok(
    chapterIssues(`## Rate\n\n${prose}`, 'Rate', ids).some((issue) => issue.includes('Cite')),
  );
});

test('assembly numbers citations by first use and keeps only cited passages', () => {
  const sourceId = crypto.randomUUID();
  const materials = artifactMaterials([{ learning: learning(sourceId, 4), name: 'Lecture.pdf' }]);
  const document = assembleArtifact(
    plan,
    [`## Rate\n\n${prose} [r1:s2] and [r1:s1] again [r1:s2].`, `## Aliasing\n\nUnknown [r1:s99].`],
    materials,
    { request: 'A guide', goal: 'understand', length: 'short' },
  );
  assert.match(document.markdown, /^> \[!key\]\n> Why does sampling/);
  assert.match(
    document.markdown,
    /\[\[1\]\]\(#ref-r1%3As2\) and \[\[2\]\]\(#ref-r1%3As1\) again \[\[1\]\]/,
  );
  assert.doesNotMatch(document.markdown, /r1:s99/);
  assert.deepEqual(
    document.references.map((reference) => [reference.id, reference.segmentId, reference.page]),
    [
      ['r1:s2', 's2', 2],
      ['r1:s1', 's1', 1],
    ],
  );
  assert.ok(document.references.every((reference) => reference.sourceId === sourceId));
});

async function library() {
  const store = new MemoryStore(),
    sourceId = crypto.randomUUID();
  await store.put(`file:${sourceId}`, { id: sourceId, version: 1, name: 'Lecture.pdf' });
  await store.put(`learning:${sourceId}`, learning(sourceId, 4));
  return { store, sourceId };
}
function services(overrides: Partial<TutorArtifactServices> = {}) {
  const tasks: Array<Promise<unknown>> = [],
    saved: Array<{ job: TutorArtifactJob; markdown: string }> = [],
    repairs: number[] = [];
  const value: TutorArtifactServices = {
    owner: 'runner-1',
    start: (task) => void tasks.push(task),
    plan: async () => plan,
    chapter: async (_job, current, index, _materials, repair) => {
      if (repair) repairs.push(index);
      // The second chapter forgets its citation once and is repaired.
      return index === 1 && !repair
        ? `## ${current.chapters[index].title}\n\n${prose}`
        : `## ${current.chapters[index].title}\n\n${prose} [r1:s${index + 1}]`;
    },
    previous: async () => null,
    save: async (job, document) => {
      saved.push({ job, markdown: document.markdown });
      return saved.length;
    },
    ...overrides,
  };
  return { value, tasks, saved, repairs, settle: () => Promise.all(tasks) };
}
const input = (sourceId: string, id = crypto.randomUUID()) => ({
  id,
  conversationId: 'conversation-1',
  locale: 'en' as const,
  model: 'muse-spark-1.3',
  request: {
    request: 'A short guide to sampling',
    goal: 'understand' as const,
    length: 'short' as const,
    sourceIds: [sourceId],
  },
});

test('a generation plans, writes, repairs once and saves one version', async () => {
  const { store, sourceId } = await library();
  const run = services();
  const request = input(sourceId);
  const started = await startTutorArtifact(store.storage(), request, run.value);
  assert.equal(started.status, 'planning');
  await run.settle();
  const status = await tutorArtifactStatus(store.storage(), request.id);
  assert.equal(status.status, 'ready');
  assert.equal(status.version, 1);
  assert.deepEqual(status.chapters, { done: 2, total: 2 });
  assert.deepEqual(run.repairs, [1]);
  assert.equal(run.saved.length, 1);
  assert.match(run.saved[0].markdown, /\[\[2\]\]\(#ref-r1%3As2\)/);
  // The same call starts nothing new.
  await startTutorArtifact(store.storage(), request, run.value);
  await run.settle();
  assert.equal(run.saved.length, 1);
});

test('an unprepared source is refused before anything is stored', async () => {
  const { store } = await library();
  const missing = crypto.randomUUID();
  await store.put(`file:${missing}`, { id: missing, version: 2, name: 'Draft.pdf' } as Source);
  await assert.rejects(
    startTutorArtifact(store.storage(), input(missing), services().value),
    /Draft\.pdf is not prepared yet/,
  );
  assert.equal([...(await store.list({ prefix: 'tutor-artifact-job:' })).keys()].length, 0);
});

test('a failed generation keeps its chapters and continues on retry', async () => {
  const { store, sourceId } = await library();
  let fail = true;
  const run = services({
    chapter: async (_job, current, index) => {
      if (index === 1 && fail) throw new Error('Model unavailable');
      return `## ${current.chapters[index].title}\n\n${prose} [r1:s1]`;
    },
  });
  const request = input(sourceId);
  await startTutorArtifact(store.storage(), request, run.value);
  await run.settle();
  const failed = await tutorArtifactStatus(store.storage(), request.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'Model unavailable');
  assert.deepEqual(failed.chapters, { done: 1, total: 2 });
  fail = false;
  await resumeTutorArtifact(store.storage(), request.id, run.value, true);
  await run.settle();
  assert.equal((await tutorArtifactStatus(store.storage(), request.id)).status, 'ready');
});

test('a stalled generation is resumed by another runner only after its lease', async () => {
  const { store, sourceId } = await library();
  const first = services({ start: () => {} });
  const request = input(sourceId);
  await startTutorArtifact(store.storage(), request, first.value);
  const second = services({ owner: 'runner-2' });
  await resumeTutorArtifact(store.storage(), request.id, second.value);
  assert.equal(second.tasks.length, 0);
  const key = `tutor-artifact-job:${request.id}`;
  const job = (await store.get<TutorArtifactJob>(key))!;
  await store.put(key, { ...job, until: Date.now() - 1 });
  await resumeTutorArtifact(store.storage(), request.id, second.value);
  await second.settle();
  assert.equal((await tutorArtifactStatus(store.storage(), request.id)).status, 'ready');
});
