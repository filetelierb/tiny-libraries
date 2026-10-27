import { z } from 'zod';
import { assessmentBatchSchema, assessmentAnalysisSchema } from '../shared/assessments';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCanvas } from '@napi-rs/canvas';
import type { R2Bucket } from '@cloudflare/workers-types';
import { MemoryStore } from './storage';
import { CaptureStore } from '../worker/capture-store';
import { renderCapture } from '../server/capture-render';
import { emptyCaptureDrawing } from '../shared/capture-drawing';
import { captureDrawingDigest, captureDigest } from '../shared/captures';
import { plainDocument, type Annotation } from '../shared/annotations';
import { createQuestionAttachment } from '../worker/tutor-attachments';
import { composeCapture } from '../server/capture-image';
import {
  attachmentImages,
  imageEvidenceSegments,
  type QuestionAttachment,
} from '../shared/tutor-attachments';
import {
  assessmentConfigSchema,
  validateAssessmentCitation,
  validateAssessmentBatch,
  assessmentMarkdown,
  type AssessmentContext,
  type AssessmentConfig,
  type AssessmentBatch,
  type AssessmentCitation,
} from '../shared/assessments';
import {
  createAssessment,
  assessmentDetail,
  assessmentAction,
  saveAssessmentAnswer,
} from '../worker/assessments';
import { captureAssessmentContext } from '../worker/assessment-context';
import { readAssessmentImages, assessmentEvidenceContent } from '../worker/assessment-vision';
import { assessmentHTML } from '../worker/assessment-export';
import { generateAssessmentBatch, analyzeAssessment } from '../worker/meta';
import type { Source, StudySession } from '../shared/domain';

