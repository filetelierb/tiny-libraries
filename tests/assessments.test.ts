import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessmentConfigSchema,
  publicAssessmentPlan,
  validAssessmentResponse,
  gradeAssessmentQuestion,
  compileAssessmentReport,
  assessmentMarkdown,
  validateAssessmentBatch,
  type AssessmentBatch,
  type AssessmentContext,
  type AssessmentConfig,
  type AssessmentQuestion,
  type AssessmentPlan,
  type AssessmentAnswer,
  type AssessmentGrade,
} from '../shared/assessments';
import type { Source, Learning, StudySession } from '../shared/domain';
import type { Conversation } from '../shared/conversations';
import {
  createAssessment,
  assessmentDetail,
  assessmentAction,
  assessmentHistory,
  saveAssessmentAnswer,
} from '../worker/assessments';
import { captureAssessmentContext, captureStudyProgress } from '../worker/assessment-context';
import { generateAssessmentBatch, analyzeAssessment } from '../worker/meta';
import { MemoryStore } from './storage';
import { acknowledgeAssessmentAnswer, type AssessmentDraft } from '../src/study/assessmentDrafts';

test('late answer acknowledgements preserve newer draft work and advance only once', () => {
  const requestId = crypto.randomUUID();
  const draft: AssessmentDraft = {
    step: 0,
    responses: { q1: 'a', q2: 'unfinished text' },
    operation: {
      requestId,
      questionId: 'q1',
      expectedRevision: 0,
      response: 'a',
      confidence: 'sure',
    },
    conflict: false,
  };
  const answer: AssessmentAnswer = {
    questionId: 'q1',
    response: 'a',
    confidence: 'sure',
    revision: 1,
    updatedAt: 'today',
  };
  assert.equal(acknowledgeAssessmentAnswer(draft, crypto.randomUUID(), answer, 1), draft);
  const accepted = acknowledgeAssessmentAnswer(draft, requestId, answer, 1);
  assert.deepEqual(accepted.responses, { q2: 'unfinished text' });
  assert.equal(accepted.operation, null);
  assert.equal(accepted.step, 1);
  const moved = { ...accepted, step: 5 };
  assert.equal(acknowledgeAssessmentAnswer(moved, requestId, answer, 1), moved);
});

const sourceId = '31c90f6e-93ee-4018-87ab-03964476cb22',
  sessionId = '11c90f6e-93ee-4018-87ab-03964476cb22',
  otherId = '21c90f6e-93ee-4018-87ab-03964476cb22';
