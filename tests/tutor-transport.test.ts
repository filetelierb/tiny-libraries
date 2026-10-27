import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TutorStream } from '../server/tutor-stream';
import { TutorTransport, TutorTransportError, type TutorProvider } from '../server/tutor-transport';
import { startBridge } from '../server/bridge';
import type { TransportSnapshot } from '../shared/tutor-transport';

const identity = (value: string) => createHash('sha256').update(value).digest('hex');
const credential = 'not-a-real-Meta-key';
const request = {
  model: 'muse-spark-1.3' as const,
  messages: [{ role: 'user', content: 'Synthetic sampling question.' }],
  reasoning_effort: 'minimal' as const,
};
const frame = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
const finished = (text: string) =>
  new Response(frame({ content: text }) + frame({}, 'stop') + 'data: [DONE]\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  });
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
  assert.fail(`Stream did not reach expected state: ${value?.status}`);
}
function controlledStream(options: RequestInit) {
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      source = controller;
    },
  });
  options.signal?.addEventListener(
    'abort',
    () => {
      try {
        source.error(new Error('Local request aborted'));
      } catch {}
    },
    { once: true },
  );
  return {
    response: new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }),
    push: (text: string) => source.enqueue(encoder.encode(text)),
    close: () => source.close(),
  };
}

test('stream parser retains Unicode/tool fragments while excluding private reasoning', () => {
  const parser = new TutorStream();
  const wire =
    ': heartbeat\r\n\r\n' +
    frame({ content: 'Señal α ' }) +
    frame({ reasoning_content: 'Private reasoning must never be retained' }) +
    frame({
      tool_calls: [
        {
          index: 0,
          id: 'read-1',
          type: 'function',
          function: { name: 'read_', arguments: '{"ids":' },
        },
      ],
    }) +
    frame({
      tool_calls: [{ index: 0, function: { name: 'segments', arguments: '["source:1"]}' } }],
    }) +
    frame({}, 'tool_calls') +
    'data: [DONE]\n\n';
  for (const character of wire) parser.push(character);
  const value = parser.finish();
  assert.equal(value.content, 'Señal α ');
  assert.deepEqual(value.tool_calls, [
    {
      id: 'read-1',
      type: 'function',
      function: { name: 'read_segments', arguments: '{"ids":["source:1"]}' },
    },
  ]);
  assert.equal(JSON.stringify(value).includes('Private reasoning'), false);
  for (const finish of [null, 'length', 'content_filter']) {
    const incomplete = new TutorStream();
    incomplete.push(frame({ content: 'Retained partial' }, finish) + 'data: [DONE]\n\n');
    assert.throws(() => incomplete.finish(), /Partial text is retained/);
    assert.equal(incomplete.text, 'Retained partial');
  }
  const oversized = new TutorStream();
  assert.throws(() => oversized.push('data: ' + 'x'.repeat(1024 * 1024)), /1 MB/);
  const inconsistent = new TutorStream();
  inconsistent.push(frame({ tool_calls: [{ index: 0, id: 'first' }] }));
  assert.throws(
    () => inconsistent.push(frame({ tool_calls: [{ index: 0, id: 'changed' }] })),
    /identity changed/,
  );
});

