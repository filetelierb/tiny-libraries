import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTutorAgent,
  type TutorAgentInput,
  type TutorAgentCheckpoint,
  type BookmarkWriter,
} from '../worker/tutor-agent';
import type { CompletionMessage } from '../shared/tutor-transport';
import type { Learning } from '../shared/domain';

const sourceId = '8b3e207a-cfb4-4e24-bc84-cfb4d584ab60';
const input: TutorAgentInput = {
  model: 'muse-spark-1.3',
  reasoningEffort: 'low',
  prompt: 'Read this and bookmark the sampling statement.',
  history: [],
  learning: [
    {
      sourceId,
      sourceVersion: 1,
      model: 'muse-spark-1.3',
      locale: 'en',
      createdAt: '2026-10-27',
      segments: [{ id: 'section-1', text: 'Sampling frequency counts samples per second.' }],
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
  canCreateBookmark: true,
};
const call = (id: string, name: string, args: unknown) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: JSON.stringify(args) },
});
const read = call('read', 'read_segments', { ids: [`${sourceId}:section-1`, 'another:section-1'] });
const bookmark = call('save', 'create_bookmark', {
  segmentId: `${sourceId}:section-1`,
  label: 'Sampling',
});
const roundTrip = (value: TutorAgentCheckpoint): TutorAgentCheckpoint =>
  JSON.parse(JSON.stringify(value));

test('tool checkpoints retain scope, evidence and cursor without repeating a completed write', async () => {
  const agent = await createTutorAgent(input);
  let writes = 0;
  agent.acceptCompletion({ content: null, tool_calls: [read, bookmark] });
  assert.throws(() => agent.request(), /checkpoint/);
  const first = await agent.executeNextTool();
  assert.equal((first?.output as unknown[]).length, 1);
  const saved = roundTrip(agent.snapshot());
  assert.equal(saved.pending?.next, 1);
  const resumed = await createTutorAgent(input, saved);
  assert.equal(resumed.nextToolName, 'create_bookmark');
  await resumed.executeNextTool(async (value) => {
    writes++;
    assert.equal(value.sourceId, sourceId);
    return { id: 'saved' };
  });
  const after = roundTrip(resumed.snapshot());
  const completed = await createTutorAgent(input, after);
  assert.equal(completed.hasPendingTools, false);
  assert.equal(
    await completed.executeNextTool(async () => {
      assert.fail('Repeated completed write');
    }),
    null,
  );
  completed.acceptCompletion({
    content: `Frequency counts samples per second [${sourceId}:section-1].`,
  });
  assert.equal(writes, 1);
  assert.equal(completed.result?.citations.length, 1);
  assert.deepEqual(completed.result?.tools, ['read_segments', 'create_bookmark']);
  const restored = await createTutorAgent(input, roundTrip(completed.snapshot()));
  assert.deepEqual(restored.result, completed.result);
  assert.throws(() => restored.acceptCompletion({ content: 'Duplicate' }), /already accepted/);
});

test('the side-effect-before-checkpoint retry window uses the same tool receipt', async () => {
  const receipts = new Map<string, unknown>();
  let writes = 0,
    invocations = 0;
  const writer: BookmarkWriter = async (value) => {
    invocations++;
    const identity = `${value.sourceId}:${value.sourceVersion}:${value.segment.id}`;
    if (receipts.has(identity)) return receipts.get(identity);
    writes++;
    const saved = { id: 'one-bookmark' };
    receipts.set(identity, saved);
    return saved;
  };
  const agent = await createTutorAgent(input);
  agent.acceptCompletion({ tool_calls: [bookmark] });
  const beforeEffect = roundTrip(agent.snapshot());
  await agent.executeNextTool(writer);
  // Simulate a process loss after the receipt committed but before the tool cursor did.
  const recovered = await createTutorAgent(input, beforeEffect);
  await recovered.executeNextTool(writer);
  assert.equal(invocations, 2);
  assert.equal(writes, 1);
  assert.deepEqual(recovered.snapshot().bookmarks, [`${sourceId}:section-1`]);
});

test('steering at a checkpoint supersedes proposed tools and preserves active context/generation', async () => {
  const agent = await createTutorAgent(input);
  agent.acceptCompletion({ tool_calls: [read, bookmark] });
  await agent.executeNextTool();
  const id = crypto.randomUUID();
  agent.steer(id, 'Explain only; do not save a bookmark.');
  assert.equal(agent.hasPendingTools, false);
  const saved = roundTrip(agent.snapshot()),
    resumed = await createTutorAgent(input, saved);
  resumed.steer(id, 'Explain only; do not save a bookmark.');
  assert.equal(resumed.snapshot().messages.length, saved.messages.length);
  const request = resumed.request();
  assert.equal(request.model, 'muse-spark-1.3');
  assert.equal(request.reasoning_effort, 'low');
  assert.equal(request.messages.at(-1)?.role, 'user');
  const skipped = request.messages.find((m) => m.tool_call_id === 'save');
  assert.match(String(skipped?.content), /Skipped after/);
  resumed.acceptCompletion({ content: `Samples per second [${sourceId}:section-1].` });
  assert.deepEqual(resumed.result?.tools, ['read_segments']);
  assert.equal(resumed.result?.citations.length, 1);
  resumed.steer(crypto.randomUUID(), 'Add one more sentence.');
  assert.equal(resumed.result, undefined);
  assert.equal(resumed.request().messages.at(-1)?.role, 'user');
});

