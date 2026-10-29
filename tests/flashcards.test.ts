import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Learning, Source } from '../shared/domain';
import {
  cardDue,
  scheduleCard,
  validateCardPlan,
  type CardPlan,
  type DeckView,
} from '../shared/flashcards';
import { cardSnapshot, rateCard, startCardDecks } from '../worker/flashcards';
import { generateCards } from '../worker/meta';
import { MemoryStore } from './storage';
import { completeCardDraft, type CardDraft } from '../src/study/cardDrafts';

const sourceId = '31c90f6e-93ee-4018-87ab-03964476cb22';
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
const learning: Learning = {
  sourceId,
  sourceVersion: 1,
  createdAt: 'preparation-one',
  locale: 'en',
  model: 'test',
  segments: [
    { id: 'interval', text: 'An interval is time between samples.' },
    { id: 'rate', text: 'A rate counts samples per second.' },
  ],
  synthesis: {
    title: 'Sampling',
    artifact: null,
    glossary: [],
    chapters: [
      { id: 'first', title: 'Intervals', summary: 'Time', segmentIds: ['interval'], questions: [] },
      { id: 'second', title: 'Rates', summary: 'Count', segmentIds: ['rate'], questions: [] },
    ],
  },
};
const plan = (chapter = 'first'): CardPlan => ({
  cards: ['Define', 'Measure', 'Distinguish'].map((front) => ({
    front: `${front} ${chapter}`,
    back: chapter === 'first' ? 'Time between samples.' : 'Samples per second.',
    evidence: [
      {
        segmentId: chapter === 'first' ? 'interval' : 'rate',
        quote: chapter === 'first' ? 'time between samples' : 'samples per second',
      },
    ],
  })),
});
async function setup() {
  const memory = new MemoryStore();
  await memory.put(`file:${sourceId}`, source);
  await memory.put(`learning:${sourceId}`, learning);
  return memory;
}
async function create(
  memory: MemoryStore,
  chapters = ['first'],
  generate = async (_l: Learning, id: string) => plan(id),
  owner = 'worker-one',
) {
  const tasks: Promise<void>[] = [];
  await startCardDecks(
    memory.storage(),
    sourceId,
    { sourceVersion: 1, learningVersion: learning.createdAt, chapterIds: chapters },
    {
      owner,
      settings: { configured: true, locale: 'en', model: 'test', webAuto: false },
      generate,
      start: (task) => {
        tasks.push(task);
      },
    },
  );
  await Promise.all(tasks);
  return cardSnapshot(memory.storage(), sourceId, owner);
}
function rating(deck: DeckView, grade: 'again' | 'hard' | 'good' | 'easy' = 'good') {
  return { requestId: crypto.randomUUID(), cardId: deck.cards[0].id, grade, expectedRevision: 0 };
}
test('card scheduling retains lapses, grows intervals and bounds long/hard reviews', () => {
  const now = new Date('2026-10-27T12:00:00Z'),
    first = scheduleCard(null, 'good', now),
    second = scheduleCard(first, 'good', now),
    third = scheduleCard(second, 'good', now);
  assert.equal(first.intervalDays, 1);
  assert.equal(second.intervalDays, 3);
  assert.ok(third.intervalDays > 3);
  const lapse = scheduleCard(third, 'again', now);
  assert.equal(lapse.reps, 0);
  assert.equal(lapse.lapses, 1);
  assert.equal(lapse.dueAt, '2026-10-27T12:10:00.000Z');
  assert.equal(lapse.revision, 4);
  let schedule = first;
  for (let i = 0; i < 100; i++) schedule = scheduleCard(schedule, 'easy', now);
  assert.ok(schedule.intervalDays <= 365);
  assert.ok(schedule.ease <= 3);
  const card = { ...plan().cards[0], id: crypto.randomUUID(), schedule: lapse };
  assert.equal(cardDue(card, now.getTime()), false);
  assert.equal(cardDue(card, now.getTime() + 600000), true);
});
test('cards require literal evidence from the selected chapter and distinct prompts', () => {
  assert.equal(validateCardPlan(plan(), learning, 'first').cards.length, 3);
  const wrong = plan();
  wrong.cards[0].evidence = [{ segmentId: 'rate', quote: 'samples per second' }];
  assert.throws(() => validateCardPlan(wrong, learning, 'first'), /unavailable evidence/);
  const duplicate = plan();
  duplicate.cards[1].front = duplicate.cards[0].front;
  assert.throws(() => validateCardPlan(duplicate, learning, 'first'), /duplicate/);
});
test('creation saves chapters independently, skips existing cards and resumes failed chapters', async () => {
  const memory = await setup();
  const calls: string[] = [];
  let decks = await create(memory, ['first', 'second'], async (_l, id) => {
    calls.push(id);
    if (id === 'second') throw new Error('Interrupted provider request');
    return plan(id);
  });
  assert.deepEqual(calls, ['first', 'second']);
  assert.equal(decks[0].status, 'ready');
  assert.equal(decks[1].status, 'failed');
  const kept = structuredClone(decks[0]);
  decks = await create(memory, ['first', 'second']);
  assert.deepEqual(decks[0], kept);
  assert.equal(decks[1].status, 'ready');
  assert.equal(JSON.stringify(decks).includes('worker-one'), false);
});
test('duplicate creation does not start a second request and invalid evidence is not published', async () => {
  const memory = await setup(),
    tasks: Promise<void>[] = [];
  let release!: () => void,
    calls = 0;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  const options = {
    owner: 'worker-one',
    settings: { configured: true, locale: 'en' as const, model: 'test', webAuto: false },
    start: (p: Promise<void>) => {
      tasks.push(p);
    },
    generate: async () => {
      calls++;
      await pause;
      const value = plan();
      value.cards[0].evidence[0].quote = 'Invented quotation';
      return value;
    },
  };
  const input = { sourceVersion: 1, learningVersion: learning.createdAt, chapterIds: ['first'] };
  await startCardDecks(memory.storage(), sourceId, input, options);
  await startCardDecks(memory.storage(), sourceId, input, options);
  release();
  await Promise.all(tasks);
  assert.equal(calls, 1);
  const deck = (await cardSnapshot(memory.storage(), sourceId, 'worker-one'))[0];
  assert.equal(deck.status, 'failed');
  assert.equal(deck.cards.length, 0);
});
test('stale generation cannot publish after preparation changes; earlier decks remain stored', async () => {
  const memory = await setup();
  const decks = await create(memory, ['first'], async () => {
    await memory.put(`learning:${sourceId}`, { ...learning, createdAt: 'preparation-two' });
    return plan();
  });
  assert.equal(decks.length, 0);
  const stored = [...(await memory.list<DeckView>({ prefix: 'card-deck:' })).values()];
  assert.equal(stored[0].status, 'failed');
  assert.equal(stored[0].cards.length, 0);
});
test('ratings are idempotent, reject changed retries and protect schedules from stale windows', async () => {
  const memory = await setup(),
    deck = (await create(memory))[0],
    input = rating(deck);
  const first = await rateCard(memory.storage(), deck.id, input);
  assert.deepEqual(await rateCard(memory.storage(), deck.id, input), first);
  await assert.rejects(
    () => rateCard(memory.storage(), deck.id, { ...input, grade: 'easy' }),
    /different rating/,
  );
  await assert.rejects(
    () => rateCard(memory.storage(), deck.id, { ...input, requestId: crypto.randomUUID() }),
    /another window/,
  );
  assert.equal((await memory.list({ prefix: 'card-review:' })).size, 1);
  assert.equal(
    (await cardSnapshot(memory.storage(), sourceId, 'worker-one'))[0].cards[0].schedule?.revision,
    1,
  );
  assert.equal((await memory.list({ prefix: 'attempt:' })).size, 0);
});
test('saved rating recovers after source trash; new ratings require current available material', async () => {
  const memory = await setup(),
    deck = (await create(memory))[0],
    input = rating(deck, 'again');
  const first = await rateCard(memory.storage(), deck.id, input);
  await memory.put(`file:${sourceId}`, { ...source, trashed: true });
  assert.deepEqual(await rateCard(memory.storage(), deck.id, input), first);
  await assert.rejects(
    () =>
      rateCard(memory.storage(), deck.id, {
        ...input,
        requestId: crypto.randomUUID(),
        expectedRevision: 1,
      }),
    /Restore/,
  );
});
test('a new runtime marks unfinished creation interrupted and can retry without replacing ready decks', async () => {
  const memory = await setup();
  await create(memory);
  const deck = [
    ...(await memory.list<Record<string, unknown>>({ prefix: 'card-deck:' })).values(),
  ][0];
  await memory.put(`card-deck:${deck.id}`, {
    ...deck,
    cards: [],
    status: 'running',
    owner: 'old-worker',
    operation: crypto.randomUUID(),
    until: Date.now() + 600000,
  });
  assert.equal(
    (await cardSnapshot(memory.storage(), sourceId, 'new-worker'))[0].status,
    'interrupted',
  );
  assert.equal((await create(memory, ['first'], undefined, 'new-worker'))[0].status, 'ready');
});
test('Meta card generation sends only chapter evidence, asks for its language and validates returned quotes', async () => {
  let called = false;
  const result = await generateCards(
    'test-placeholder',
    'test-model',
    { ...learning, locale: 'es' },
    'first',
    async (_url, options) => {
      called = true;
      const body = JSON.parse(options.body as string),
        context = JSON.parse(body.messages[1].content);
      assert.match(body.messages[0].content, /Spanish/);
      assert.equal(context.segments.length, 1);
      assert.equal(context.segments[0].id, 'interval');
      assert.equal(body.response_format.json_schema.strict, true);
      return Response.json({ choices: [{ message: { content: JSON.stringify(plan()) } }] });
    },
  );
  assert.equal(called, true);
  assert.equal(result.cards.length, 3);
});

test('a late rating response cannot advance a recovered review queue twice', () => {
  const id = crypto.randomUUID(),
    next = crypto.randomUUID(),
    requestId = crypto.randomUUID(),
    deckId = crypto.randomUUID();
  const draft: CardDraft = {
    queue: [id, next],
    done: 0,
    revealed: true,
    conflict: false,
    operation: { requestId, deckId, cardId: id, grade: 'good', expectedRevision: 0 },
  };
  const review = {
    id: requestId,
    deckId,
    cardId: id,
    grade: 'good' as const,
    expectedRevision: 0,
    schedule: scheduleCard(null, 'good'),
    createdAt: new Date().toISOString(),
  };
  const completed = completeCardDraft(draft, review);
  assert.deepEqual(completed.queue, [next]);
  assert.equal(completed.done, 1);
  assert.deepEqual(completeCardDraft(completed, review), completed);
  const again = completeCardDraft(
    { ...draft, operation: { ...draft.operation!, grade: 'again' } },
    { ...review, grade: 'again' },
  );
  assert.deepEqual(again.queue, [next, id]);
  assert.equal(again.done, 0);
});
