import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  annotationInputSchema,
  plainDocument,
  richDocumentSchema,
  richText,
  drawingSchema,
  migratedAnnotations,
  annotationSummary,
  type Annotation,
  type AnnotationSummary,
} from '../shared/annotations';
import { sessionSchema, type Source } from '../shared/domain';

const sourceId = '31c90f6e-93ee-4018-87ab-03964476cb22',
  sessionId = '9dd96b92-aad7-4eea-91cb-1033d393c20d';
test('annotation documents retain rich structures and reject executable links or excessive nesting', () => {
  const cell = {
    type: 'tableCell',
    attrs: { colspan: 1, rowspan: 1, colwidth: null },
    content: plainDocument('Cell').content,
  };
  const table = { type: 'table', content: [{ type: 'tableRow', content: [cell] }] };
  const document = {
    type: 'doc',
    content: [
      {
        type: 'heading',
        attrs: { level: 2 },
        content: [{ type: 'text', text: 'Heading', marks: [{ type: 'bold' }] }],
      },
      table,
    ],
  };
  const parsed = richDocumentSchema.parse(document);
  assert.match(richText(parsed), /Heading\nCell/);
  assert.equal(
    richDocumentSchema.safeParse({
      type: 'doc',
      content: [
        {
          type: 'text',
          text: 'Link',
          marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
        },
      ],
    }).success,
    false,
  );
  let deep: unknown = { type: 'paragraph' };
  for (let i = 0; i < 30; i++) deep = { type: 'blockquote', content: [deep] };
  assert.equal(richDocumentSchema.safeParse({ type: 'doc', content: [deep] }).success, false);
  assert.equal(richDocumentSchema.safeParse(plainDocument('x'.repeat(81000))).success, false);
});
test('drawings use normalized positions and reject unbounded payloads', () => {
  assert.equal(
    drawingSchema.safeParse([
      {
        color: '#007f76',
        width: 3,
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.9, y: 0.2 },
        ],
      },
    ]).success,
    true,
  );
  assert.equal(
    drawingSchema.safeParse([{ color: '#007f76', width: 3, points: [{ x: 1.1, y: 0.2 }] }]).success,
    false,
  );
  assert.equal(
    drawingSchema.safeParse(
      Array.from({ length: 4 }, () => ({
        color: '#007f76',
        width: 3,
        points: Array.from({ length: 1000 }, () => ({ x: 0.1, y: 0.2 })),
      })),
    ).success,
    false,
  );
});
test('saved note migration preserves content and uses stable valid identities without changing the session', async () => {
  const session = sessionSchema.parse({
    id: sessionId,
    name: 'Reading',
    tabs: [sourceId],
    active: sourceId,
    split: null,
    positions: { [sourceId]: 2 },
    notes: [
      { id: 'original-note', sourceId, text: 'First line\nSecond line', createdAt: '2026-10-26' },
    ],
    bookmarks: [],
    createdAt: '2026-10-26',
  });
  const before = JSON.stringify(session),
    files = [{ id: sourceId, version: 1 } as Source];
  const [first] = await migratedAnnotations(session, files),
    [second] = await migratedAnnotations(session, files);
  assert.deepEqual(first, second);
  assert.equal(first.text, 'First line\nSecond line');
  assert.equal(first.sourceId, sourceId);
  assert.equal(JSON.stringify(session), before);
  assert.equal(annotationInputSchema.safeParse({ ...first, expectedRevision: 0 }).success, true);
});
test('annotation summaries omit large documents and drawings without losing source/capture identity', () => {
  const value: Annotation = {
    id: crypto.randomUUID(),
    sessionId,
    sourceId,
    sourceVersion: 1,
    title: 'A note',
    document: plainDocument('content'),
    text: 'x'.repeat(2000),
    location: { page: 2, quote: 'Evidence' },
    strokes: [{ color: '#007f76', width: 3, points: [{ x: 0.2, y: 0.3 }] }],
    origin: 'manual',
    references: [sourceId],
    revision: 2,
    deleted: false,
    createdAt: 'today',
    updatedAt: 'today',
    capture: { id: 'capture', width: 800, height: 600, size: 2000 },
  };
  const summary = annotationSummary(value);
  assert.equal(summary.text.length, 1000);
  assert.equal(summary.strokeCount, 1);
  assert.equal('document' in summary, false);
  assert.equal('strokes' in summary, false);
  assert.deepEqual(summary.capture, value.capture);
  assert.equal(summary.location.page, 2);
});

