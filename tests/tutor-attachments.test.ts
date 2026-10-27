import type { R2Bucket } from '@cloudflare/workers-types';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  attachmentSegments,
  attachmentIdsSchema,
  MAX_ATTACHMENT_TEXT_BYTES,
} from '../shared/tutor-attachments';
import {
  createQuestionAttachment,
  readQuestionAttachments,
  attachmentImageData,
  type AttachmentStore,
} from '../worker/tutor-attachments';
import { composeCapture } from '../server/capture-image';
import { MemoryStore } from './storage';
import { plainDocument, type Annotation } from '../shared/annotations';
import type { Source, Learning } from '../shared/domain';
import { runAssistant } from '../worker/meta';
import { questionAttachmentSchema, attachmentMention } from '../shared/tutor-attachments';

const sessionId = '12d4610e-9ce6-4925-9d7a-b4a243c3a0ce',
  sourceId = '2549f232-ecb2-4e35-88bb-33630837da00';
const file: Source = {
  id: sourceId,
  version: 1,
  name: 'Signals.md',
  kind: 'markdown',
  folder: '',
  mime: 'text/markdown',
  size: 20,
  archived: false,
  reviewed: false,
  createdAt: 'today',
};
const note: Annotation = {
  id: '5e180e1b-6c56-49ce-a3ce-90925bd422eb',
  sessionId,
  sourceId,
  sourceVersion: 1,
  title: 'Sampling note',
  document: plainDocument('Eight hertz'),
  text: 'Eight hertz',
  location: { page: 2, quote: 'Sample faster than 16 Hz.' },
  revision: 2,
  deleted: false,
  createdAt: 'today',
  updatedAt: 'today',
  strokes: [],
  origin: 'manual',
  references: [sourceId],
};
function fixtures() {
  const memory = new MemoryStore();
  memory.data.set(`session:${sessionId}`, { id: sessionId });
  memory.data.set(`file:${sourceId}`, file);
  memory.data.set(`annotation:${note.id}`, note);
  const blobs = new Map<string, Uint8Array>();
  const files = {
    async get(key: string) {
      const bytes = blobs.get(key);
      return bytes
        ? { size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer }
        : null;
    },
    async put(key: string, bytes: Uint8Array) {
      blobs.set(key, new Uint8Array(bytes));
    },
    async delete(key: string) {
      blobs.delete(key);
    },
  };
  // The in-memory harness implements the storage operations exercised by these tests.
  return {
    memory,
    storage: memory as unknown as AttachmentStore,
    blobs,
    files: files as unknown as Pick<R2Bucket, 'get' | 'put' | 'delete'>,
  };
}

test('attachment evidence keeps complete Unicode text and source locations within bounded records', () => {
  const text = '𝑓'.repeat(3000) + ' final evidence';
  const parts = attachmentSegments(sourceId, [{ id: 'page-2', text, page: 2, start: 12, end: 20 }]);
  assert.equal(parts.map((part) => part.text).join(''), text);
  assert.equal(parts.length, 2);
  assert.ok(
    parts.every((part) => part.page === 2 && part.start === 12 && part.originalId === 'page-2'),
  );
  assert.equal(new Set(parts.map((part) => part.id)).size, 2);
  assert.throws(() =>
    attachmentSegments(sourceId, [
      { id: 'large', text: 'x'.repeat(MAX_ATTACHMENT_TEXT_BYTES + 1) },
    ]),
  );
  assert.equal(attachmentIdsSchema.safeParse([sourceId, sourceId]).success, false);
  assert.equal(
    attachmentIdsSchema.safeParse(Array.from({ length: 7 }, () => crypto.randomUUID())).success,
    false,
  );
});

test('annotation attachments freeze the chosen revision independently of subsequent edits and deletion', async () => {
  const { memory, storage, files } = fixtures();
  const input = {
    id: crypto.randomUUID(),
    sessionId,
    kind: 'annotation' as const,
    annotationId: note.id,
    revision: 2,
  };
  const first = await createQuestionAttachment(storage, files, input, composeCapture);
  memory.data.set(`annotation:${note.id}`, {
    ...note,
    text: 'Changed',
    revision: 3,
    deleted: true,
  });
  memory.data.set(`file:${sourceId}`, { ...file, trashed: true });
  const [saved] = await readQuestionAttachments(storage, sessionId, [first.id]);
  assert.match(saved.segments[0].text, /Eight hertz/);
  assert.doesNotMatch(saved.segments[0].text, /Changed/);
  assert.equal(saved.attachment.annotationRevision, 2);
  assert.deepEqual(await createQuestionAttachment(storage, files, input, composeCapture), first);
  await assert.rejects(
    createQuestionAttachment(storage, files, { ...input, revision: 3 }, composeCapture),
    /different content/,
  );
  await assert.rejects(
    createQuestionAttachment(
      storage,
      files,
      { ...input, id: crypto.randomUUID(), revision: 3 },
      composeCapture,
    ),
    /changed or is deleted/,
  );
  await assert.rejects(
    readQuestionAttachments(storage, crypto.randomUUID(), [first.id]),
    /this study session/,
  );
});