async function fixture(count = 12, origin = true) {
  const memory = new MemoryStore(),
    storage = memory.storage(),
    sessionId = crypto.randomUUID(),
    sourceId = crypto.randomUUID(),
    noteId = crypto.randomUUID(),
    blobs = new Map<string, Uint8Array>(),
    reads: string[] = [];
  const files = {
    async get(key: string) {
      reads.push(key);
      const b = blobs.get(key);
      return b ? { size: b.length, arrayBuffer: async () => new Uint8Array(b).buffer } : null;
    },
    async put(key: string, bytes: Uint8Array) {
      blobs.set(key, new Uint8Array(bytes));
    },
    async delete(key: string) {
      blobs.delete(key);
    },
  } as unknown as Pick<R2Bucket, 'get' | 'put' | 'delete'>;
  const session: StudySession = {
    id: sessionId,
    name: 'Image review',
    tabs: [],
    active: null,
    split: null,
    positions: {},
    notes: [],
    bookmarks: [],
    artifacts: {},
    conversations: {},
    createdAt: 'today',
  };
  const source: Source = {
    id: sourceId,
    version: 1,
    name: 'Authored study pages.pdf',
    kind: 'pdf',
    folder: '',
    mime: 'application/pdf',
    size: 100,
    archived: false,
    reviewed: false,
    createdAt: 'today',
  };
  await memory.put(`session:${sessionId}`, session);
  await memory.put(`file:${sourceId}`, source);
  const captures = new CaptureStore(
    storage,
    {
      read: async (k) => blobs.get(k) || null,
      write: async (k, b) => {
        blobs.set(k, b);
      },
    },
    renderCapture,
  );
  const selections = [];
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID(),
      canvas = createCanvas(128, 64),
      ctx = canvas.getContext('2d');
    ctx.fillStyle = i % 2 ? '#22aa88' : '#ffbb44';
    ctx.fillRect(0, 0, 128, 64);
    await captures.create({
      annotationId: noteId,
      id,
      sessionId,
      sourceId,
      sourceVersion: 1,
      origin: 'pdf_page',
      ...(origin
        ? {
            stamp: {
              id: crypto.randomUUID(),
              sourceId,
              sourceVersion: 1,
              label: `Page ${i + 1}`,
              location: { page: i + 1 },
            },
          }
        : {}),
    });
    await captures.putBase(noteId, id, new Uint8Array(canvas.toBuffer('image/png')));
    const drawing = emptyCaptureDrawing({ width: 128, height: 64 });
    drawing.crop = { x: 0, y: 0, width: 0.5, height: 1 };
    drawing.objects = [
      {
        id: crypto.randomUUID(),
        kind: 'redact',
        shape: 'rect',
        points: [
          { x: 0.3, y: 0.2 },
          { x: 0.45, y: 0.8 },
        ],
        width: 20,
      },
    ];
    const version = await captures.putDrawing(
      noteId,
      id,
      await captureDrawingDigest(drawing),
      drawing,
    );
    selections.push({ ...version, label: `Study image ${i + 1}` });
  }
  const note: Annotation = {
    id: noteId,
    sessionId,
    sourceId,
    sourceVersion: 1,
    title: 'Authored <script>study note</script>',
    document: plainDocument('Study these saved figures.'),
    text: 'Study these saved figures.',
    location: { page: 1 },
    revision: 1,
    deleted: false,
    createdAt: 'today',
    updatedAt: 'today',
    strokes: [],
    origin: 'manual',
    references: [sourceId],
    captures: selections,
  };
  await memory.put(`annotation:${noteId}`, note);
  const attachment = await createQuestionAttachment(
    storage,
    files,
    {
      id: crypto.randomUUID(),
      sessionId,
      kind: 'annotation',
      annotationId: noteId,
      revision: 1,
      captureIds: selections.map((item) => item.id),
    },
    composeCapture,
    captures,
  );
  const config: AssessmentConfig = {
    sourceIds: [],
    attachmentIds: [attachment.id],
    count: 12,
    difficulty: 'easy',
    guidance: 'Use choice questions.',
    priorReportIds: [],
  };
  reads.length = 0;
  return { memory, storage, files, blobs, reads, sessionId, sourceId, note, attachment, config };
}
function imageCitation(context: AssessmentContext, index = 0): AssessmentCitation {
  const { attachment, segments } = context.attachments![0],
    image = attachmentImages(attachment)[index];
  return {
    kind: 'attachment',
    attachmentId: attachment.id,
    imageId: image.id,
    segmentId: imageEvidenceSegments(image, segments)[0].id,
    quote: '',
  };
}
function batch(context: AssessmentContext, index = 0): AssessmentBatch {
  const citations = Array.from({ length: 12 }, (_, i) =>
    imageCitation(context, i % attachmentImages(context.attachments![0].attachment).length),
  );
  return {
    title: 'Saved figure review',
    topics: [
      {
        id: 'figures',
        title: 'Saved figures',
        summary: 'Observe the selected figures.',
        concepts: ['Visual evidence'],
        citations: [citations[0]],
      },
    ],
    coverageNotes: [],
    questions: citations.map((citation, i) => ({
      id: `q${i}`,
      topicId: 'figures',
      type: 'choice',
      difficulty: 'easy',
      difficultyReason: 'Observe a selected figure.',
      prompt: `Batch ${index} figure question ${i + 1}?`,
      options: [
        { id: 'a', text: 'Teal' },
        { id: 'b', text: 'Amber' },
        { id: 'c', text: 'Violet' },
        { id: 'd', text: 'Blue' },
      ],
      correctOptionId: 'a',
      acceptedAnswers: [],
      prompts: [],
      matches: [],
      explanation: 'The supplied flattened image supports this observation.',
      citations: [citation],
    })),
  };
}
function operations(
  f: Awaited<ReturnType<typeof fixture>>,
  tasks: Promise<void>[],
  overrides: Partial<Parameters<typeof createAssessment>[2]> = {},
) {
  return {
    owner: 'first-runtime',
    settings: { configured: true, locale: 'en' as const, model: 'test' },
    start: (task: Promise<void>) => {
      tasks.push(task);
    },
    generate: async (
      context: AssessmentContext,
      _config: AssessmentConfig,
      _previous: string[],
      index: number,
    ) => {
      const images = await readAssessmentImages(f.files, context);
      assert.equal(images.length, attachmentImages(f.attachment).length);
      assessmentEvidenceContent(context, {}, images);
      return batch(context, index);
    },
    analyze: async (
      context: AssessmentContext,
      plan: Parameters<Parameters<typeof createAssessment>[2]['analyze']>[1],
    ) => {
      const images = await readAssessmentImages(f.files, context);
      assessmentEvidenceContent(context, {}, images);
      return {
        analysis:
          'An observed review sample, not a claim about ability. <img src=x onerror=alert(1)>',
        topics: plan.topics.map((t) => ({
          topicId: t.id,
          analysis: 'Review these saved figures.',
        })),
        recommendations: plan.topics.map((t) => ({
          topicId: t.id,
          title: 'Review the saved figure',
          reason: 'The unknown response supports reviewing this figure.',
          citations: [imageCitation(context)],
        })),
      };
    },
    ...overrides,
  };
}
async function finish(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  tasks: Promise<void>[],
  ops: ReturnType<typeof operations>,
) {
  const detail = await assessmentDetail(f.storage, id, ops.owner);
  assert.equal(detail.status, 'ready');
  for (const q of detail.plan!.questions)
    await saveAssessmentAnswer(f.storage, id, {
      requestId: crypto.randomUUID(),
      questionId: q.id,
      expectedRevision: 0,
      response: '',
      confidence: 'unknown',
    });
  await assessmentAction(f.storage, id, { action: 'finish' }, ops);
  await Promise.all(tasks);
  return assessmentDetail(f.storage, id, ops.owner);
}

