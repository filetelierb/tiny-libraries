import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Annotation } from '../shared/annotations';
import { markdownDocument, type ReplyAction, type TutorAction } from '../shared/tutor-actions';
import {
  decideTutorAction,
  readLibrary,
  requestTutorAction,
  tutorActionStatus,
  type LibraryCall,
} from '../worker/tutor-actions';
import { createTutorAgent, type TutorAgentInput } from '../worker/tutor-agent';
import { MemoryStore } from './storage';

const sessionId = '2f0f62f6-5d8c-4a39-9a43-0c1f4c7b6f10';
const fileId = '0e5fa467-1b2c-4d3e-8f90-123456789abc';
const folderId = '5c1d0f8a-7b6e-4c3d-9a2b-abcdefabcdef';

async function library() {
  const store = new MemoryStore();
  await store.put(`file:${fileId}`, {
    id: fileId,
    version: 2,
    name: 'Lecture.pdf',
    folder: 'EE261',
    kind: 'pdf',
    archived: false,
    reviewed: false,
  });
  await store.put(`directory:${folderId}`, {
    id: folderId,
    path: 'EE261',
    archived: false,
    trashed: false,
  });
  await store.put(`learning:${fileId}`, { sourceId: fileId });
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const call: LibraryCall = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    return path.startsWith('/api/annotations?') ? { items: [] } : {};
  };
  return { store, calls, call };
}
const request = (id: string, action: TutorAction) => ({
  id,
  conversationId: 'conversation-1',
  sessionId,
  action,
});

test('notes keep the Markdown structure the tutor writes', () => {
  const document = markdownDocument(
    '## Aliasing\n\nHigh **frequencies** fold, see \\(f_s/2\\).\n\n- one\n- two\n\n$$\nf_s > 2B\n$$\n> quoted',
  );
  assert.deepEqual(
    document.content!.map((node) => node.type),
    [
      'heading',
      'paragraph',
      'paragraph',
      'paragraph',
      'bulletList',
      'paragraph',
      'blockMath',
      'blockquote',
    ],
  );
  const sentence = document.content![2].content!;
  assert.deepEqual(sentence[1], { type: 'text', text: 'frequencies', marks: [{ type: 'bold' }] });
  assert.deepEqual(sentence[3], { type: 'inlineMath', attrs: { latex: 'f_s/2' } });
});

test('direct actions run through the library routes once, with the names the student sees', async () => {
  const { store, calls, call } = await library();
  const id = crypto.randomUUID();
  const renamed = await requestTutorAction(
    store.storage(),
    call,
    request(id, { op: 'item.rename', type: 'file', id: fileId, name: 'Fourier lecture' }),
  );
  assert.equal(renamed.status, 'done');
  assert.equal(renamed.subject, 'EE261/Lecture.pdf');
  assert.equal(renamed.detail, 'Fourier lecture.pdf');
  assert.deepEqual(calls, [
    { method: 'PATCH', path: `/api/files/${fileId}`, body: { name: 'Fourier lecture.pdf' } },
  ]);
  await requestTutorAction(
    store.storage(),
    call,
    request(id, { op: 'item.rename', type: 'file', id: fileId, name: 'Again' }),
  );
  assert.equal(calls.length, 1);
  await requestTutorAction(
    store.storage(),
    call,
    request(crypto.randomUUID(), { op: 'item.archive', type: 'folder', id: folderId }),
  );
  assert.deepEqual(calls[1], {
    method: 'PATCH',
    path: `/api/directories/${folderId}`,
    body: { action: 'archive' },
  });
  await assert.rejects(
    requestTutorAction(
      store.storage(),
      call,
      request(crypto.randomUUID(), { op: 'item.trash', type: 'file', id: crypto.randomUUID() }),
    ),
    /browse_library/,
  );
});

test('deleting waits for the student, who can confirm or cancel once', async () => {
  const { store, calls, call } = await library();
  const deleteId = crypto.randomUUID(),
    trashId = crypto.randomUUID();
  const proposed = await requestTutorAction(
    store.storage(),
    call,
    request(deleteId, { op: 'item.delete', type: 'folder', id: folderId }),
  );
  assert.equal(proposed.status, 'proposed');
  assert.equal(calls.length, 0);
  const session = async () => sessionId;
  const confirmed = await decideTutorAction(store.storage(), call, deleteId, 'confirm', session);
  assert.equal(confirmed.state, 'done');
  assert.deepEqual(calls, [{ method: 'DELETE', path: `/api/directories/${folderId}` }]);
  await decideTutorAction(store.storage(), call, deleteId, 'confirm', session);
  assert.equal(calls.length, 1);
  await requestTutorAction(
    store.storage(),
    call,
    request(trashId, { op: 'item.trash', type: 'file', id: fileId }),
  );
  const cancelled = await decideTutorAction(store.storage(), call, trashId, 'cancel', session);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal((await tutorActionStatus(store.storage(), trashId)).state, 'cancelled');
  assert.equal(calls.length, 1);
});