test('file annotation indexes are independent of their creator session, while unbound notes stay session-scoped', async () => {
  const { annotationScopeKey, annotationQuerySchema, annotationQueryPrefixes } =
    await import('../shared/annotations');
  const id = crypto.randomUUID(),
    secondSession = crypto.randomUUID();
  assert.equal(
    annotationScopeKey({ id, sourceId, sessionId }),
    annotationScopeKey({ id, sourceId, sessionId: secondSession }),
  );
  assert.notEqual(
    annotationScopeKey({ id, sourceId: null, sessionId }),
    annotationScopeKey({ id, sourceId: null, sessionId: secondSession }),
  );
  const input = annotationQuerySchema.parse({
    sessionId,
    sourceIds: [sourceId],
    includeSession: true,
  });
  assert.deepEqual(annotationQueryPrefixes(input), [
    `annotation-source-summary:${sourceId}:`,
    `annotation-unbound-summary:${sessionId}:`,
  ]);
  assert.equal(
    annotationQuerySchema.safeParse({ ...input, sourceIds: [sourceId, sourceId] }).success,
    false,
  );
});

test('multi-resource annotation queries paginate at 100 without duplicates or widening the selected scope', async () => {
  const { annotationQuerySchema, annotationScopeKey, readAnnotationQueryPage } =
    await import('../shared/annotations');
  const otherSource = '41c90f6e-93ee-4018-87ab-03964476cb22',
    hiddenSource = crypto.randomUUID();
  const values = [
    ...Array.from({ length: 103 }, () => ({
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      sourceId,
    })),
    ...Array.from({ length: 2 }, () => ({
      id: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      sourceId: otherSource,
    })),
    { id: crypto.randomUUID(), sessionId, sourceId: null },
    { id: crypto.randomUUID(), sessionId: crypto.randomUUID(), sourceId: null },
    { id: crypto.randomUUID(), sessionId, sourceId: hiddenSource },
  ];
  const records = new Map(
    values.map((item) => [annotationScopeKey(item), item as AnnotationSummary]),
  );
  const read = async ({
    prefix,
    limit,
    startAfter,
  }: {
    prefix: string;
    limit: number;
    startAfter?: string;
  }) =>
    new Map(
      [...records]
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, limit),
    );
  const query = annotationQuerySchema.parse({
    sessionId,
    sourceIds: [otherSource, sourceId],
    includeSession: true,
  });
  const first = await readAnnotationQueryPage(query, read);
  assert.ok(!('error' in first));
  assert.equal(first.items.length, 100);
  assert.ok(first.nextCursor);
  const second = await readAnnotationQueryPage({ ...query, after: first.nextCursor }, read);
  assert.ok(!('error' in second));
  assert.equal(second.items.length, 6);
  assert.equal(second.nextCursor, null);
  const all = [...first.items, ...second.items];
  assert.equal(new Set(all.map((item) => item.id)).size, 106);
  assert.equal(all.filter((item) => !item.sourceId).length, 1);
  assert.ok(all.every((item) => item.sourceId !== hiddenSource));
  const narrowed = await readAnnotationQueryPage(
    { ...query, sourceIds: [otherSource], after: first.nextCursor },
    read,
  );
  assert.ok('error' in narrowed);
  const none = await readAnnotationQueryPage(
    { ...query, sourceIds: [], includeSession: false },
    async () => {
      throw new Error('No resource buckets should be read');
    },
  );
  assert.deepEqual(none, { items: [], nextCursor: null });
});