const source: Source = {
  id: sourceId,
  version: 1,
  name: 'Sampling.md',
  folder: '',
  kind: 'markdown',
  mime: 'text/markdown',
  size: 100,
  archived: false,
  reviewed: true,
  createdAt: 'today',
};
const learning: Learning = {
  sourceId,
  sourceVersion: 1,
  model: 'test',
  locale: 'en',
  createdAt: 'prepared-one',
  segments: [
    { id: 's1', text: 'Sampling frequency counts samples per second.' },
    { id: 's2', text: 'The signal frequency is eight hertz.' },
    { id: 's3', text: 'Aliasing creates an apparent frequency of four hertz.' },
  ],
  synthesis: { title: 'Sampling', glossary: [], artifact: null, chapters: [] },
};
const session: StudySession = {
  id: sessionId,
  name: 'Study',
  tabs: [sourceId],
  active: sourceId,
  split: null,
  positions: {},
  notes: [],
  bookmarks: [],
  artifacts: {},
  conversations: {},
  createdAt: 'today',
};
const config: AssessmentConfig = {
  sourceIds: [sourceId],
  count: 12,
  difficulty: 'mixed',
  guidance: '',
  priorReportIds: [],
};
const citation = { sourceId, segmentId: 's1', quote: 'counts samples per second' };
const context: AssessmentContext = {
  sources: [
    {
      id: sourceId,
      version: 1,
      name: source.name,
      kind: source.kind,
      learningVersion: learning.createdAt,
      reviewed: true,
      limit: null,
      preparedCount: 3,
      studiedCount: 3,
      segments: learning.segments,
      notes: [],
    },
  ],
  conversation: [],
  prior: [],
  gaps: [],
  capturedAt: 'today',
};
function batch(index = 0): AssessmentBatch {
  const questions: AssessmentQuestion[] = Array.from({ length: 12 }, (_, i) => {
    const type = (['choice', 'true_false', 'fill_blank', 'matching'] as const)[i % 4];
    return {
      id: `q${i}`,
      topicId: 'topic',
      type,
      difficulty: 'easy',
      difficultyReason: 'Recall a supplied fact.',
      prompt:
        type === 'fill_blank'
          ? `Batch ${index} item ${i}: Sampling frequency counts ____ per second.`
          : `Batch ${index} item ${i}: identify the sampling definition.`,
      options:
        type === 'matching'
          ? [
              { id: 'a', text: 'Rate' },
              { id: 'b', text: 'Signal' },
              { id: 'c', text: 'Alias' },
            ]
          : type === 'true_false'
            ? [
                { id: 'true', text: 'True' },
                { id: 'false', text: 'False' },
              ]
            : [
                { id: 'a', text: 'Samples' },
                { id: 'b', text: 'Seconds' },
                { id: 'c', text: 'Metres' },
                { id: 'd', text: 'Colours' },
              ],
      correctOptionId: type === 'matching' ? null : type === 'true_false' ? 'true' : 'a',
      acceptedAnswers: type === 'fill_blank' ? ['sample'] : [],
      prompts:
        type === 'matching'
          ? ['one', 'two', 'three'].map((id, j) => ({
              id,
              text: `Definition ${j}`,
              citations: [citation],
            }))
          : [],
      matches:
        type === 'matching'
          ? ['one', 'two', 'three'].map((promptId, j) => ({
              promptId,
              optionId: ['a', 'b', 'c'][j],
              explanation: 'Evidence defines this pair.',
            }))
          : [],
      explanation: 'PRIVATE_KEY_FEEDBACK counts samples.',
      citations: [citation],
    };
  });
  return {
    title: 'Sampling review',
    topics: [
      {
        id: 'topic',
        title: 'Sampling',
        summary: 'Sample counting',
        concepts: ['Sampling'],
        citations: [citation],
      },
    ],
    questions,
    coverageNotes: [],
  };
}
async function setup() {
  const store = new MemoryStore();
  await store.put(`file:${sourceId}`, source);
  await store.put(`learning:${sourceId}`, learning);
  await store.put(`session:${sessionId}`, session);
  return store;
}
function operations(
  tasks: Promise<void>[],
  overrides: Partial<Parameters<typeof createAssessment>[2]> = {},
) {
  return {
    owner: 'worker-one',
    settings: { configured: true, locale: 'en' as const, model: 'test', webAuto: false },
    start: (p: Promise<void>) => {
      tasks.push(p);
    },
    generate: async (
      _c: AssessmentContext,
      _config: AssessmentConfig,
      _previous: string[],
      index: number,
    ) => batch(index),
    analyze: async (_c: AssessmentContext, plan: AssessmentPlan) => ({
      analysis: 'This is an observed sample, not a claim about ability.',
      topics: plan.topics.map((t) => ({
        topicId: t.id,
        analysis: 'The recorded answers support this limited review.',
      })),
      recommendations: plan.topics.map((t) => ({
        topicId: t.id,
        title: 'Review the definition',
        reason: 'Use the cited definition for another practice attempt.',
        citations: [citation],
      })),
    }),
    ...overrides,
  };
}
async function prepare(store: MemoryStore, count = 12) {
  const tasks: Promise<void>[] = [],
    id = crypto.randomUUID(),
    ops = operations(tasks);
  await createAssessment(
    store.storage(),
    { requestId: id, sessionId, config: { ...config, count } },
    ops,
  );
  await Promise.all(tasks);
  return { id, ops, tasks, detail: await assessmentDetail(store.storage(), id, ops.owner) };
}