test('assessment configuration accepts explicit saved evidence alone and preserves old source-only shapes', async () => {
  const f = await fixture(1);
  assert.deepEqual(assessmentConfigSchema.parse(f.config), f.config);
  assert.equal(assessmentConfigSchema.safeParse({ ...f.config, attachmentIds: [] }).success, false);
  const { attachmentIds: _ids, ...old } = f.config;
  assert.deepEqual(assessmentConfigSchema.parse({ ...old, sourceIds: [f.sourceId] }), {
    ...old,
    sourceIds: [f.sourceId],
  });
});

test('capture-only assessments retain all twelve snapshots independently of edited originals and tutor records', async () => {
  const f = await fixture(),
    tasks: Promise<void>[] = [],
    ops = operations(f, tasks),
    id = crypto.randomUUID();
  await createAssessment(
    f.storage,
    { requestId: id, sessionId: f.sessionId, config: f.config },
    ops,
  );
  await Promise.all(tasks);
  const first = await assessmentDetail(f.storage, id, ops.owner);
  assert.equal(first.status, 'ready');
  assert.equal(first.context.sources.length, 0);
  assert.equal(first.context.attachments![0].attachment.images!.length, 12);
  await f.memory.put(`annotation:${f.note.id}`, {
    ...f.note,
    revision: 2,
    deleted: true,
    captures: [],
  });
  await f.memory.delete(`tutor-attachment:${f.attachment.id}`);
  const later = await assessmentDetail(f.storage, id, 'second-runtime');
  assert.deepEqual(later.context, first.context);
  assert.deepEqual(later.plan, first.plan);
  const images = await readAssessmentImages(f.files, later.context);
  assert.equal(images.length, 12);
  assert.ok(f.reads.every((key) => key.startsWith('tutor-attachment/')));
  const exported = assessmentHTML(
    {
      ...later,
      status: 'completed',
      report: { score: 0, count: 12, analysis: 'Observed sample', topics: [], recommendations: [] },
    },
    images,
  );
  assert.equal((exported.match(/<img src="data:image\/png;base64,/g) || []).length, 12);
});

test('visual citations pin the selected image and segment; inferred observations do not become literal quotes', async () => {
  const f = await fixture(),
    context = await captureAssessmentContext(f.storage, f.sessionId, f.config),
    valid = imageCitation(context, 11);
  assert.equal(validateAssessmentCitation(valid, context).kind, 'attachment');
  assert.throws(
    () => validateAssessmentCitation({ ...valid, quote: 'Invented source text' }, context),
    /outside/,
  );
  assert.throws(
    () =>
      validateAssessmentCitation(
        { ...valid, imageId: attachmentImages(f.attachment)[0].id },
        context,
      ),
    /outside/,
  );
  assert.throws(
    () => validateAssessmentCitation({ ...valid, attachmentId: crypto.randomUUID() }, context),
    /outside/,
  );
  assert.equal(validateAssessmentBatch(batch(context), context, f.config).questions.length, 12);
});

test('review generation and report analysis send all selected flattened images in a user message', async () => {
  const f = await fixture(),
    context = await captureAssessmentContext(f.storage, f.sessionId, f.config),
    images = await readAssessmentImages(f.files, context);
  let calls = 0;
  const transport = async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(options.body as string),
      parts = body.messages.at(-1).content;
    assert.equal(body.messages.at(-1).role, 'user');
    assert.deepEqual(
      parts
        .filter((p: { type: string }) => p.type === 'image_url')
        .map((p: { image_url: { url: string } }) => p.image_url.url),
      images.map((i) => i.data),
    );
    calls++;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify(
              calls === 1
                ? batch(context)
                : {
                    analysis: 'Observed sample',
                    topics: [{ topicId: 'figures', analysis: 'Review the figures.' }],
                    recommendations: [
                      {
                        topicId: 'figures',
                        title: 'Review',
                        reason: 'An unknown answer supports another look.',
                        citations: [imageCitation(context, 11)],
                      },
                    ],
                  },
            ),
          },
        },
      ],
    });
  };
  const plan = await generateAssessmentBatch(
    'test',
    'model',
    context,
    f.config,
    [],
    0,
    'en',
    transport,
    images,
  );
  await analyzeAssessment('test', 'model', context, plan, [], 'en', transport, images);
  assert.equal(calls, 2);
  await assert.rejects(
    generateAssessmentBatch(
      'test',
      'model',
      context,
      f.config,
      [],
      0,
      'en',
      transport,
      images.slice(0, 2),
    ),
    /incomplete/,
  );
  assert.equal(calls, 2);
});