test('notes are written and edited only in the conversation session', async () => {
  const { store, calls, call } = await library();
  const createId = crypto.randomUUID();
  await requestTutorAction(
    store.storage(),
    call,
    request(createId, {
      op: 'note.create',
      kind: 'annotation',
      title: 'Aliasing',
      text: '- folds frequencies',
      sourceId: fileId,
      sourceVersion: 2,
      segment: { id: 'p3', text: 'Aliasing folds high frequencies.', page: 3 },
    }),
  );
  const body = calls[0].body as Record<string, unknown>;
  assert.equal(calls[0].path, `/api/annotations/${createId}`);
  assert.deepEqual(body.location, { quote: 'Aliasing folds high frequencies.', page: 3 });
  assert.equal(body.origin, 'tutor');
  assert.equal(body.mutationId, createId);
  assert.equal(
    (body.document as { content: Array<{ type: string }> }).content[0].type,
    'bulletList',
  );
  const noteId = crypto.randomUUID();
  await store.put(`annotation:${noteId}`, {
    id: noteId,
    sessionId: crypto.randomUUID(),
    title: 'Elsewhere',
    text: '',
    revision: 1,
  } as Partial<Annotation>);
  await assert.rejects(
    requestTutorAction(
      store.storage(),
      call,
      request(crypto.randomUUID(), { op: 'note.update', id: noteId, title: 'Mine now' }),
    ),
    /list_notes/,
  );
});

test('a test starts in the session with the tutor guidance and opens from the chat', async () => {
  const { store, calls, call } = await library();
  const id = crypto.randomUUID();
  const started = await requestTutorAction(
    store.storage(),
    call,
    request(id, {
      op: 'test.start',
      sourceIds: [fileId],
      count: 12,
      difficulty: 'mixed',
      guidance: 'Focus on aliasing',
    }),
  );
  assert.equal(started.testId, id);
  assert.equal(started.sessionId, sessionId);
  assert.deepEqual(calls[0], {
    method: 'POST',
    path: '/api/assessments',
    body: {
      requestId: id,
      sessionId,
      config: {
        sourceIds: [fileId],
        count: 12,
        difficulty: 'mixed',
        guidance: 'Focus on aliasing',
        priorReportIds: [],
      },
    },
  });
});

test('the library overview lists folders and files with their state and preparation', async () => {
  const { store, call } = await library();
  const value = (await readLibrary(
    store.storage(),
    call,
    { view: 'library', query: 'lect' },
    sessionId,
  )) as {
    folders: unknown[];
    files: Array<{ name: string; prepared: boolean; state: string }>;
  };
  assert.deepEqual(value.folders, []);
  assert.deepEqual(
    value.files.map((file) => [file.name, file.prepared, file.state]),
    [['Lecture.pdf', true, 'files']],
  );
});

test('the agent turns library tool calls into actions and records what it did', async () => {
  const input: TutorAgentInput = {
    model: 'muse-spark-1.3',
    prompt: 'Rename the lecture and delete the old folder.',
    history: [],
    learning: null,
    review: { count: 0, correct: 0, percent: null, needsPractice: [], evidence: '' },
    canManageLibrary: true,
  };
  const agent = await createTutorAgent(input);
  assert.ok(agent.mcpTools().some((tool) => tool.name === 'manage_files'));
  const tool = (id: string, name: string, args: unknown) => ({
    id,
    type: 'function' as const,
    function: { name, arguments: JSON.stringify(args) },
  });
  agent.acceptCompletion({
    content: null,
    tool_calls: [
      tool('a', 'manage_files', { action: 'rename', type: 'file', id: fileId, name: 'Fourier' }),
      tool('b', 'manage_files', { action: 'delete', type: 'folder', id: folderId }),
      tool('c', 'manage_files', { action: 'rename', name: 'No target' }),
      tool('d', 'start_test', {
        sourceIds: [fileId],
        count: 10,
        difficulty: 'mixed',
        guidance: '',
      }),
    ],
  });
  const actions: TutorAction[] = [];
  const act = async ({ action }: { callId: string; action: TutorAction }): Promise<ReplyAction> => {
    actions.push(action);
    return {
      id: crypto.randomUUID(),
      op: action.op,
      subject: 'x',
      status: action.op === 'item.delete' ? 'proposed' : 'done',
    };
  };
  const outputs: unknown[] = [];
  while (agent.hasPendingTools)
    outputs.push(
      (await agent.executeNextTool(undefined, undefined, undefined, undefined, undefined, act))!
        .output,
    );
  assert.deepEqual(
    actions.map((action) => action.op),
    ['item.rename', 'item.delete'],
  );
  assert.match(JSON.stringify(outputs[1]), /Waiting for the student to confirm/);
  assert.match(JSON.stringify(outputs[2]), /needs type and id/);
  assert.match(JSON.stringify(outputs[3]), /count must be one of/);
  agent.acceptCompletion({ content: 'Renamed; the deletion waits for you.' });
  assert.deepEqual(
    agent.result?.actions?.map((action) => action.status),
    ['done', 'proposed'],
  );
});
