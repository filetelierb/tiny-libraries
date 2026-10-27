import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TutorJournal,
  TutorObjects,
  TutorJournalError,
  type JournalObjects,
} from '../worker/tutor-journal';
import {
  tutorFingerprint,
  turnInputFingerprint,
  type TurnIntent,
  type TurnAction,
} from '../shared/tutor-turns';
import type { Conversation } from '../shared/conversations';
import { MemoryStore } from './storage';

class JournalStore extends MemoryStore {
  async setAlarm(time: number | Date) {
    await this.put('test-alarm', Number(time));
  }
  async deleteAlarm() {
    await this.delete('test-alarm');
  }
}
class Objects implements JournalObjects {
  data = new Map<string, string>();
  fail = false;
  async read(key: string) {
    return this.data.get(key) ?? null;
  }
  async write(key: string, text: string) {
    if (this.fail) throw new Error('Synthetic object storage failure');
    this.data.set(key, text);
  }
}
const generation = { model: 'muse-spark-1.3' as const, reasoningEffort: 'minimal' as const };
const createConversation = (): Conversation => ({
  id: crypto.randomUUID(),
  sessionId: crypto.randomUUID(),
  name: 'Synthetic journal study',
  sourceIds: [],
  messages: [
    { role: 'user', content: 'Preserved question' },
    { role: 'assistant', content: 'Preserved answer' },
  ],
  createdAt: '2026-10-27',
  updatedAt: '2026-10-27',
});
async function fixture() {
  const storage = new JournalStore(),
    objects = new Objects(),
    conversation = createConversation();
  const journal = new TutorJournal(storage, objects, conversation.id);
  const contextObject = await journal.objects.put({ synthetic: 'Immutable accepted context' });
  const intent = (prompt = 'Explain sampling'): TurnIntent => {
    const requestId = crypto.randomUUID();
    return {
      input: { requestId, prompt, concepts: [], attachments: [] },
      userMessage: { role: 'user', requestId, content: prompt },
      generation,
      contextObject,
      scope: { references: [], concepts: [], attachments: [] },
    };
  };
  await journal.seed(conversation);
  const accept = async (value = intent()) =>
    journal.accept(value, await turnInputFingerprint(value.input));
  const action = (
    revision: number,
    name: TurnAction['action'],
    extra: Partial<TurnAction> = {},
  ): TurnAction => ({
    operationId: crypto.randomUUID(),
    revision,
    action: name,
    ...extra,
  });
  return { storage, objects, conversation, journal, intent, accept, action };
}

test('acceptance freezes input, receipts, queue order and a wakeup independently of a caller', async () => {
  const f = await fixture(),
    input = f.intent(),
    fingerprint = await turnInputFingerprint(input.input);
  const accepted = await Promise.all(
    Array.from({ length: 8 }, () => f.journal.accept(input, fingerprint)),
  );
  assert.ok(accepted.every((r) => r.ordinal === 1 && r.id === input.input.requestId));
  assert.ok(await f.storage.get('test-alarm'));
  assert.equal((await f.journal.snapshot())!.runState.outbox.length, 1);
  assert.equal((await f.journal.history()).messageCount, 2);
  input.input.prompt = 'Changed client draft';
  assert.equal((await f.journal.intent(accepted[0])).input.prompt, 'Explain sampling');
  await assert.rejects(
    f.journal.accept(input, await turnInputFingerprint(input.input)),
    /request ID/,
  );
  const restored = new TutorJournal(f.storage, f.objects, f.conversation.id);
  assert.deepEqual(await restored.receipt(input.input.requestId, fingerprint), accepted[0]);
  await restored.seed({ ...f.conversation, messages: [] });
  assert.deepEqual((await restored.history()).messages, f.conversation.messages);
  const failures = f.intent();
  f.objects.fail = true;
  await assert.rejects(f.accept(failures), /storage failure/);
  assert.equal(await f.journal.get(failures.input.requestId), undefined);
  assert.equal((await f.journal.turns()).items.length, 1);
});