test('durable stream progress is independent of its initiating caller and same-ID retries do not resubmit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tutor-progress-'));
  let stream!: ReturnType<typeof controlledStream>,
    calls = 0;
  const manager = new TutorTransport(root, async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.meta.ai/v1/chat/completions');
    assert.equal((options.headers as Record<string, string>).Authorization, `Bearer ${credential}`);
    const body = JSON.parse(options.body as string);
    assert.equal(body.stream, true);
    assert.equal(body.reasoning_effort, 'minimal');
    stream = controlledStream(options);
    stream.push(frame({ content: 'First α' }));
    return stream.response;
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  const id = identity('progress');
  assert.equal((await manager.start(id, credential, request)).status, 'accepted');
  const partial = await waitFor(manager, id, (s) => s.status === 'running' && s.text === 'First α');
  const duplicates = await Promise.all(
    Array.from({ length: 4 }, () => manager.start(id, credential, request)),
  );
  assert.ok(duplicates.every((s) => s.sequence >= partial.sequence));
  assert.equal(calls, 1);
  await assert.rejects(
    manager.start(id, credential, { ...request, reasoning_effort: 'high' }),
    (e: unknown) => e instanceof TutorTransportError && e.status === 409,
  );
  stream.push(frame({ content: ' → complete' }));
  stream.push(frame({}, 'stop') + 'data: [DONE]\n\n');
  stream.close();
  const completed = await waitFor(manager, id, (s) => s.status === 'completed');
  assert.equal(completed.text, 'First α → complete');
  assert.equal(completed.result?.content, completed.text);
  assert.ok(completed.sequence > partial.sequence);
  assert.deepEqual(await manager.start(id, credential, request), completed);
  assert.equal(calls, 1);
  const files = await readdir(join(root, id));
  for (const file of files) {
    assert.equal((await readFile(join(root, id, file), 'utf8')).includes(credential), false);
    assert.equal((await stat(join(root, id, file))).mode & 0o777, 0o600);
  }
  const next = new TutorTransport(root, async () => {
    assert.fail('Completed request resubmitted');
  });
  await next.initialize();
  assert.deepEqual(await next.get(id), completed);
  await next.shutdown();
});