test('assessment preparation freezes journal messages supplied outside the storage transaction', async () => {
  const store = await setup(),
    tasks: Promise<void>[] = [];
  const journalConversation: Conversation = {
    id: crypto.randomUUID(),
    sessionId,
    sourceIds: [],
    name: 'Synthetic journal context',
    createdAt: '2026-10-27',
    updatedAt: '2026-10-27',
    messageCount: 200,
    messages: [
      {
        role: 'assistant',
        content: 'Accepted journal answer',
        sourceIds: [sourceId],
        status: 'stopped',
      },
      { role: 'assistant', content: 'UNRELATED_JOURNAL_TEXT', sourceIds: [otherId] },
    ],
  };
  let lookedUp = 0;
  const ops = operations(tasks, {
    conversations: async (selectedSession, selectedSources) => {
      assert.equal(selectedSession, sessionId);
      assert.deepEqual(selectedSources, config.sourceIds);
      lookedUp++;
      return [journalConversation];
    },
    generate: async (frozen, _config, _previous, index) => {
      assert.deepEqual(frozen.conversation, [
        { role: 'assistant', content: 'Accepted journal answer' },
      ]);
      assert.ok(frozen.gaps.some((gap) => gap.includes('stopped')));
      assert.ok(frozen.gaps.some((gap) => gap.includes('bounded selection')));
      assert.equal(JSON.stringify(frozen).includes('UNRELATED_JOURNAL_TEXT'), false);
      return batch(index);
    },
  });
  const id = crypto.randomUUID();
  await createAssessment(store.storage(), { requestId: id, sessionId, config }, ops);
  await Promise.all(tasks);
  assert.equal(lookedUp, 1);
  assert.equal((await assessmentDetail(store.storage(), id, ops.owner)).status, 'ready');
});
const response = (q: AssessmentQuestion) =>
  q.type === 'matching'
    ? JSON.stringify(Object.fromEntries(q.matches.map((m) => [m.promptId, m.optionId])))
    : q.type === 'fill_blank' && q.difficulty === 'hard'
      ? q.options.find((o) => o.id === q.correctOptionId)!.text
      : q.correctOptionId!;