test('file attachment snapshots preserve the selected prepared evidence and never trigger hidden preparation', async () => {
  const { memory, storage, blobs, files } = fixtures();
  const pdf = { ...file, name: 'Signals.pdf', kind: 'pdf' as const };
  memory.data.set(`file:${sourceId}`, pdf);
  const input = {
    id: crypto.randomUUID(),
    sessionId,
    kind: 'file' as const,
    sourceId,
    sourceVersion: 1,
  };
  await assert.rejects(
    createQuestionAttachment(storage, files, input, composeCapture),
    /Prepare this PDF/,
  );
  const learning = {
    sourceId,
    sourceVersion: 1,
    segments: [{ id: 'page-3', text: 'More than 16 samples per second.', page: 3 }],
  } as Learning;
  memory.data.set(`learning:${sourceId}`, learning);
  const snapshot = await createQuestionAttachment(storage, files, input, composeCapture);
  memory.data.set(`learning:${sourceId}`, {
    ...learning,
    segments: [{ id: 'page-3', text: 'New preparation' }],
  });
  const [saved] = await readQuestionAttachments(storage, sessionId, [snapshot.id]);
  assert.equal(saved.segments[0].text, learning.segments[0].text);
  assert.equal(saved.segments[0].page, 3);
  memory.data.set(`file:${sourceId}`, file);
  blobs.set(`original/${sourceId}/1`, new TextEncoder().encode('An unprepared text file.'));
  memory.data.delete(`learning:${sourceId}`);
  const text = await createQuestionAttachment(
    storage,
    files,
    { ...input, id: crypto.randomUUID() },
    composeCapture,
  );
  assert.equal(
    (await readQuestionAttachments(storage, sessionId, [text.id]))[0].segments[0].text,
    'An unprepared text file.',
  );
});

test('capture snapshots contain the visible drawing and preserve their image digest and bytes on retry', async () => {
  const { memory, storage, blobs, files } = fixtures();
  const canvas = createCanvas(100, 100),
    context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 100, 100);
  const captureId = crypto.randomUUID(),
    original = canvas.toBuffer('image/png');
  blobs.set(`annotation/${note.id}/${captureId}`, original);
  const annotated = {
    ...note,
    capture: { id: captureId, width: 100, height: 100, size: original.length },
    strokes: [
      {
        color: '#c33d45' as const,
        width: 8,
        points: [
          { x: 0.1, y: 0.5 },
          { x: 0.9, y: 0.5 },
        ],
      },
    ],
  };
  memory.data.set(`annotation:${note.id}`, annotated);
  const input = {
    id: crypto.randomUUID(),
    sessionId,
    kind: 'annotation' as const,
    annotationId: note.id,
    revision: note.revision,
  };
  const snapshot = await createQuestionAttachment(storage, files, input, composeCapture);
  assert.equal(snapshot.kind, 'capture');
  const image = blobs.get(`tutor-attachment/${snapshot.id}/${snapshot.image!.id}`)!;
  assert.notDeepEqual(Buffer.from(image), original);
  const decoded = await loadImage(Buffer.from(image));
  context.drawImage(decoded, 0, 0);
  const pixel = context.getImageData(50, 50, 1, 1).data;
  assert.ok(pixel[0] > 150 && pixel[1] < 100 && pixel[2] < 120);
  assert.deepEqual(await createQuestionAttachment(storage, files, input, composeCapture), snapshot);
  assert.equal(blobs.size, 2);
  blobs.set(
    `tutor-attachment/${snapshot.id}/${snapshot.image!.id}`,
    createCanvas(2, 2).toBuffer('image/png'),
  );
  await assert.rejects(attachmentImageData(files, snapshot), /integrity check failed/);
});

test('a question rejects aggregate images above its explicit payload budget', async () => {
  const { memory, storage } = fixtures();
  const ids: string[] = [];
  for (let index = 0; index < 5; index++) {
    const id = crypto.randomUUID();
    ids.push(id);
    const value = questionAttachmentSchema.parse({
      id,
      sessionId,
      kind: 'file',
      name: 'Image',
      sourceId,
      sourceVersion: 1,
      sourceName: file.name,
      location: {},
      segmentCount: 1,
      textBytes: 1,
      image: {
        id: crypto.randomUUID(),
        mime: 'image/png',
        size: 3 * 1024 * 1024,
        digest: '0'.repeat(64),
      },
      createdAt: 'today',
    });
    memory.data.set(`tutor-attachment:${id}`, { ...value, input: '{}' });
    memory.data.set(`tutor-attachment-part:${id}:0000`, {
      id: `attachment.${id}.part-1`,
      text: 'Image',
    });
  }
  assert.equal((await readQuestionAttachments(storage, sessionId, ids.slice(0, 4))).length, 4);
  await assert.rejects(readQuestionAttachments(storage, sessionId, ids), /12 MB/);
});

