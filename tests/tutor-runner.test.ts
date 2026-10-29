import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TutorRunner,
  type FrozenTutorContext,
  type TutorRunnerServices,
} from '../worker/tutor-runner';
import { TutorJournal, type JournalObjects } from '../worker/tutor-journal';
import {
  tutorFingerprint,
  turnInputFingerprint,
  type TurnIntent,
  type TurnAction,
  type TurnRecord,
} from '../shared/tutor-turns';
import type {
  TransportSnapshot,
  TutorCompletion,
  CompletionMessage,
} from '../shared/tutor-transport';
import type { Conversation } from '../shared/conversations';
import { MemoryStore } from './storage';
import { tutorMcp } from '../worker/tutor-mcp';

class Storage extends MemoryStore {
  async setAlarm(time: number | Date) {
    await this.put('test-alarm', Number(time));
  }
  async deleteAlarm() {
    await this.delete('test-alarm');
  }
}
class Objects implements JournalObjects {
  data = new Map<string, string>();
  failNext = false;
  async read(key: string) {
    return this.data.get(key) ?? null;
  }
  async write(key: string, text: string) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('Synthetic loss before checkpoint publication');
    }
    this.data.set(key, text);
  }
}
const sourceId = '8b3e207a-cfb4-4e24-bc84-cfb4d584ab60';
const frozen: FrozenTutorContext = {
  model: 'muse-spark-1.3',
  reasoningEffort: 'minimal',
  canCreateBookmark: true,
  learning: [
    {
      sourceId,
      sourceVersion: 1,
      model: 'muse-spark-1.3',
      locale: 'en',
      createdAt: '2026-10-27',
      segments: [{ id: 's1', text: 'Sampling frequency counts samples per second.' }],
      synthesis: { title: 'Sampling', chapters: [], glossary: [], artifact: null },
    },
  ],
  review: {
    count: 0,
    correct: 0,
    percent: null,
    needsPractice: [],
    evidence: 'Recorded attempts only',
  },
};
const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
async function fixture(options: { muse?: boolean } = {}) {
  const storage = new Storage(),
    objects = new Objects();
  const conversation: Conversation = {
    id: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    name: 'Synthetic runner study',
    sourceIds: [sourceId],
    messages: [
      { role: 'user', content: 'Earlier study question' },
      { role: 'assistant', content: 'Earlier study answer' },
    ],
    createdAt: '2026-10-27',
    updatedAt: '2026-10-27',
  };
  const journal = new TutorJournal(storage, objects, conversation.id);
  await journal.seed(conversation);
  const contextObject = await journal.objects.put(frozen);
  const intent = (prompt = 'Read and bookmark the sampling statement.'): TurnIntent => {
    const requestId = crypto.randomUUID();
    return {
      input: { requestId, prompt, concepts: [], attachments: [] },
      userMessage: { role: 'user', content: prompt, requestId, sourceIds: [sourceId] },
      generation: { model: 'muse-spark-1.3', reasoningEffort: 'minimal' },
      contextObject,
      scope: {
        references: [{ id: sourceId, version: 1, prepared: contextObject }],
        concepts: [],
        attachments: [],
      },
    };
  };
  const accepted: Array<{ id: string; body: TutorCompletion }> = [],
    snapshots = new Map<string, TransportSnapshot>();
  const receipts = new Set<string>();
  let writes = 0,
    loseStart = false,
    loseCheckpoint = false;
  const services: TutorRunnerServices = {
    get: async (id) => structuredClone(snapshots.get(id) || null),
    start: async (id, body) => {
      if (snapshots.has(id)) return snapshots.get(id)!;
      accepted.push({ id, body: structuredClone(body) });
      const value: TransportSnapshot = {
        id,
        fingerprint: await tutorFingerprint(body),
        status: 'running',
        sequence: 1,
        text: 'Visible saved tokens',
        toolNames: [],
        createdAt: '2026-10-27',
        updatedAt: '2026-10-27',
      };
      snapshots.set(id, value);
      if (loseStart) {
        loseStart = false;
        throw new Error('Synthetic lost POST acknowledgement');
      }
      return value;
    },
    cancel: async (id) => {
      const previous = snapshots.get(id);
      const value: TransportSnapshot = {
        id,
        fingerprint: id,
        status: 'cancelled',
        sequence: (previous?.sequence || 0) + 1,
        text: previous?.text || '',
        toolNames: [],
        createdAt: '2026-10-27',
        updatedAt: '2026-10-27',
      };
      snapshots.set(id, value);
      return value;
    },
    bookmark: async (record, _intent, value) => {
      const receipt = `${record.id}:r${record.intentRevision}:${value.segment.id}`;
      if (!receipts.has(receipt)) {
        receipts.add(receipt);
        writes++;
      }
      if (loseCheckpoint) {
        loseCheckpoint = false;
        objects.failNext = true;
      }
      return { id: 'saved-bookmark', label: value.label, location: { quote: value.segment.text } };
    },
    ...(options.muse
      ? {
          muse: async (id: string) => ({
            url: `http://127.0.0.1:9876/api/tutor-tools/${conversation.id}/${id}`,
            token: 'a'.repeat(64),
          }),
        }
      : {}),
  };
  const accept = async (value = intent()) =>
    journal.accept(value, await turnInputFingerprint(value.input));
  const action = (record: TurnRecord, name: TurnAction['action']) =>
    journal.action(record.id, {
      operationId: crypto.randomUUID(),
      revision: record.revision,
      action: name,
    });
  const step = () =>
    new TutorRunner(new TutorJournal(storage, objects, conversation.id), services).step();
  const model = async () => {
    for (let n = 0; n < 12; n++) {
      const record = await journal.active();
      if (record?.providerStart === 'accepted') return record;
      await step();
    }
    assert.fail('Runner did not reach an accepted model request');
  };
  const complete = (record: TurnRecord, result: CompletionMessage) => {
    const previous = snapshots.get(record.providerId!)!;
    snapshots.set(record.providerId!, {
      ...previous,
      status: 'completed',
      sequence: previous.sequence + 1,
      text: result.content || '',
      result,
    });
  };
  return {
    journal,
    storage,
    objects,
    services,
    conversation,
    intent,
    accept,
    action,
    step,
    model,
    complete,
    accepted,
    snapshots,
    writes: () => writes,
    loseStart: () => {
      loseStart = true;
    },
    loseCheckpoint: () => {
      loseCheckpoint = true;
    },
  };
}