test('assessment retries use the entire saved selection after a later batch fails and notes change', async () => {
  const f = await fixture(),
    tasks: Promise<void>[] = [],
    id = crypto.randomUUID();
  let fail = true;
  const ops = operations(f, tasks, {
    generate: async (context, _config, _previous, index) => {
      assert.equal((await readAssessmentImages(f.files, context)).length, 12);
      if (index === 1 && fail) throw new Error('Interrupted second batch');
      return batch(context, index);
    },
  });
  await createAssessment(
    f.storage,
    { requestId: id, sessionId: f.sessionId, config: { ...f.config, count: 24 } },
    ops,
  );
  await Promise.all(tasks);
  const partial = await assessmentDetail(f.storage, id, ops.owner);
  assert.equal(partial.completedBatches, 1);
  assert.equal(partial.status, 'failed');
  await f.memory.delete(`tutor-attachment:${f.attachment.id}`);
  await f.memory.put(`annotation:${f.note.id}`, { ...f.note, revision: 2, deleted: true });
  fail = false;
  const next = { ...ops, owner: 'next-runtime' };
  await assessmentAction(f.storage, id, { action: 'retry' }, next);
  await Promise.all(tasks);
  const ready = await assessmentDetail(f.storage, id, next.owner);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.plan!.questions.length, 24);
  assert.deepEqual(ready.context, partial.context);
  assert.deepEqual(ready.plan!.questions.slice(0, 12), partial.plan!.questions);
});

test('missing image bytes fail review generation without changing the frozen evidence and retry restores it', async () => {
  const f = await fixture(3),
    tasks: Promise<void>[] = [],
    ops = operations(f, tasks),
    id = crypto.randomUUID(),
    image = f.attachment.images![2],
    key = `tutor-attachment/${f.attachment.id}/${image.id}`,
    bytes = f.blobs.get(key)!;
  f.blobs.delete(key);
  await createAssessment(
    f.storage,
    { requestId: id, sessionId: f.sessionId, config: f.config },
    ops,
  );
  await Promise.all(tasks);
  const failed = await assessmentDetail(f.storage, id, ops.owner);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.context.attachments![0].attachment.images!.length, 3);
  f.blobs.set(key, bytes);
  await assessmentAction(f.storage, id, { action: 'retry' }, ops);
  await Promise.all(tasks);
  assert.equal((await assessmentDetail(f.storage, id, ops.owner)).status, 'ready');
});