test('snapshot publication rejects concurrent note changes and removes its unpublished image', async () => {
  const { memory, storage, blobs, files } = fixtures();
  const captureId = crypto.randomUUID(),
    png = createCanvas(2, 2).toBuffer('image/png');
  blobs.set(`annotation/${note.id}/${captureId}`, png);
  memory.data.set(`annotation:${note.id}`, {
    ...note,
    capture: { id: captureId, width: 2, height: 2, size: png.length },
  });
  await assert.rejects(
    createQuestionAttachment(
      storage,
      files,
      {
        id: crypto.randomUUID(),
        sessionId,
        kind: 'annotation',
        annotationId: note.id,
        revision: note.revision,
      },
      async () => {
        memory.data.set(`annotation:${note.id}`, { ...note, revision: 3 });
        return png;
      },
    ),
    /changed during attachment/,
  );
  assert.equal(blobs.size, 1);
  assert.equal(
    [...memory.data.keys()].filter((key) => key.startsWith('tutor-attachment:')).length,
    0,
  );
  await assert.rejects(composeCapture(new TextEncoder().encode('not PNG'), []), /must be a PNG/);
});

test('current image attachments use multimodal content and cite only the frozen passages actually read', async () => {
  const { storage, memory, blobs, files } = fixtures();
  const captureId = crypto.randomUUID(),
    png = createCanvas(8, 8).toBuffer('image/png');
  blobs.set(`annotation/${note.id}/${captureId}`, png);
  memory.data.set(`annotation:${note.id}`, {
    ...note,
    capture: { id: captureId, width: 8, height: 8, size: png.length },
  });
  const attachment = await createQuestionAttachment(
    storage,
    files,
    { id: crypto.randomUUID(), sessionId, kind: 'annotation', annotationId: note.id, revision: 2 },
    composeCapture,
  );
  const [content] = await readQuestionAttachments(storage, sessionId, [attachment.id]);
  const imageData = await attachmentImageData(files, attachment);
  let calls = 0,
    bookmarks = 0;
  const result = await runAssistant(
    'placeholder',
    'model',
    'Explain this capture',
    [],
    [],
    { count: 0, correct: 0, percent: 0, needsPractice: [], evidence: 'Recorded attempts only' },
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      if (++calls === 1) {
        const parts = body.messages.at(-1).content;
        assert.equal(parts.at(-1).type, 'image_url');
        assert.equal(parts.at(-1).image_url.url, imageData);
        assert.match(body.messages[0].content, /frozen snapshots/);
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'read',
                    type: 'function',
                    function: {
                      name: 'read_segments',
                      arguments: JSON.stringify({
                        ids: [content.segments[0].id, 'unselected:secret'],
                      }),
                    },
                  },
                  {
                    id: 'bookmark',
                    type: 'function',
                    function: {
                      name: 'create_bookmark',
                      arguments: JSON.stringify({
                        segmentId: content.segments[0].id,
                        label: 'Wrong origin',
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      const evidence = JSON.parse(
        body.messages.find((item: { tool_call_id?: string }) => item.tool_call_id === 'read')
          .content,
      );
      assert.equal(evidence.length, 1);
      assert.match(evidence[0].text, /Eight hertz/);
      return Response.json({
        choices: [
          {
            message: {
              content: `Use the frozen note [${content.segments[0].id}] [unselected:secret].`,
            },
          },
        ],
      });
    },
    undefined,
    {
      attachments: [{ ...content, imageData }],
      createBookmark: async () => {
        bookmarks++;
      },
    },
  );
  assert.equal(bookmarks, 0);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].kind, 'attachment');
  if (result.citations[0].kind === 'attachment')
    assert.equal(result.citations[0].attachmentId, attachment.id);
});

test('historical attachment identities never resend images or grant readable evidence to another question', async () => {
  const attachment = questionAttachmentSchema.parse({
    id: crypto.randomUUID(),
    sessionId,
    name: 'Earlier image',
    kind: 'file',
    sourceId,
    sourceVersion: 1,
    sourceName: file.name,
    location: {},
    segmentCount: 1,
    textBytes: 10,
    createdAt: 'today',
  });
  let calls = 0;
  const result = await runAssistant(
    'placeholder',
    'model',
    'A different question',
    [{ role: 'user', content: 'Earlier request', attachments: [attachmentMention(attachment)] }],
    [],
    { count: 0, correct: 0, percent: 0, needsPractice: [], evidence: 'Recorded attempts only' },
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      assert.equal(typeof body.messages.at(-1).content, 'string');
      assert.doesNotMatch(JSON.stringify(body.messages), /image_url|data:image/);
      if (++calls === 1) {
        assert.match(body.messages[0].content, /Available segment index: \[\]/);
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'read',
                    type: 'function',
                    function: {
                      name: 'read_segments',
                      arguments: JSON.stringify({ ids: [`attachment.${attachment.id}.part-1`] }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      assert.deepEqual(
        JSON.parse(body.messages.find((item: { role: string }) => item.role === 'tool').content),
        [],
      );
      return Response.json({
        choices: [{ message: { content: 'Reattach the image to inspect it.' } }],
      });
    },
  );
  assert.deepEqual(result.citations, []);
});