test('assessment configuration and all question shapes enforce counts, difficulty, pairs and literal evidence', () => {
  for (const count of [12, 24, 36, 48, 60])
    assert.equal(assessmentConfigSchema.parse({ ...config, count }).count, count);
  assert.throws(() => assessmentConfigSchema.parse({ ...config, count: 13 }));
  assert.equal(validateAssessmentBatch(batch(), context, config).questions.length, 12);
  const wrong = batch();
  wrong.questions[0].citations[0] = { ...citation, sourceId: otherId };
  assert.throws(() => validateAssessmentBatch(wrong, context, config), /outside/);
  const pairs = batch();
  pairs.questions[3].matches[1].optionId = 'a';
  assert.throws(() => validateAssessmentBatch(pairs, context, config), /unique answer/);
  const hard = batch();
  hard.questions[0].difficulty = 'hard';
  assert.throws(
    () => validateAssessmentBatch(hard, context, { ...config, difficulty: 'easy' }),
    /difficulty/,
  );
  assert.throws(
    () => validateAssessmentBatch(batch(), context, config, [batch().questions[0].prompt]),
    /repeats/,
  );
});
test('answer validation rejects reused matching choices and grading gives fractional or unknown credit deterministically', () => {
  const q = batch().questions[3],
    now = 'today';
  assert.equal(validAssessmentResponse(q, JSON.stringify({ one: 'a', two: 'a' })), false);
  assert.equal(validAssessmentResponse(q, JSON.stringify({ one: 'a' })), true);
  const answer = {
    questionId: q.id,
    revision: 1,
    updatedAt: now,
    response: JSON.stringify({ one: 'a', two: 'c' }),
    confidence: 'sure' as const,
  };
  const grade = gradeAssessmentQuestion(q, answer);
  assert.equal(grade.score, 1 / 3);
  assert.equal(grade.pairs[0].correct, true);
  assert.equal(gradeAssessmentQuestion(q, { ...answer, confidence: 'unknown' }).score, 0);
  const fill = { ...batch().questions[2], difficulty: 'hard' as const };
  assert.equal(
    gradeAssessmentQuestion(fill, { ...answer, response: 'SÁMPLE', questionId: fill.id }).score,
    1,
  );
  assert.equal(validAssessmentResponse(fill, 'x'.repeat(301)), false);
});
test('frozen context excludes unselected notes/conversation and clips whole media cues at studied limits', async () => {
  const store = await setup();
  await store.put(`file:${sourceId}`, { ...source, kind: 'audio', reviewed: false });
  await store.put(`learning:${sourceId}`, {
    ...learning,
    segments: learning.segments.map((s, i) => ({ ...s, start: i * 5, end: (i + 1) * 5 })),
  });
  await store.put(`session:${sessionId}`, { ...session, positions: { [sourceId]: 7 } });
  await store.put(`annotation-source-summary:${otherId}:hidden`, {
    sourceId: otherId,
    sourceVersion: 1,
    text: 'NEVER_INCLUDE_OTHER_FILE',
    deleted: false,
  });
  await store.put('conversation:linked', {
    sessionId,
    sourceIds: [sourceId, otherId],
    messages: [
      { role: 'user', content: 'Selected only', sourceIds: [sourceId] },
      { role: 'assistant', content: 'SECRET_OTHER_FILE', sourceIds: [otherId] },
      { role: 'assistant', content: 'AMBIGUOUS_PARENT' },
    ],
  });
  const value = await captureAssessmentContext(store.storage(), sessionId, config);
  assert.deepEqual(
    value.sources[0].segments.map((s) => s.id),
    ['s1'],
  );
  assert.equal(value.sources[0].limit, 7);
  assert.deepEqual(value.conversation, [{ role: 'user', content: 'Selected only' }]);
  assert.equal(JSON.stringify(value).includes('OTHER_FILE'), false);
  await store.put(`annotation-source-summary:${sourceId}:note`, {
    id: 'note',
    sourceId,
    sourceVersion: 1,
    title: 'Later note',
    text: 'A note',
    location: { seconds: 11 },
    revision: 1,
    updatedAt: 'today',
    deleted: false,
  });
  assert.deepEqual(
    (await captureAssessmentContext(store.storage(), sessionId, config)).sources[0].segments.map(
      (s) => s.id,
    ),
    ['s1', 's2'],
  );
});
test('reading high-water survives rewinding without changing the current reader position', async () => {
  const store = await setup(),
    previous = { ...session, positions: { [sourceId]: 18 } },
    incoming = { ...session, positions: { [sourceId]: 2 } };
  await store.transaction((tx) => captureStudyProgress(tx, previous, incoming));
  assert.equal(await store.get(`study-highwater:${sourceId}:v1`), 18);
  assert.equal(incoming.positions[sourceId], 2);
  await store.transaction((tx) =>
    captureStudyProgress(tx, incoming, { ...incoming, positions: { [sourceId]: 1 } }),
  );
  assert.equal(await store.get(`study-highwater:${sourceId}:v1`), 18);
});
test('batch generation keeps answers private, stable option order and independent storage beyond one record', async () => {
  const store = await setup(),
    { id, detail } = await prepare(store, 24);
  assert.equal(detail.status, 'ready');
  assert.equal(detail.completedBatches, 2);
  assert.equal(detail.plan!.questions.length, 24);
  assert.equal(JSON.stringify(detail).includes('PRIVATE_KEY_FEEDBACK'), false);
  assert.equal('correctOptionId' in detail.plan!.questions[0], false);
  assert.equal('matches' in detail.plan!.questions[3], false);
  assert.deepEqual((await assessmentDetail(store.storage(), id, 'worker-two')).plan, detail.plan);
  assert.equal((await store.list({ prefix: `assessment-question:${id}:` })).size, 24);
});
test('answer receipts recover exactly, protect revisions and prevent finished results from changing', async () => {
  const store = await setup(),
    { id, ops, detail } = await prepare(store),
    q = detail.plan!.questions[0];
  const input = {
    requestId: crypto.randomUUID(),
    questionId: q.id,
    expectedRevision: 0,
    response: q.options[0].id,
    confidence: 'sure',
  };
  const first = await saveAssessmentAnswer(store.storage(), id, input);
  assert.deepEqual(await saveAssessmentAnswer(store.storage(), id, input), first);
  await assert.rejects(
    () => saveAssessmentAnswer(store.storage(), id, { ...input, response: q.options[1].id }),
    /different response/,
  );
  await assert.rejects(
    () => saveAssessmentAnswer(store.storage(), id, { ...input, requestId: crypto.randomUUID() }),
    /another window/,
  );
  await assert.rejects(
    () => assessmentAction(store.storage(), id, { action: 'finish' }, ops),
    /every question/,
  );
  await assessmentAction(store.storage(), id, { action: 'cancel' }, ops);
  assert.deepEqual(await saveAssessmentAnswer(store.storage(), id, input), first);
  await assert.rejects(
    () =>
      saveAssessmentAnswer(store.storage(), id, {
        ...input,
        requestId: crypto.randomUUID(),
        expectedRevision: 1,
      }),
    /not accepting/,
  );
});
test('grading computes scores, creates source bookmarks once and exports a complete immutable report', async () => {
  const store = await setup(),
    { id, ops, tasks } = await prepare(store),
    questions = [
      ...(await store.list<AssessmentQuestion>({ prefix: `assessment-question:${id}:` })).values(),
    ];
  for (const [i, q] of questions.entries())
    await saveAssessmentAnswer(store.storage(), id, {
      requestId: crypto.randomUUID(),
      questionId: q.id,
      expectedRevision: 0,
      response: i === 0 ? '' : response(q),
      confidence: i === 0 ? 'unknown' : 'sure',
    });
  await assessmentAction(store.storage(), id, { action: 'finish' }, ops);
  await Promise.all(tasks);
  const result = await assessmentDetail(store.storage(), id, ops.owner);
  assert.equal(result.status, 'completed');
  assert.equal(result.report!.score, 92);
  assert.equal(result.grades.length, 12);
  assert.equal(result.report!.topics[0].unknown, 1);
  const noteId = result.report!.recommendations[0].bookmarkId;
  assert.ok(noteId);
  assert.equal((await store.list({ prefix: 'annotation:' })).size, 1);
  assert.match(assessmentMarkdown(result), /92%/);
  assert.match(assessmentMarkdown(result), /Sampling.md/);
  assert.match(assessmentMarkdown(result), /Correct answer:/);
  await assessmentAction(store.storage(), id, { action: 'finish' }, ops);
  assert.deepEqual(await assessmentDetail(store.storage(), id, ops.owner), result);
  await assert.rejects(
    () => assessmentAction(store.storage(), id, { action: 'cancel' }, ops),
    /immutable/,
  );
  const completed = await store.get<Record<string, unknown>>(`assessment:${id}`);
  await store.put(`assessment:${id}`, { ...completed, workActive: true, owner: 'earlier-runtime' });
  const recovered = await assessmentDetail(store.storage(), id, 'new-runtime');
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.workActive, false);
  assert.deepEqual(recovered.report, result.report);
  const nextContext = await captureAssessmentContext(store.storage(), sessionId, {
    ...config,
    priorReportIds: [id],
  });
  assert.equal(nextContext.prior.length, 1);
  assert.equal(nextContext.prior[0].confidence, 'unknown');
  const followupId = crypto.randomUUID();
  const followupOps = operations(tasks, {
    generate: async (_context, _config, previous) => {
      assert.ok(previous.includes(nextContext.prior[0].prompt));
      return batch(1);
    },
  });
  await createAssessment(
    store.storage(),
    {
      requestId: followupId,
      sessionId,
      config: { ...config, priorReportIds: [id] },
    },
    followupOps,
  );
  await Promise.all(tasks);
  assert.equal(
    (await assessmentDetail(store.storage(), followupId, followupOps.owner)).status,
    'ready',
  );
});
test('failed later batches resume without replacing saved questions or shuffled options', async () => {
  const store = await setup(),
    tasks: Promise<void>[] = [],
    id = crypto.randomUUID();
  let fail = true;
  const ops = operations(tasks, {
    generate: async (_c, _config, _previous, index) => {
      if (index === 1 && fail) throw new Error('Provider interrupted');
      return batch(index);
    },
  });
  await createAssessment(
    store.storage(),
    { requestId: id, sessionId, config: { ...config, count: 24 } },
    ops,
  );
  await Promise.all(tasks);
  const first = await assessmentDetail(store.storage(), id, ops.owner);
  assert.equal(first.status, 'failed');
  assert.equal(first.completedBatches, 1);
  const kept = structuredClone(first.plan);
  fail = false;
  await assessmentAction(store.storage(), id, { action: 'retry' }, ops);
  await Promise.all(tasks);
  const result = await assessmentDetail(store.storage(), id, ops.owner);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.plan!.questions.slice(0, 12), kept!.questions);
});
test('cooperative cancellation preserves saved data and suppresses a response already in flight', async () => {
  const store = await setup(),
    tasks: Promise<void>[] = [],
    id = crypto.randomUUID();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ops = operations(tasks, {
    generate: async () => {
      await wait;
      return batch();
    },
  });
  await createAssessment(store.storage(), { requestId: id, sessionId, config }, ops);
  await assessmentAction(store.storage(), id, { action: 'cancel' }, ops);
  release();
  await Promise.all(tasks);
  const result = await assessmentDetail(store.storage(), id, ops.owner);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.workActive, false);
  assert.equal(result.plan, null);
});
test('report interpretation cannot replace numeric scores or cite outside the saved sample', () => {
  const plan = batch() as AssessmentPlan,
    grades = plan.questions.map((q) =>
      gradeAssessmentQuestion(q, {
        questionId: q.id,
        response: response(q),
        confidence: 'sure',
        revision: 1,
        updatedAt: 'today',
      }),
    );
  const analysis = {
    analysis: 'Recorded sample.',
    score: 2,
    topics: [{ topicId: 'topic', analysis: 'Observed questions.' }],
    recommendations: [],
  };
  assert.equal(compileAssessmentReport(analysis, plan, grades, context).score, 100);
  assert.throws(
    () =>
      compileAssessmentReport(
        {
          ...analysis,
          recommendations: [
            {
              topicId: 'topic',
              title: 'Read',
              reason: 'Practice',
              citations: [{ ...citation, sourceId: otherId }],
            },
          ],
        },
        plan,
        grades,
        context,
      ),
    /outside/,
  );
});
test('Meta generation and report analysis use frozen evidence and application-calculated scores', async () => {
  await generateAssessmentBatch(
    'test-placeholder',
    'test',
    context,
    config,
    [],
    0,
    'en',
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      assert.equal(JSON.parse(body.messages[1].content).questionCount, 12);
      return Response.json({ choices: [{ message: { content: JSON.stringify(batch()) } }] });
    },
  );
  const plan = batch() as AssessmentPlan,
    grades = plan.questions.map((q) =>
      gradeAssessmentQuestion(q, {
        questionId: q.id,
        response: '',
        confidence: 'unknown',
        revision: 1,
        updatedAt: 'today',
      }),
    );
  await analyzeAssessment(
    'test-placeholder',
    'test',
    context,
    plan,
    grades,
    'es',
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      assert.match(body.messages[0].content, /Spanish/);
      assert.equal(JSON.parse(body.messages[1].content).scores.percent, 0);
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                analysis: 'A limited sample.',
                topics: [{ topicId: 'topic', analysis: 'Unknown answers.' }],
                recommendations: [
                  {
                    topicId: 'topic',
                    title: 'Review',
                    reason: 'Unknown answers need a next step.',
                    citations: [citation],
                  },
                ],
              }),
            },
          },
        ],
      });
    },
  );
});

