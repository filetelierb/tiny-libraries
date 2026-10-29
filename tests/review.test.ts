import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  publicLearning,
  reviewSummary,
  type Attempt,
  type Catalog,
  type Learning,
  type Source,
  type StudySession,
} from '../shared/domain';
import {
  reinforcementLearning,
  reviewGroups,
  reviewSources,
  validateReinforcement,
  type ReinforcementContext,
  type ReinforcementPlan,
} from '../shared/review';
import { reinforcementSnapshot, startReinforcement } from '../worker/reinforcements';
import { recordAttempt } from '../worker/practice';
import { generateReinforcement } from '../worker/meta';
import { MemoryStore } from './storage';

const sourceId = '31c90f6e-93ee-4018-87ab-03964476cb22',
  sessionId = '11c90f6e-93ee-4018-87ab-03964476cb22';
const source: Source = {
  id: sourceId,
  version: 1,
  name: 'Sampling.md',
  folder: '',
  kind: 'markdown',
  mime: 'text/markdown',
  size: 100,
  archived: false,
  reviewed: false,
  createdAt: 'today',
};
const question = {
  id: 'original',
  kind: 'single' as const,
  prompt: 'What does sampling frequency count?',
  choices: ['Samples per second', 'Seconds per sample'],
  correctIndex: 0,
  expectedAnswer: null,
  rubric: null,
  explanation: 'It counts samples per second.',
  concept: 'Sampling frequency',
  segmentIds: ['s1'],
};
const learning: Learning = {
  sourceId,
  sourceVersion: 1,
  createdAt: 'preparation-one',
  locale: 'en',
  model: 'test',
  segments: [{ id: 's1', text: 'Sampling frequency counts samples per second.' }],
  synthesis: {
    title: 'Sampling',
    glossary: [],
    artifact: null,
    chapters: [
      {
        id: 'first',
        title: 'Sampling',
        summary: 'A count',
        segmentIds: ['s1'],
        questions: [question],
      },
    ],
  },
};
const attempt: Attempt = {
  id: '21c90f6e-93ee-4018-87ab-03964476cb22',
  sourceId,
  sourceVersion: 1,
  questionId: question.id,
  question: publicLearning(learning).synthesis.chapters[0].questions[0],
  learningVersion: learning.createdAt,
  concept: question.concept,
  selected: 1,
  correct: false,
  explanation: question.explanation,
  segmentIds: ['s1'],
  createdAt: '2026-10-27T00:00:00Z',
};
const session = {
  id: sessionId,
  name: 'Study',
  tabs: [sourceId],
  resourceTabs: [{ id: 'file', sources: [sourceId], preview: false }],
  notes: [],
  bookmarks: [],
  conversations: {},
  artifacts: {},
  positions: {},
  active: sourceId,
  split: null,
  createdAt: 'today',
} satisfies StudySession;
const context: ReinforcementContext = {
  sourceId,
  sourceVersion: 1,
  sourceName: source.name,
  learningVersion: learning.createdAt,
  concept: question.concept,
  attempts: [attempt],
  segments: learning.segments,
};
function plan(): ReinforcementPlan {
  return {
    title: 'Counting samples',
    introduction: 'One observed answer provides limited evidence.',
    objectives: ['Distinguish a rate from an interval.'],
    findings: [
      {
        attemptIds: [attempt.id],
        explanation: 'The selected answer describes an interval rather than the recorded rate.',
        segmentIds: ['s1'],
      },
    ],
    lessons: [
      {
        title: 'A rate counts',
        body: 'Sampling frequency counts measurements each second.',
        evidence: [{ segmentId: 's1', quote: 'counts samples per second' }],
      },
    ],
    questions: [
      { ...question, id: 'new-choice', prompt: 'Which unit describes a sampling frequency?' },
      {
        ...question,
        id: 'new-short',
        kind: 'short',
        prompt: 'Explain what a sampling frequency measures.',
        choices: [],
        correctIndex: null,
        expectedAnswer: 'Samples per second',
        rubric: 'Mentions samples and per second.',
      },
    ],
    artifact: null,
  };
}
async function setup() {
  const store = new MemoryStore();
  await store.put(`file:${sourceId}`, source);
  await store.put(`learning:${sourceId}`, learning);
  await store.put(`attempt:${attempt.id}`, attempt);
  await store.put(`session:${sessionId}`, session);
  return store;
}
async function generate(
  store: MemoryStore,
  id = crypto.randomUUID(),
  callback = async () => plan(),
  owner = 'worker-one',
) {
  const tasks: Promise<void>[] = [];
  await startReinforcement(
    store.storage(),
    { requestId: id, sessionId, sourceId, attemptIds: [attempt.id] },
    {
      owner,
      settings: { configured: true, locale: 'en', model: 'test', webAuto: false },
      generate: callback,
      start: (task) => {
        tasks.push(task);
      },
    },
  );
  await Promise.all(tasks);
  return (await reinforcementSnapshot(store.storage(), owner)).find((r) => r.id === id)!;
}
test('review scopes include session files and linked conversation sources without including trash', () => {
  const other = { ...source, id: crypto.randomUUID(), name: 'Other.md' },
    trashed = { ...source, id: crypto.randomUUID(), trashed: true };
  const catalog = {
    files: [source, other, trashed],
    directories: [],
    sessions: [session],
    attempts: [],
    concepts: [],
    settings: { configured: false, locale: 'en', model: 'test', webAuto: false },
    conversations: [
      {
        id: 'chat',
        sessionId,
        name: 'Discussion',
        sourceIds: [other.id],
        messages: [],
        createdAt: 'today',
        updatedAt: 'today',
      },
    ],
  } satisfies Catalog;
  assert.deepEqual(
    reviewSources(catalog, session, 'source', other.id).map((s) => s.id),
    [other.id],
  );
  assert.deepEqual(
    reviewSources(catalog, session, 'session').map((s) => s.id),
    [sourceId, other.id],
  );
  assert.equal(reviewSources(catalog, session, 'library').length, 2);
  assert.equal(reviewSources(catalog, session, 'source').length, 0);
  assert.equal(
    reviewGroups([attempt, { ...attempt, id: crypto.randomUUID(), concept: 'SAMPLING FREQUENCY' }])
      .length,
    1,
  );
});
test('reinforcement findings and lessons require recorded attempt identities and literal source evidence', () => {
  assert.equal(validateReinforcement(plan(), context).questions.length, 2);
  const wrong = plan();
  wrong.findings[0].attemptIds = [crypto.randomUUID()];
  assert.throws(() => validateReinforcement(wrong, context), /unavailable evidence/);
  const quote = plan();
  quote.lessons[0].evidence[0].quote = 'invented';
  assert.throws(() => validateReinforcement(quote, context), /unavailable source quote/);
  const repeated = plan();
  repeated.questions[0].prompt = question.prompt;
  assert.throws(() => validateReinforcement(repeated, context), /new questions/);
});
test('reinforcement retries are idempotent, versions remain immutable and public plans exclude solutions', async () => {
  const store = await setup(),
    id = crypto.randomUUID();
  let calls = 0;
  const first = await generate(store, id, async () => {
    calls++;
    return plan();
  });
  assert.equal(first.status, 'ready');
  assert.equal(first.version, 1);
  assert.deepEqual(
    await generate(store, id, async () => {
      calls++;
      return plan();
    }),
    first,
  );
  assert.equal(calls, 1);
  const second = await generate(store);
  assert.equal(second.version, 2);
  assert.equal(second.groupId, first.groupId);
  assert.deepEqual(
    (await reinforcementSnapshot(store.storage(), 'worker-one')).find((r) => r.id === id),
    first,
  );
  assert.match(first.plan!.questions[0].id, new RegExp(id));
  assert.equal('correctIndex' in first.plan!.questions[0], false);
  assert.equal('rubric' in first.plan!.questions[1], false);
  assert.equal('fingerprint' in first, false);
  assert.equal(reinforcementLearning(first)?.synthesis.chapters[0].id, id);
});
test('changed requests, ambiguous results and unversioned evidence cannot start model work', async () => {
  const store = await setup(),
    id = crypto.randomUUID();
  await generate(store, id);
  await assert.rejects(
    () =>
      startReinforcement(
        store.storage(),
        { requestId: id, sessionId, sourceId, attemptIds: [crypto.randomUUID()] },
        {
          owner: 'worker-one',
          settings: { configured: true, locale: 'en', model: 'test', webAuto: false },
          start: () => assert.fail(),
          generate: async () => plan(),
        },
      ),
    /different reinforcement/,
  );
  await store.put(`attempt:${attempt.id}`, { ...attempt, pendingReview: true });
  await assert.rejects(() => generate(store), /recorded incorrect/);
  await store.put(`attempt:${attempt.id}`, { ...attempt, learningVersion: undefined });
  await assert.rejects(() => generate(store), /recorded incorrect/);
});
test('new practice records independent attempts against frozen report questions after source re-preparation', async () => {
  const store = await setup(),
    report = await generate(store);
  await store.put(`learning:${sourceId}`, { ...learning, createdAt: 'later-preparation' });
  const input = {
    sourceId,
    sourceVersion: 1,
    learningVersion: report.learningVersion,
    reinforcementId: report.id,
    reinforcementVersion: report.version,
    chapterId: report.id,
    questionId: report.plan!.questions[1].id,
    answer: 'It counts samples per second.',
    requestId: crypto.randomUUID(),
    runId: crypto.randomUUID(),
  };
  const result = await recordAttempt(
    store.storage(),
    input,
    'worker-one',
    async (q, answer, segments) => {
      assert.equal(q.rubric, 'Mentions samples and per second.');
      assert.equal(segments[0].id, 's1');
      assert.match(answer, /samples/);
      return { status: 'correct', explanation: 'The answer matches the recorded definition.' };
    },
  );
  assert.equal(result.correct, true);
  assert.equal(result.reinforcementId, report.id);
  assert.deepEqual(await store.get(`attempt:${attempt.id}`), attempt);
  assert.deepEqual(
    await recordAttempt(store.storage(), input, 'worker-one', async () => assert.fail()),
    result,
  );
  await assert.rejects(
    () =>
      recordAttempt(
        store.storage(),
        { ...input, reinforcementVersion: 2 },
        'worker-one',
        async () => assert.fail(),
      ),
    /different answer/,
  );
  assert.equal(reviewSummary([attempt, result]).percent, 50);
});
test('unfinished report generation recovers ownership and retries the same frozen evidence', async () => {
  const store = await setup(),
    id = crypto.randomUUID();
  const first = await generate(store, id, async () => {
    throw new Error('Provider interrupted');
  });
  assert.equal(first.status, 'failed');
  const stored = await store.get<Record<string, unknown>>(`reinforcement:${id}`);
  await store.put(`reinforcement:${id}`, {
    ...stored,
    status: 'running',
    owner: 'old-worker',
    until: Date.now() + 600000,
  });
  assert.equal(
    (await reinforcementSnapshot(store.storage(), 'new-worker'))[0].status,
    'interrupted',
  );
  await store.put(`learning:${sourceId}`, { ...learning, createdAt: 'later' });
  const recovered = await generate(store, id, async () => plan(), 'new-worker');
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.version, 1);
  assert.equal(recovered.learningVersion, learning.createdAt);
});
test('Meta reinforcement receives only selected answer evidence and returns a validated plan', async () => {
  const result = await generateReinforcement(
    'test-placeholder',
    'test',
    { ...context, ...{ owner: 'runtime-only', fingerprint: 'request-only' } },
    'es',
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      assert.equal(JSON.parse(body.messages[1].content).owner, undefined);
      assert.equal(JSON.parse(body.messages[1].content).fingerprint, undefined);
      assert.match(body.messages[0].content, /Spanish/);
      assert.match(body.messages[0].content, /never infer persistent difficulty/);
      assert.deepEqual(
        JSON.parse(body.messages[1].content).attempts.map((a: Attempt) => a.id),
        [attempt.id],
      );
      return Response.json({ choices: [{ message: { content: JSON.stringify(plan()) } }] });
    },
  );
  assert.equal(result.questions.length, 2);
});

test('concurrent report requests have one generation owner and cannot duplicate a concept job', async () => {
  const store = await setup(),
    id = crypto.randomUUID(),
    tasks: Promise<void>[] = [];
  let release!: () => void,
    calls = 0;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const input = { requestId: id, sessionId, sourceId, attemptIds: [attempt.id] };
  const options = {
    owner: 'worker-one',
    settings: { configured: true, locale: 'en' as const, model: 'test', webAuto: false },
    start: (task: Promise<void>) => {
      tasks.push(task);
    },
    generate: async () => {
      calls++;
      await wait;
      return plan();
    },
  };
  await startReinforcement(store.storage(), input, options);
  await startReinforcement(store.storage(), input, options);
  await assert.rejects(
    () =>
      startReinforcement(store.storage(), { ...input, requestId: crypto.randomUUID() }, options),
    /still being created/,
  );
  release();
  await Promise.all(tasks);
  assert.equal(calls, 1);
  assert.equal((await reinforcementSnapshot(store.storage(), 'worker-one'))[0].status, 'ready');
});
