import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TutorResponsesStream, webResponsesRequest } from '../server/tutor-responses';
import { TutorTransport } from '../server/tutor-transport';
import { publicWebUrlSchema } from '../shared/tutor-web';
import {
  tutorTurnInputSchema,
  turnInputFingerprint,
  turnSteeringCompatible,
  type TurnScope,
} from '../shared/tutor-turns';
import { createTutorAgent, type TutorAgentInput } from '../worker/tutor-agent';
import {
  acknowledgeWebDraft,
  restoreWebDraft,
  readTutorSubmission,
  type TutorSubmission,
} from '../src/tutor/turnDrafts';
import { citedReferences } from '../shared/tutor-context';

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const url = 'https://example.org/sampling';
const webId = `web.${createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
const output = (
  text = 'Samples per second.',
  annotations: unknown[] = [
    {
      type: 'url_citation',
      url,
      title: 'Sampling reference',
      start_index: 0,
      end_index: text.length,
    },
  ],
) => [
  { type: 'web_search_call', status: 'completed' },
  {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations }],
  },
];
const complete = (items: unknown[] = output()) =>
  frame({ type: 'response.completed', response: { status: 'completed', output: items } });
const request = {
  model: 'muse-spark-1.3' as const,
  messages: [{ role: 'user', content: 'Find a public sampling reference.' }],
  webSearch: true as const,
  reasoning_effort: 'minimal' as const,
};

test('hosted search requires explicit permission and converts local tools, images and tool results without provider state', () => {
  assert.throws(() => webResponsesRequest({ ...request, webSearch: undefined }), /permission/);
  const body = webResponsesRequest({
    ...request,
    messages: [
      { role: 'system', content: 'Source scope is fixed.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'An authored question' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
        ],
      },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'read-1',
            type: 'function',
            function: { name: 'read_segments', arguments: '{"ids":["s1"]}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'read-1', content: '[{"id":"s1","text":"Allowed evidence"}]' },
      { role: 'assistant', content: 'Earlier answer.' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'read_segments',
          description: 'Read allowed evidence',
          parameters: { type: 'object' },
        },
      },
    ],
  });
  assert.equal(body.store, false);
  assert.deepEqual(body.reasoning, { effort: 'minimal' });
  assert.deepEqual(body.tools.at(-1), { type: 'web_search', search_context_size: 'medium' });
  assert.equal('messages' in body, false);
  assert.equal('previous_response_id' in body, false);
  assert.deepEqual(body.input[2], {
    type: 'function_call',
    call_id: 'read-1',
    name: 'read_segments',
    arguments: '{"ids":["s1"]}',
  });
  assert.equal(
    (body.input[1] as { content: Array<{ type: string }> }).content[1].type,
    'input_image',
  );
  assert.equal((body.input[3] as { type: string }).type, 'function_call_output');
  assert.equal(
    (body.input[4] as { content: Array<{ type: string }> }).content[0].type,
    'output_text',
  );
});
test('fragmented Responses streams retain visible progress and validated URL provenance, excluding reasoning', () => {
  const stream = new TutorResponsesStream();
  const wire =
    frame({ type: 'response.output_text.delta', delta: 'Visible α' }) +
    frame({ type: 'response.reasoning.delta', delta: 'Private scratchpad' }) +
    complete([
      ...output(),
      { type: 'reasoning', encrypted_content: 'opaque-private-value', summary: [] },
    ]);
  for (const char of wire) stream.push(char);
  const result = stream.finish();
  assert.equal(result.webSearched, true);
  assert.equal(result.content, `Samples per second. [${webId}]`);
  assert.deepEqual(result.webSources, [
    { kind: 'web', id: webId, url, title: 'Sampling reference' },
  ]);
  assert.equal(JSON.stringify(result).includes('Private'), false);
  assert.equal(JSON.stringify(result).includes('opaque'), false);
  assert.equal(citedReferences(result.content!, result.webSources!).length, 1);
});
test('unsafe or out-of-range URL annotations never become web evidence; incomplete streams retain partial text', () => {
  for (const value of [
    'javascript:alert(1)',
    'file:///tmp/a',
    'http://127.1/a',
    'http://[::1]/a',
    'http://localhost/a',
    'https://secret@example.org/a',
    'https://device.local/a',
  ])
    assert.equal(publicWebUrlSchema.safeParse(value).success, false, value);
  const stream = new TutorResponsesStream();
  stream.push(
    complete(
      output('A fact.', [
        {
          type: 'url_citation',
          url: 'file:///tmp/secret',
          title: 'Unsafe',
          start_index: 0,
          end_index: 1,
        },
        { type: 'url_citation', url, title: 'Beyond answer', start_index: 0, end_index: 999 },
      ]),
    ),
  );
  assert.deepEqual(stream.finish().webSources, []);
  const incomplete = new TutorResponsesStream();
  incomplete.push(frame({ type: 'response.output_text.delta', delta: 'Retained text' }));
  assert.throws(() => incomplete.finish(), /Partial text is retained/);
  assert.equal(incomplete.text, 'Retained text');
  const interrupted = new TutorResponsesStream();
  assert.throws(() => interrupted.push(frame({ type: 'response.incomplete' })), /Partial text/);
  const oversized = new TutorResponsesStream();
  assert.throws(() => oversized.push('x'.repeat(1024 * 1024 + 1)), /1 MB/);
});
test('Responses local function calls preserve their stable call IDs alongside hosted search', () => {
  const stream = new TutorResponsesStream();
  stream.push(
    complete([
      { type: 'web_search_call', status: 'completed' },
      {
        type: 'function_call',
        call_id: 'read-1',
        name: 'read_segments',
        arguments: '{"ids":["s1"]}',
        status: 'completed',
      },
    ]),
  );
  const result = stream.finish();
  assert.equal(result.webSearched, true);
  assert.deepEqual(result.tool_calls, [
    {
      id: 'read-1',
      type: 'function',
      function: { name: 'read_segments', arguments: '{"ids":["s1"]}' },
    },
  ]);
});
test('an unsuccessful hosted lookup does not discard a completed final answer from another lookup', () => {
  const stream = new TutorResponsesStream();
  stream.push(
    complete([
      { type: 'web_search_call', status: 'failed' },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Trying another source.', annotations: [] }],
      },
      ...output().map((item) =>
        item.type === 'message' ? { ...item, phase: 'final_answer' } : item,
      ),
    ]),
  );
  const result = stream.finish();
  assert.equal(result.webSearched, true);
  assert.equal(result.content, `Samples per second. [${webId}]`);
  assert.equal(result.webSources?.length, 1);
  const unphased = new TutorResponsesStream();
  unphased.push(
    complete([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'commentary',
        content: [{ type: 'output_text', text: 'Searching now.', annotations: [] }],
      },
      ...output(),
    ]),
  );
  assert.equal(unphased.finish().content, `Samples per second. [${webId}]`);
});
test('Web permission participates in canonical request identity and steering admission, preserving older identities', async () => {
  const input = tutorTurnInputSchema.parse({ requestId: crypto.randomUUID(), prompt: 'Question' });
  assert.equal('webSearch' in input, false);
  assert.notEqual(
    await turnInputFingerprint(input),
    await turnInputFingerprint({ ...input, webSearch: true }),
  );
  assert.equal(
    await turnInputFingerprint(input),
    await turnInputFingerprint(tutorTurnInputSchema.parse({ ...input, webSearch: undefined })),
  );
  assert.equal(tutorTurnInputSchema.safeParse({ ...input, webSearch: 'true' }).success, false);
  const scope: TurnScope = { references: [], attachments: [], concepts: [] };
  assert.equal(turnSteeringCompatible({ ...scope, webSearch: true }, scope), false);
  assert.equal(turnSteeringCompatible(scope, { ...scope, webSearch: true }), false);
  assert.equal(
    turnSteeringCompatible({ ...scope, webSearch: true }, { ...scope, webSearch: true }),
    true,
  );
});
test('unconfirmed Web drafts restore only untouched permission revisions, and ACK preserves newer toggles', () => {
  const stamp = () => crypto.randomUUID();
  const sent: TutorSubmission = {
    format: 2,
    payload: {
      requestId: stamp(),
      prompt: 'Find public evidence',
      concepts: [],
      attachments: [],
      webSearch: true,
    },
    webStamp: stamp(),
    emptyWebStamp: stamp(),
  };
  const empty = { enabled: false, stamp: sent.emptyWebStamp! };
  const restored = restoreWebDraft(empty, sent, true);
  assert.equal(restored.draft.enabled, true);
  assert.equal(acknowledgeWebDraft(restored.draft, restored.submission).enabled, false);
  const newer = { enabled: true, stamp: stamp() };
  assert.deepEqual(acknowledgeWebDraft(newer, sent), newer);
  assert.deepEqual(restoreWebDraft(newer, sent, true).draft, newer);
  assert.deepEqual(restoreWebDraft(empty, sent, false).draft, empty);
  assert.deepEqual(readTutorSubmission(JSON.stringify(sent))?.payload, sent.payload);
});
test('agent checkpoints preserve hosted-search provenance through local tools without granting later-turn permission', async () => {
  const input: TutorAgentInput = {
    model: request.model,
    webSearch: true,
    prompt: 'Find public evidence',
    history: [],
    learning: null,
    review: {
      count: 0,
      correct: 0,
      percent: null,
      needsPractice: [],
      evidence: 'Recorded attempts only',
    },
  };
  const agent = await createTutorAgent(input);
  assert.equal(agent.request().webSearch, true);
  const stream = new TutorResponsesStream();
  stream.push(complete());
  agent.acceptCompletion({
    ...stream.finish(),
    tool_calls: [
      { id: 'stats', type: 'function', function: { name: 'practice_summary', arguments: '{}' } },
    ],
  });
  await agent.executeNextTool();
  const resumed = await createTutorAgent(input, JSON.parse(JSON.stringify(agent.snapshot())));
  const final = resumed.acceptCompletion({ content: `External finding [${webId}].` });
  assert.equal(final?.webSearched, true);
  assert.equal(final?.citations[0].kind, 'web');
  assert.ok(final?.tools.includes('web_search'));
  const later = await createTutorAgent({
    ...input,
    webSearch: undefined,
    history: [{ role: 'assistant', content: final!.text }],
  });
  assert.equal('webSearch' in later.request(), false);
  assert.throws(() => later.acceptCompletion(stream.finish()), /without permission/);
});
test('hosted search uses the durable transport and reopens completed provenance without another provider call', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tutor-web-'));
  let calls = 0;
  const manager = new TutorTransport(root, async (endpoint, options) => {
    calls++;
    assert.equal(endpoint, 'https://api.meta.ai/v1/responses');
    const body = JSON.parse(options.body as string);
    assert.equal(body.store, false);
    assert.equal(body.tools.at(-1).type, 'web_search');
    return new Response(
      frame({ type: 'response.output_text.delta', delta: 'Samples per second.' }) + complete(),
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  const id = createHash('sha256').update('hosted-search').digest('hex');
  await manager.start(id, 'fake-key', request);
  let value = await manager.get(id);
  for (let i = 0; i < 200 && value?.status !== 'completed'; i++) {
    await delay(3);
    value = await manager.get(id);
  }
  assert.equal(value?.status, 'completed');
  assert.equal(value.result?.webSources?.[0].url, url);
  assert.deepEqual(await manager.start(id, 'fake-key', request), value);
  assert.equal(calls, 1);
  assert.equal(
    (await readFile(join(root, id, 'request.json'), 'utf8')).includes('fake-key'),
    false,
  );
  const restarted = new TutorTransport(root, async () => {
    assert.fail('Completed web search was resubmitted');
  });
  await restarted.initialize();
  assert.deepEqual(await restarted.get(id), value);
  await restarted.shutdown();
});