test('sixty-question assessments persist five batches and grade all results without one oversized record', async () => {
  const store = await setup(),
    { id, ops, tasks, detail } = await prepare(store, 60);
  assert.equal(detail.plan!.questions.length, 60);
  assert.equal(detail.completedBatches, 5);
  for (const q of detail.plan!.questions)
    await saveAssessmentAnswer(store.storage(), id, {
      requestId: crypto.randomUUID(),
      questionId: q.id,
      expectedRevision: 0,
      response: '',
      confidence: 'unknown',
    });
  await assessmentAction(store.storage(), id, { action: 'finish' }, ops);
  await Promise.all(tasks);
  const result = await assessmentDetail(store.storage(), id, ops.owner);
  assert.equal(result.status, 'completed');
  assert.equal(result.report!.count, 60);
  assert.equal(result.report!.score, 0);
  assert.equal(
    result.report!.topics.reduce((n, t) => n + t.unknown, 0),
    60,
  );
  assert.ok(
    [...store.data.values()].every(
      (value) => new TextEncoder().encode(JSON.stringify(value)).length <= 120000,
    ),
  );
});
test('a recovered preparation owner cannot be overwritten by an earlier in-flight response', async () => {
  const store = await setup(),
    tasks: Promise<void>[] = [],
    id = crypto.randomUUID();
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const old = operations(tasks, {
    generate: async () => {
      await wait;
      return batch();
    },
  });
  await createAssessment(store.storage(), { requestId: id, sessionId, config }, old);
  assert.equal((await assessmentDetail(store.storage(), id, 'new-runtime')).status, 'interrupted');
  const next = operations(tasks, { owner: 'new-runtime' });
  await assessmentAction(store.storage(), id, { action: 'retry' }, next);
  await tasks[1];
  const ready = await assessmentDetail(store.storage(), id, 'new-runtime');
  assert.equal(ready.status, 'ready');
  release();
  await Promise.all(tasks);
  assert.deepEqual((await assessmentDetail(store.storage(), id, 'new-runtime')).plan, ready.plan);
});
test('history pagination returns each saved review once without exposing internal ownership', async () => {
  const store = await setup();
  for (let i = 0; i < 35; i++) {
    const id = crypto.randomUUID();
    await store.put(`assessment:${id}`, {
      id,
      sessionId,
      createdAt: new Date(1700000000000 + i * 1000).toISOString(),
      updatedAt: 'today',
      config,
      status: 'cancelled',
      stage: 'prepare',
      completedBatches: 0,
      title: 'Saved',
      locale: 'en',
      model: 'test',
      workActive: false,
      fingerprint: 'private',
      owner: 'private',
      operation: 'private',
      until: 0,
    });
  }
  const first = await assessmentHistory(store.storage(), sessionId, 'worker-one');
  assert.equal(first.items.length, 30);
  assert.ok(first.nextCursor);
  const next = await assessmentHistory(store.storage(), sessionId, 'worker-one', first.nextCursor!);
  assert.equal(next.items.length, 5);
  assert.equal(next.nextCursor, null);
  assert.equal(new Set([...first.items, ...next.items].map((r) => r.id)).size, 35);
  assert.equal(JSON.stringify(first).includes('private'), false);
});