test('immutable objects are bounded, conversation-scoped and verified before recovery', async () => {
  const f = await fixture();
  const key = await f.journal.objects.put({ text: '字'.repeat(90000) });
  assert.ok((f.objects.data.get(key) || '').length > 80000);
  assert.deepEqual(await f.journal.objects.get(key), { text: '字'.repeat(90000) });
  const other = new TutorObjects(f.objects, crypto.randomUUID());
  await assert.rejects(other.get(key), /Invalid saved/);
  f.objects.data.set(key, '{"text":"tampered"}');
  await assert.rejects(f.journal.objects.get(key), /integrity/);
  await assert.rejects(
    f.journal.objects.put({ text: 'x'.repeat(33 * 1024 * 1024) }),
    (e: unknown) => e instanceof TutorJournalError && e.status === 413,
  );
});

test('editing pauses FIFO, stale changes conflict and cancellation is recoverable', async () => {
  const f = await fixture(),
    first = await f.accept(),
    second = await f.accept(f.intent('Later question'));
  const edit = f.action(first.revision, 'edit');
  const editing = await f.journal.action(first.id, edit);
  assert.equal(await f.journal.claim(), null);
  assert.deepEqual(await f.journal.action(first.id, edit), editing);
  await assert.rejects(f.journal.action(first.id, { ...edit, action: 'cancel' }), /operation ID/);
  await assert.rejects(f.journal.action(first.id, f.action(first.revision, 'cancel')), /changed/);
  const saved = await f.journal.action(
    first.id,
    f.action(editing.revision, 'save', {
      prompt: 'Edited question',
      generation: { model: 'muse-wonder-1.0', reasoningEffort: 'high' },
    }),
  );
  assert.equal(saved.revision, 3);
  assert.equal((await f.journal.intent(saved)).input.prompt, 'Edited question');
  assert.equal((await f.journal.claim())!.id, first.id);
  const cancel = await f.journal.action(second.id, f.action(second.revision, 'cancel'));
  assert.equal(cancel.status, 'cancelled');
  assert.equal(
    (await f.journal.history()).messages.filter((m) => m.content === 'Later question').length,
    0,
  );
  const retry = await f.journal.action(cancel.id, f.action(cancel.revision, 'retry'));
  assert.equal(retry.status, 'queued');
  assert.equal((await f.journal.snapshot())!.runState.outbox[0].id, retry.id);
});