test('image reports export all exact previews safely and keep precise origin bookmarks', async () => {
  const f = await fixture(),
    tasks: Promise<void>[] = [],
    ops = operations(f, tasks),
    id = crypto.randomUUID();
  await createAssessment(
    f.storage,
    { requestId: id, sessionId: f.sessionId, config: f.config },
    ops,
  );
  await Promise.all(tasks);
  const detail = await finish(f, id, tasks, ops);
  assert.equal(detail.status, 'completed');
  const images = await readAssessmentImages(f.files, detail.context),
    html = assessmentHTML(detail, images);
  assert.doesNotMatch(html, /<script|onerror="|<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /Content-Security-Policy/);
  const embedded = [...html.matchAll(/<img src="data:image\/png;base64,([^"]+)"/g)].map(
    (m) => new Uint8Array(Buffer.from(m[1], 'base64')),
  );
  assert.equal(embedded.length, 12);
  for (let i = 0; i < 12; i++)
    assert.equal(await captureDigest(embedded[i]), images[i].image.digest);
  assert.match(assessmentMarkdown(detail), /Visual observation.*no literal source quote/);
  assert.match(assessmentMarkdown(detail), /SHA-256/);
  const bookmarkId = detail.report!.recommendations[0].bookmarkId!;
  assert.ok(bookmarkId);
  const bookmark = await f.memory.get<Annotation>(`annotation:${bookmarkId}`);
  assert.equal(bookmark!.sourceId, f.sourceId);
  assert.deepEqual(bookmark!.location, { page: 1 });
});

test('a locally imported capture never creates an unrelated source bookmark', async () => {
  const f = await fixture(1, false),
    tasks: Promise<void>[] = [],
    ops = operations(f, tasks),
    id = crypto.randomUUID();
  await createAssessment(
    f.storage,
    { requestId: id, sessionId: f.sessionId, config: f.config },
    ops,
  );
  await Promise.all(tasks);
  const detail = await finish(f, id, tasks, ops);
  assert.equal(detail.status, 'completed');
  assert.equal(detail.report!.recommendations[0].bookmarkId, undefined);
});

test('follow-up includes visual prior results only when their frozen selection is explicitly retained', async () => {
  const f = await fixture(2),
    tasks: Promise<void>[] = [],
    ops = operations(f, tasks),
    id = crypto.randomUUID();
  await createAssessment(
    f.storage,
    { requestId: id, sessionId: f.sessionId, config: f.config },
    ops,
  );
  await Promise.all(tasks);
  await finish(f, id, tasks, ops);
  const follow = await captureAssessmentContext(f.storage, f.sessionId, {
    ...f.config,
    priorReportIds: [id],
  });
  assert.equal(follow.prior.length, 12);
  const none = await captureAssessmentContext(f.storage, f.sessionId, {
    ...f.config,
    attachmentIds: [],
    priorReportIds: [id],
  });
  assert.equal(none.prior.length, 0);
  assert.match(none.gaps.join(' '), /excluded/);
});

test('saved evidence from another session or an over-budget selection is rejected before assessment creation', async () => {
  const f = await fixture(),
    tasks: Promise<void>[] = [],
    ops = operations(f, tasks),
    id = crypto.randomUUID();
  const other = { ...f.attachment, sessionId: crypto.randomUUID() };
  await f.memory.put(`tutor-attachment:${other.id}`, other);
  await assert.rejects(
    createAssessment(f.storage, { requestId: id, sessionId: f.sessionId, config: f.config }, ops),
    /this study session/,
  );
  assert.equal(await f.memory.get(`assessment:${id}`), undefined);
  const oversized = {
    ...f.attachment,
    images: f.attachment.images!.map((image) => ({ ...image, size: 3 * 1024 * 1024 })),
  };
  await f.memory.put(`tutor-attachment:${oversized.id}`, oversized);
  await assert.rejects(
    createAssessment(f.storage, { requestId: id, sessionId: f.sessionId, config: f.config }, ops),
    /12 MB/,
  );
  assert.equal(await f.memory.get(`assessment:${id}`), undefined);
  assert.equal(tasks.length, 0);
});

test('assessment response schemas require every object property for strict model output', () => {
  function inspect(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(inspect);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (object.properties) {
      const required = object.required as string[];
      assert.ok(Array.isArray(required));
      for (const key of Object.keys(object.properties as object))
        assert.ok(
          required.includes(key),
          `Provider response field ${key} must be required; optional values must be nullable`,
        );
    }
    Object.values(object).forEach(inspect);
  }
  inspect(z.toJSONSchema(assessmentBatchSchema));
  inspect(z.toJSONSchema(assessmentAnalysisSchema));
});