test('checkpoints reject changed inputs and corrupt cursors; unavailable writes stay forbidden', async () => {
  const agent = await createTutorAgent(input),
    saved = roundTrip(agent.snapshot());
  for (const next of [
    { ...input, prompt: 'Different' },
    { ...input, reasoningEffort: 'high' as const },
    { ...input, learning: null },
    { ...input, canCreateBookmark: false },
  ])
    await assert.rejects(createTutorAgent(next, saved), /different question context/);
  const noWrites = await createTutorAgent({ ...input, canCreateBookmark: false });
  noWrites.acceptCompletion({ tool_calls: [bookmark] });
  const output = await noWrites.executeNextTool(async () => {
    assert.fail('Unadvertised write executed');
  });
  assert.match(JSON.stringify(output?.output), /not permitted/);
  agent.acceptCompletion({ tool_calls: [read] });
  const corrupt = roundTrip(agent.snapshot());
  corrupt.pending!.next = 7;
  await assert.rejects(createTutorAgent(input, corrupt), /checkpoint cursor/);
});

test('malformed tool arguments return a recoverable tool error without losing other checkpoints', async () => {
  const agent = await createTutorAgent(input);
  const malformed: CompletionMessage = {
    tool_calls: [
      { ...read, id: 'invalid', function: { name: 'read_segments', arguments: '{' } },
      read,
    ],
  };
  agent.acceptCompletion(malformed);
  const failed = await agent.executeNextTool();
  assert.match(JSON.stringify(failed?.output), /Invalid tool arguments/);
  const resumed = await createTutorAgent(input, roundTrip(agent.snapshot()));
  await resumed.executeNextTool();
  resumed.acceptCompletion({ content: `Count samples [${sourceId}:section-1].` });
  assert.equal(resumed.result?.citations.length, 1);
  const copy = resumed.snapshot();
  copy.messages[0].content = 'Changed exported snapshot';
  assert.notEqual(resumed.snapshot().messages[0].content, copy.messages[0].content);
});

test('the model-step bound retains the last completed result when a later instruction cannot enter', async () => {
  const agent = await createTutorAgent(input);
  for (let i = 0; i < 19; i++) {
    agent.acceptCompletion({ tool_calls: [{ ...read, id: `read-${i}` }] });
    await agent.executeNextTool();
  }
  agent.acceptCompletion({ content: `Retained answer [${sourceId}:section-1].` });
  const result = structuredClone(agent.result);
  assert.throws(() => agent.steer(crypto.randomUUID(), 'One more instruction'), /model-step limit/);
  assert.deepEqual(agent.result, result);
  const saved = await createTutorAgent(input, roundTrip(agent.snapshot()));
  assert.deepEqual(saved.result, result);
});

test('the tutor saves one artifact version for a selected source', async () => {
  const [material] = input.learning as Learning[];
  const withArtifact: TutorAgentInput = {
    ...input,
    canSaveArtifact: true,
    learning: [
      {
        ...material,
        synthesis: {
          ...material.synthesis,
          artifact: {
            kind: 'signal',
            title: 'Aliasing',
            explanation: 'Old text.',
            segmentIds: ['section-1'],
            frequency: 8,
            sampling: 12,
            amplitude: 0.8,
          },
        },
      },
    ],
  };
  const agent = await createTutorAgent(withArtifact);
  assert.ok(
    JSON.stringify(agent.request().tools).includes('save_artifact'),
    'the tool is offered when a selected source has an artifact',
  );
  const markdown = `## Sampling\n\n\`\`\`widget\n{"type":"summary","points":[{"text":"Twice f","segmentId":"${sourceId}:section-1"}]}\n\`\`\``;
  agent.acceptCompletion({
    content: null,
    tool_calls: [
      call('one', 'save_artifact', { sourceId, title: 'Aliasing, rewritten', markdown }),
      call('two', 'save_artifact', { sourceId: 'elsewhere', title: 'x', markdown: 'y' }),
    ],
  });
  const writes: unknown[] = [];
  const writer = async (value: unknown) => {
    writes.push(value);
    return { saved: true, revision: 2 };
  };
  await agent.executeNextTool(undefined, writer);
  const second = await agent.executeNextTool(undefined, writer);
  assert.deepEqual(writes, [
    {
      sourceId,
      title: 'Aliasing, rewritten',
      markdown,
    },
  ]);
  assert.deepEqual(second?.output, { error: 'Only one artifact version can be saved per reply' });
  const withoutTool = await createTutorAgent({ ...withArtifact, canSaveArtifact: false });
  assert.ok(!JSON.stringify(withoutTool.request().tools).includes('save_artifact'));
});