test('short steps restore input, actual partial progress and individual tools without duplicate inference or history', async () => {
  const f = await fixture(),
    accepted = await f.accept();
  const running = await f.model();
  assert.equal(f.accepted.length, 1);
  assert.equal((await f.journal.snapshot())!.runState.active!.partial, 'Visible saved tokens');
  const sequence = (await f.journal.snapshot())!.runState.sequence;
  await f.step();
  await f.step();
  assert.equal(f.accepted.length, 1);
  assert.equal((await f.journal.snapshot())!.runState.sequence, sequence);
  f.complete(running, {
    tool_calls: [
      call('read', 'read_segments', { ids: [`${sourceId}:s1`] }),
      call('save', 'create_bookmark', { segmentId: `${sourceId}:s1`, label: 'Sampling frequency' }),
    ],
  });
  await f.step();
  await f.step();
  assert.equal(f.writes(), 0);
  await f.step();
  assert.equal(f.writes(), 1);
  const last = await f.model();
  assert.equal(f.accepted.length, 2);
  const body = f.accepted[1].body;
  assert.equal(body.model, 'muse-spark-1.3');
  assert.equal(body.reasoning_effort, 'minimal');
  assert.ok(JSON.stringify(body.messages).includes('Earlier study answer'));
  f.complete(last, { content: `Samples per second [${sourceId}:s1].` });
  await f.step();
  await f.step();
  await f.step();
  const saved = await f.journal.get(accepted.id);
  assert.equal(saved!.status, 'completed');
  assert.equal(f.writes(), 1);
  const page = await f.journal.history();
  assert.equal(page.messageCount, 4);
  assert.deepEqual(page.messages.slice(0, 2), f.conversation.messages);
  assert.equal(page.messages.at(-1)!.citations!.length, 1);
  await f.journal.schedule();
  assert.equal(await f.storage.get('test-alarm'), undefined);
});