test('cancellation wins over late stream writes, and shutdown preserves interrupted progress', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tutor-stop-'));
  let calls = 0;
  const manager = new TutorTransport(root, async (_url, options) => {
    calls++;
    const stream = controlledStream(options);
    stream.push(frame({ content: 'Saved partial' }));
    return stream.response;
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  const id = identity('cancel'),
    other = identity('shutdown');
  await manager.start(id, credential, request);
  await manager.start(other, credential, request);
  await waitFor(manager, id, (s) => s.text === 'Saved partial');
  await waitFor(manager, other, (s) => s.text === 'Saved partial');
  const cancelled = await manager.cancel(id);
  assert.equal(cancelled?.status, 'cancelled');
  assert.equal(cancelled?.text, 'Saved partial');
  assert.equal((await manager.start(id, credential, request)).status, 'cancelled');
  assert.equal(calls, 2);
  await manager.shutdown();
  assert.deepEqual(await manager.get(id), cancelled);
  const interrupted = await manager.get(other);
  assert.equal(interrupted?.status, 'interrupted');
  assert.equal(interrupted?.text, 'Saved partial');
  assert.equal(interrupted?.result, undefined);
  const next = new TutorTransport(root, async () => {
    assert.fail('Interrupted request resubmitted');
  });
  await next.initialize();
  assert.deepEqual(await next.start(other, credential, request), interrupted);
  await next.shutdown();
});

test('a prior process journal becomes interrupted on demand without any provider resubmission', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tutor-recover-')),
    id = identity('prior-process');
  await mkdir(join(root, id), { mode: 0o700 });
  const fingerprint = identity(JSON.stringify(request));
  await writeFile(join(root, id, 'request.json'), JSON.stringify(request), { mode: 0o600 });
  await writeFile(
    join(root, id, 'status.json'),
    JSON.stringify({
      id,
      fingerprint,
      owner: 'stopped-process',
      status: 'running',
      sequence: 7,
      text: 'Prior saved tokens',
      toolNames: ['read_segments'],
      createdAt: '2026-10-27',
      updatedAt: '2026-10-27',
    }),
    { mode: 0o600 },
  );
  const manager = new TutorTransport(root, async () => {
    assert.fail('Uncertain request automatically retried');
  });
  t.after(async () => {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  const recovered = await manager.get(id);
  assert.equal(recovered?.status, 'interrupted');
  assert.equal(recovered?.sequence, 8);
  assert.equal(recovered?.text, 'Prior saved tokens');
  assert.deepEqual(await manager.get(id), recovered);
  assert.deepEqual(await manager.start(id, credential, request), recovered);
});

test('provider rejection, incomplete streams and oversized/invalid requests keep truthful bounded state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tutor-errors-'));
  let calls = 0;
  const provider: TutorProvider = async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body as string);
    if (body.messages[0].content === 'reject')
      return Response.json({ error: { message: `Provider error ${credential}` } }, { status: 500 });
    return new Response(frame({ content: 'Unfinished' }) + 'data: [DONE]\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
  const manager = new TutorTransport(root, provider);
  t.after(async () => {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  const rejected = identity('rejected'),
    incomplete = identity('incomplete');
  await manager.start(rejected, credential, {
    ...request,
    messages: [{ role: 'user', content: 'reject' }],
  });
  const failed = await waitFor(manager, rejected, (s) => s.status === 'failed');
  assert.match(failed.error || '', /HTTP 500/);
  assert.equal(failed.error?.includes(credential), false);
  await manager.start(incomplete, credential, request);
  const partial = await waitFor(manager, incomplete, (s) => s.status === 'interrupted');
  assert.equal(partial.text, 'Unfinished');
  assert.equal(partial.result, undefined);
  await assert.rejects(
    manager.start(identity('none'), credential, { ...request, reasoning_effort: 'none' }),
  );
  await assert.rejects(manager.start('../outside', credential, request), /identity/);
  await assert.rejects(
    manager.start(identity('large'), credential, {
      ...request,
      messages: ['x'.repeat(33 * 1024 * 1024)],
    }),
    (e: unknown) => e instanceof TutorTransportError && e.status === 413,
  );
  assert.equal(calls, 2);
});

test('authenticated bridge returns before generation ends and can poll/cancel after HTTP disconnect', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tutor-http-'));
  let calls = 0;
  const server = await startBridge('private-test-token', root, 0, async (_url, options) => {
    calls++;
    const stream = controlledStream(options);
    stream.push(frame({ content: 'Independent stream' }));
    return stream.response;
  });
  t.after(async () => {
    await server.shutdownTutor();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const id = identity('http'),
    url = `http://127.0.0.1:${address.port}/tutor-requests/${id}`;
  const headers = {
    Authorization: 'Bearer private-test-token',
    'Content-Type': 'application/json',
    'X-Meta-Key': credential,
  };
  const denied = await fetch(url, { method: 'POST', body: JSON.stringify(request) });
  assert.equal(denied.status, 401);
  const accepted = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).status, 'accepted');
  const duplicate = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) });
  await duplicate.json();
  assert.equal(calls, 1);
  const changed = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...request, reasoning_effort: 'max' }),
  });
  assert.equal(changed.status, 409);
  const polled = await fetch(url, { headers });
  const saved = await polled.json();
  assert.equal(saved.text, 'Independent stream');
  const cancelled = await fetch(url + '/cancel', { method: 'POST', headers });
  assert.equal((await cancelled.json()).status, 'cancelled');
  assert.equal(calls, 1);
});

test('multiple bounded UTF-8 tool frames retain a result larger than one megabyte', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'tutor-large-result-'));
  const args = JSON.stringify({ quote: '字'.repeat(60000) });
  const wire =
    Array.from({ length: 8 }, (_, index) =>
      frame({
        tool_calls: [
          {
            index,
            id: `call-${index}`,
            type: 'function',
            function: { name: 'read_segments', arguments: args },
          },
        ],
      }),
    ).join('') +
    frame({}, 'tool_calls') +
    'data: [DONE]\n\n';
  const manager = new TutorTransport(
    root,
    async () =>
      new Response(wire, {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  );
  t.after(async () => {
    await manager.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await manager.initialize();
  const id = identity('large-utf8-tools');
  await manager.start(id, credential, request);
  const result = await waitFor(manager, id, (value) => value.status === 'completed');
  assert.equal(result.result?.tool_calls?.length, 8);
  assert.ok((await stat(join(root, id, 'status.json'))).size > 1024 * 1024);
  assert.equal(result.result?.tool_calls?.[7].function.arguments, args);
});