test('only one claim and completion publish, CAS retains Stop and retries retain earlier attempts', async () => {
  const f = await fixture(),
    first = await f.accept();
  const claims = await Promise.all(Array.from({ length: 5 }, () => f.journal.claim()));
  assert.ok(claims.every((r) => r!.id === first.id && r!.attempt === 1));
  assert.equal((await f.journal.history()).messageCount, 3);
  const running = claims[0]!;
  const checkpointObject = await f.journal.objects.put({ syntheticCheckpoint: 1 });
  const progressed = (await f.journal.progress(running, {
    partial: 'Actual saved tokens',
    checkpointObject,
  }))!;
  assert.equal(await f.journal.progress(running, { partial: 'Late stale result' }), null);
  await f.journal.action(first.id, f.action(progressed.revision, 'stop'));
  const afterStop = (await f.journal.progress(progressed, {
    partial: 'Retained tokens after control race',
  }))!;
  assert.equal(afterStop.stopRequested, true);
  assert.equal(
    await f.journal.finish(afterStop, 'completed', {
      role: 'assistant',
      content: 'Must not publish',
    }),
    null,
  );
  const stopped = (await f.journal.finish(afterStop, 'stopped', {
    role: 'assistant',
    content: afterStop.partial,
  }))!;
  assert.equal((await f.journal.history()).messages.at(-1)!.status, 'stopped');
  assert.equal((await f.journal.attempts(first.id)).items[0].partial, afterStop.partial);
  assert.equal(
    await f.journal.finish(afterStop, 'stopped', { role: 'assistant', content: afterStop.partial }),
    null,
  );
  await f.journal.action(stopped.id, f.action(stopped.revision, 'retry'));
  const retry = (await f.journal.claim())!;
  assert.equal(retry.attempt, 2);
  assert.equal(retry.checkpointObject, checkpointObject);
  const complete = { role: 'assistant' as const, content: 'Completed next attempt' };
  const outcomes = await Promise.all([
    f.journal.finish(retry, 'completed', complete),
    f.journal.finish(retry, 'completed', complete),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal((await f.journal.history()).messageCount, 6);
  assert.equal((await f.journal.attempts(first.id)).items.length, 2);
});

test('stopped work advances the queue; compatible steering keeps active generation and commits once', async () => {
  const f = await fixture(),
    first = await f.accept(),
    running = (await f.journal.claim())!;
  const nextIntent = f.intent('Use a shorter explanation');
  nextIntent.generation = { model: 'muse-wonder-1.0', reasoningEffort: 'high' };
  const next = await f.accept(nextIntent);
  assert.equal((await f.journal.snapshot())!.runState.outbox[0].canSteer, true);
  const steer = await f.journal.action(next.id, f.action(next.revision, 'steer'));
  assert.equal(steer.status, 'steering');
  assert.deepEqual(steer.effectiveGeneration, generation);
  const beforeApply = (await f.journal.active())!;
  const checkpoint = await f.journal.objects.put({ syntheticCheckpoint: 'steer' });
  const applied = (await f.journal.appliedSteering(beforeApply, next.id, checkpoint))!;
  assert.equal((await f.journal.get(next.id))!.status, 'steered');
  assert.equal((await f.journal.history()).messages.at(-1)!.content, nextIntent.input.prompt);
  assert.deepEqual((await f.journal.history()).messages.at(-1)!.generation, generation);
  assert.equal(await f.journal.appliedSteering(beforeApply, next.id, checkpoint), null);
  const third = await f.accept(f.intent('Keep this question'));
  await f.journal.action(third.id, f.action(third.revision, 'steer'));
  const stopped = await f.journal.action(first.id, f.action(applied.revision, 'stop'));
  await f.journal.finish(stopped, 'stopped');
  assert.equal((await f.journal.get(third.id))!.status, 'queued');
  assert.equal((await f.journal.claim())!.id, third.id);
  // A queued attachment cannot change the evidence scope of an active reply.
  const attached = f.intent('New attached material');
  attached.scope.attachments = [crypto.randomUUID()];
  const incompatible = await f.accept(attached);
  await assert.rejects(
    f.journal.action(incompatible.id, f.action(incompatible.revision, 'steer')),
    /cannot steer/,
  );
  assert.equal(running.id, first.id);
});

test('history grows beyond a single value without dropping messages and remains fully paginated', async () => {
  const f = await fixture();
  for (let n = 0; n < 61; n++) {
    await f.accept(f.intent(`Question ${n}`));
    const record = (await f.journal.claim())!;
    await f.journal.finish(record, 'completed', {
      role: 'assistant',
      content: `Answer ${n}: ` + '字'.repeat(8000),
    });
  }
  const all = [];
  let before: number | undefined;
  do {
    const page = await f.journal.history(before);
    all.unshift(...page.messages);
    before = page.historyCursor ? Number(page.historyCursor) : undefined;
    assert.equal(page.messageCount, 124);
    assert.ok(page.messages.length <= 50);
  } while (before);
  assert.equal(all.length, 124);
  assert.deepEqual(all.slice(0, 2), f.conversation.messages);
  assert.equal(all[2].content, 'Question 0');
  assert.match(all[123].content, /^Answer 60/);
  assert.equal((await f.journal.turns()).items[0].ordinal, 61);
  assert.equal((await f.journal.turns(42)).items[0].ordinal, 41);
  for (const [key, value] of f.storage.data) assert.ok(JSON.stringify(value).length < 120000, key);
  await assert.rejects(f.journal.history(0), /cursor/);
  await assert.rejects(f.journal.history(undefined, 51), /page size/);
  assert.equal((await f.journal.snapshot())!.latestPreview.length, 240);
});

test('acceptance does not exceed the queue bound and same-ID receipts stay valid after edits', async () => {
  const f = await fixture(),
    input = f.intent(),
    hash = await turnInputFingerprint(input.input);
  const first = await f.accept(input);
  for (let i = 1; i < 20; i++) await f.accept();
  await assert.rejects(f.accept(), /queue is full/);
  const saved = await f.journal.action(
    first.id,
    f.action(first.revision, 'save', { prompt: 'Edited queued input' }),
  );
  assert.equal((await f.journal.accept(input, hash)).revision, saved.revision);
  assert.equal((await f.journal.intent(saved)).input.prompt, 'Edited queued input');
  assert.notEqual(await tutorFingerprint({ ...input, contextObject: 'different' }), hash);
});

test('assessment context reaches earlier linked messages even when the latest page is unrelated', async () => {
  const f = await fixture(),
    selected = crypto.randomUUID(),
    unrelated = crypto.randomUUID();
  for (let n = 0; n < 45; n++) {
    const intent = f.intent(`Linked question ${n}`),
      sourceId = n < 12 ? selected : unrelated;
    intent.userMessage.sourceIds = [sourceId];
    await f.accept(intent);
    const record = (await f.journal.claim())!;
    await f.journal.finish(record, 'completed', {
      role: 'assistant',
      content: `Linked answer ${n}`,
      sourceIds: [sourceId],
    });
  }
  const latest = await f.journal.history();
  assert.ok(latest.messages.every((message) => message.sourceIds?.includes(unrelated)));
  const linked = (await f.journal.linkedMessages([selected], []))!;
  assert.equal(linked.messages.length, 20);
  assert.equal(linked.messages[0].content, 'Linked question 2');
  assert.equal(linked.messages.at(-1)!.content, 'Linked answer 11');
  assert.equal(linked.messageCount, 92);
  assert.deepEqual((await f.journal.linkedMessages([crypto.randomUUID()], []))!.messages, []);
});

test('steering history keeps its inherited passage and active source association', async () => {
  const f = await fixture(),
    intent = f.intent(),
    sourceId = crypto.randomUUID();
  const context = {
    sourceId,
    sourceVersion: 1,
    sourceName: 'Selected passage.md',
    location: { quote: 'Frozen passage' },
  };
  intent.userMessage.context = context;
  intent.userMessage.sourceIds = [sourceId];
  intent.scope.context = context;
  intent.scope.references = [{ id: sourceId, version: 1, prepared: 'prepared' }];
  intent.scope.permanentReferences = [];
  await f.accept(intent);
  const running = (await f.journal.claim())!;
  const next = f.intent('Explain that passage more briefly');
  next.scope.permanentReferences = [];
  const child = await f.accept(next);
  await f.journal.action(child.id, f.action(child.revision, 'steer'));
  await f.journal.appliedSteering(
    (await f.journal.active())!,
    child.id,
    await f.journal.objects.put({ checkpoint: 'inherited' }),
  );
  const message = (await f.journal.history()).messages.at(-1)!;
  assert.deepEqual(message.context, context);
  assert.deepEqual(message.sourceIds, [sourceId]);
  assert.equal(message.turnKind, 'steering');
  assert.equal((await f.journal.active())!.id, running.id);
});

test('applied steering counts toward the admission limit without discarding the next queued question', async () => {
  const f = await fixture();
  await f.accept();
  await f.journal.claim();
  for (let n = 0; n < 20; n++) {
    const child = await f.accept(f.intent(`Instruction ${n}`));
    await f.journal.action(child.id, f.action(child.revision, 'steer'));
    const current = (await f.journal.active())!;
    await f.journal.appliedSteering(
      current,
      child.id,
      await f.journal.objects.put({ checkpoint: n }),
    );
  }
  const next = await f.accept(f.intent('Keep this question queued'));
  assert.equal((await f.journal.active())!.appliedSteers, 20);
  assert.equal((await f.journal.view(next, await f.journal.active())).canSteer, false);
  await assert.rejects(f.journal.action(next.id, f.action(next.revision, 'steer')), /cannot steer/);
  assert.equal((await f.journal.get(next.id))!.status, 'queued');
});