test('a lost start acknowledgement reconciles its stable handle without resubmission', async () => {
  const f = await fixture();
  await f.accept();
  f.loseStart();
  const running = await f.model();
  assert.equal(f.accepted.length, 1);
  assert.equal(running.status, 'running');
  f.complete(running, { content: 'Recovered completed reply.' });
  await f.step();
  await f.step();
  assert.equal((await f.journal.history()).messages.at(-1)!.content, 'Recovered completed reply.');
  assert.equal(f.accepted.length, 1);
});

test('a queued generation edit changes the actual request while retaining the frozen reference context', async () => {
  const f = await fixture(),
    accepted = await f.accept();
  await f.journal.action(accepted.id, {
    operationId: crypto.randomUUID(),
    revision: accepted.revision,
    action: 'save',
    prompt: 'Edited queued question',
    generation: { model: 'muse-wonder-1.0', reasoningEffort: 'high' },
  });
  const running = await f.model(),
    request = f.accepted[0].body;
  assert.equal(request.model, 'muse-wonder-1.0');
  assert.equal(request.reasoning_effort, 'high');
  assert.match(JSON.stringify(request.messages), /Edited queued question/);
  assert.match(JSON.stringify(request.messages), /Sampling frequency counts samples per second/);
  f.complete(running, { content: 'Edited choice retained.' });
  await f.step();
  await f.step();
  const messages = (await f.journal.history()).messages;
  assert.equal(messages.at(-2)!.generation!.model, 'muse-wonder-1.0');
  assert.equal(messages.at(-1)!.generation!.reasoningEffort, 'high');
});

test('loss after a bookmark effect but before checkpoint publication retains its receipt across explicit retry', async () => {
  const f = await fixture(),
    first = await f.accept();
  const model = await f.model();
  f.complete(model, {
    tool_calls: [
      call('save', 'create_bookmark', { segmentId: `${sourceId}:s1`, label: 'Sampling' }),
    ],
  });
  await f.step();
  f.loseCheckpoint();
  await f.step();
  const failed = (await f.journal.get(first.id))!;
  assert.equal(failed.status, 'interrupted');
  assert.equal(f.writes(), 1);
  assert.equal((await f.journal.attempts(first.id)).items.length, 1);
  await f.action(failed, 'retry');
  await f.step();
  assert.equal(f.writes(), 1);
  const retry = await f.model();
  assert.equal(retry.attempt, 2);
  assert.equal(retry.intentRevision, first.intentRevision);
  f.complete(retry, { content: 'Saved once.' });
  await f.step();
  await f.step();
  assert.equal((await f.journal.get(first.id))!.status, 'completed');
  assert.equal(f.writes(), 1);
});

test('Stop retains real partial output and advances later queued work independently', async () => {
  const f = await fixture(),
    first = await f.accept(),
    running = await f.model();
  const next = await f.accept(f.intent('Next question'));
  await f.action(running, 'stop');
  await f.step();
  assert.equal((await f.journal.get(first.id))!.status, 'stopped');
  assert.equal((await f.journal.history()).messages.at(-1)!.content, 'Visible saved tokens');
  assert.equal((await f.journal.history()).messages.at(-1)!.status, 'stopped');
  assert.equal(f.snapshots.get(running.providerId!)!.status, 'cancelled');
  await f.step();
  assert.equal((await f.journal.active())!.id, next.id);
});

test('explicit retry retires an uncertain provider handle before starting a new attempt', async () => {
  const f = await fixture();
  await f.accept();
  const running = await f.model();
  f.snapshots.delete(running.providerId!);
  await f.step();
  const interrupted = (await f.journal.get(running.id))!;
  assert.equal(interrupted.status, 'interrupted');
  await f.action(interrupted, 'retry');
  await f.step();
  assert.equal(f.snapshots.get(running.providerId!)!.status, 'cancelled');
  const next = await f.model();
  assert.equal(next.attempt, 2);
  assert.notEqual(next.providerId, running.providerId);
  assert.equal(f.accepted.length, 2);
});

