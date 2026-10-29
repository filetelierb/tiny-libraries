import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { museInput, type MuseEngine, type MuseTurnOptions } from '../server/muse';
import { TutorTransport } from '../server/tutor-transport';
import type { TransportSnapshot, TutorCompletion } from '../shared/tutor-transport';

const identity = (value: string) => createHash('sha256').update(value).digest('hex');
const credential = 'not-a-real-Meta-key';
const request: TutorCompletion = {
  model: 'muse-spark-1.3',
  messages: [
    { role: 'system', content: 'Cite evidence as [segment-id].' },
    { role: 'user', content: 'Earlier question' },
    { role: 'assistant', content: 'Earlier answer' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What does the figure show?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
      ],
    },
  ],
  tools: [{ type: 'function', function: { name: 'read_segments', parameters: {} } }],
  reasoning_effort: 'low',
  muse: { url: 'http://127.0.0.1:9876/api/tutor-tools/x/y', token: 'a'.repeat(64) },
};
async function waitFor(
  manager: TutorTransport,
  id: string,
  predicate: (value: TransportSnapshot) => boolean,
) {
  const deadline = Date.now() + 4000;
  let value: TransportSnapshot | null = null;
  while (Date.now() < deadline) {
    value = await manager.get(id);
    if (value && predicate(value)) return value;
    await delay(3);
  }
  assert.fail(`Reply did not reach expected state: ${value?.status}`);
}
function engine(available = true) {
  const runs: MuseTurnOptions[] = [];
  let finish!: (text: string) => void;
  const value: MuseEngine = {
    available: async () => available,
    run: (_id, options) => {
      runs.push(options);
      return new Promise((resolve, reject) => {
        finish = resolve;
        options.signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
  return { value, runs, finish: (text: string) => finish(text) };
}

test('the agent sees the instructions, the conversation, the question and its images', () => {
  const [text, image] = museInput(request);
  assert.equal(text.type, 'text');
  const prompt = (text as { text: string }).text;
  assert.match(prompt, /<tutor_instructions>\nCite evidence/);
  assert.match(prompt, /Student:\nEarlier question\n\nTutor:\nEarlier answer/);
  assert.match(prompt, /<question>\nWhat does the figure show\?\n<\/question>$/);
  assert.deepEqual(image, { type: 'image', mediaType: 'image/png', base64Data: 'iVBORw0KGgo=' });
});

test('a reply runs as an agent turn, relays its text and completes with the answer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tutor-muse-')),
    id = identity('muse-reply'),
    host = engine();
  const manager = new TutorTransport(
    root,
    async () => assert.fail('An agent reply never calls the model directly'),
    undefined,
    host.value,
  );
  t.after(async () => {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  await manager.start(id, credential, request);
  await waitFor(manager, id, (value) => value.status === 'running');
  assert.equal(host.runs[0].credential, credential);
  host.runs[0].onText('Looking at the figure');
  await waitFor(manager, id, (value) => value.text === 'Looking at the figure');
  host.finish('It shows aliasing [s1].');
  const done = await waitFor(manager, id, (value) => value.status === 'completed');
  assert.deepEqual(done.result, { content: 'It shows aliasing [s1].' });
  assert.deepEqual(done.toolNames, []);
});

test('Stop ends the agent turn and keeps its partial text', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tutor-muse-stop-')),
    id = identity('muse-stop'),
    host = engine();
  const manager = new TutorTransport(root, fetch, undefined, host.value);
  t.after(async () => {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  await manager.start(id, credential, request);
  await waitFor(manager, id, (value) => value.status === 'running');
  host.runs[0].onText('Partial');
  const stopped = await manager.cancel(id);
  assert.equal(stopped?.status, 'cancelled');
  assert.equal(stopped?.text, 'Partial');
  assert.equal(host.runs[0].signal.aborted, true);
});

test('web questions and a missing agent host use the direct model stream', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tutor-muse-direct-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, available, body] of [
    ['unavailable', false, request],
    ['web', true, { ...request, tools: undefined, webSearch: true as const }],
  ] as const) {
    const host = engine(available);
    let called = '';
    const manager = new TutorTransport(
      join(root, name),
      async (url) => {
        called = url;
        throw new Error('Synthetic offline provider');
      },
      undefined,
      host.value,
    );
    await manager.initialize();
    const id = identity(name);
    await manager.start(id, credential, body);
    await waitFor(manager, id, (value) => value.status === 'interrupted');
    assert.equal(host.runs.length, 0);
    assert.match(called, name === 'web' ? /\/responses$/ : /\/chat\/completions$/);
    await manager.shutdown();
  }
});