test('compatible steering cancels a live model, checkpoints its instruction and retains active generation', async () => {
  const f = await fixture();
  await f.accept();
  const running = await f.model();
  const intent = f.intent('Explain only, do not save anything.');
  intent.generation = { model: 'muse-wonder-1.0', reasoningEffort: 'high' };
  const queued = await f.accept(intent);
  await f.action(queued, 'steer');
  await f.step();
  assert.equal((await f.journal.get(queued.id))!.status, 'steered');
  assert.equal(f.snapshots.get(running.providerId!)!.status, 'cancelled');
  const redirected = await f.model();
  assert.notEqual(redirected.providerId, running.providerId);
  const request = f.accepted.at(-1)!.body;
  assert.equal(request.model, 'muse-spark-1.3');
  assert.equal(request.reasoning_effort, 'minimal');
  assert.match(JSON.stringify(request.messages.at(-1)), /Explain only/);
  f.complete(redirected, { content: 'Short redirected explanation.' });
  await f.step();
  await f.step();
  assert.equal(f.writes(), 0);
  assert.equal(
    (await f.journal.history()).messages.filter((m) => m.content === intent.input.prompt).length,
    1,
  );
});

test('a completed reply stores its study note suggestion apart from the visible answer', async () => {
  const f = await fixture();
  await f.accept();
  const running = await f.model();
  f.complete(running, {
    content:
      'Sampling needs twice the frequency.\n<study_note>{"recommended":true,"category":"concept","body":"Sample above twice the highest frequency."}</study_note>',
  });
  await f.step();
  await f.step();
  const last = (await f.journal.history()).messages.at(-1)!;
  assert.equal(last.content, 'Sampling needs twice the frequency.');
  assert.deepEqual(last.noteSuggestion, {
    recommended: true,
    category: 'concept',
    body: 'Sample above twice the highest frequency.',
  });
});

test('an agent host calls the tools during its model step and the answer cites only what it read', async () => {
  const f = await fixture({ muse: true }),
    accepted = await f.accept();
  const running = await f.model();
  const body = f.accepted[0].body;
  assert.equal(body.muse?.url.endsWith(`/${running.providerId}`), true);
  const rpc = (method: string, params?: unknown, providerId = running.providerId!) =>
    tutorMcp(new TutorJournal(f.storage, f.objects, f.conversation.id), f.services, providerId, {
      jsonrpc: '2.0',
      id: 1,
      method,
      params: params as never,
    }) as Promise<{
      result: {
        tools?: Array<{ name: string; annotations: unknown }>;
        content?: Array<{ text: string }>;
        isError?: boolean;
      };
    }>;
  const listed = (await rpc('tools/list')).result.tools!;
  assert.deepEqual(listed.find((tool) => tool.name === 'read_segments')?.annotations, {
    readOnlyHint: true,
  });
  assert.deepEqual(listed.find((tool) => tool.name === 'create_bookmark')?.annotations, {
    readOnlyHint: false,
  });
  const read = (
    await rpc('tools/call', { name: 'read_segments', arguments: { ids: [`${sourceId}:s1`] } })
  ).result;
  assert.equal(read.isError, false);
  assert.match(read.content![0].text, /Sampling frequency/);
  const saved = (
    await rpc('tools/call', {
      name: 'create_bookmark',
      arguments: { segmentId: `${sourceId}:s1`, label: 'Sampling frequency' },
    })
  ).result;
  assert.equal(saved.isError, false);
  assert.equal(f.writes(), 1);
  const other = (
    await rpc('tools/call', { name: 'read_segments', arguments: { ids: [] } }, 'f'.repeat(64))
  ).result;
  assert.equal(other.isError, true);
  assert.deepEqual((await f.journal.active())!.toolNames, ['read_segments', 'create_bookmark']);
  f.complete((await f.journal.active())!, {
    content: `Samples per second [${sourceId}:s1], not [${sourceId}:s9].`,
  });
  for (let n = 0; n < 4; n++) await f.step();
  const done = await f.journal.get(accepted.id);
  assert.equal(done!.status, 'completed');
  assert.equal(f.accepted.length, 1, 'the agent host ran the whole reply in one model step');
  const answer = (await f.journal.history()).messages.at(-1)!;
  assert.deepEqual(
    answer.citations!.map((c) => c.id),
    [`${sourceId}:s1`],
  );
  assert.deepEqual(answer.tools, ['read_segments', 'create_bookmark']);
});
