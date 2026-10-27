import { z } from 'zod';
import { locationSchema, type SourceLocation } from './locations';
export { locationSchema, type SourceLocation } from './locations';
import {
  captureSelectionsSchema,
  sourceStampsSchema,
  publishedCaptureSchema,
  type PublishedCapture,
} from './captures';
import { MAX_RESOURCE_TABS, type StudySession, type Source } from './domain';

export const annotationQuerySchema = z.object({
  sessionId: z.string().uuid(),
  sourceIds: z
    .array(z.string().uuid())
    .max(MAX_RESOURCE_TABS * 2)
    .refine((ids) => new Set(ids).size === ids.length),
  includeSession: z.boolean().default(false),
  kind: z.enum(['annotation', 'bookmark']).default('annotation'),
  after: z.string().max(512).nullable().optional(),
});
export type AnnotationQuery = z.infer<typeof annotationQuerySchema>;
export function annotationQueryPrefixes(query: AnnotationQuery) {
  return [
    ...[...query.sourceIds].sort().map((id) => `annotation-source-summary:${id}:`),
    ...(query.includeSession ? [`annotation-unbound-summary:${query.sessionId}:`] : []),
  ];
}
export function annotationScopeKey(value: {
  id: string;
  sourceId: string | null;
  sessionId: string;
}) {
  return value.sourceId
    ? `annotation-source-summary:${value.sourceId}:${value.id}`
    : `annotation-unbound-summary:${value.sessionId}:${value.id}`;
}

export async function readAnnotationQueryPage(
  query: AnnotationQuery,
  read: (options: {
    prefix: string;
    limit: number;
    startAfter?: string;
  }) => Promise<Map<string, AnnotationSummary>>,
): Promise<{ items: AnnotationSummary[]; nextCursor: string | null } | { error: string }> {
  const prefixes = annotationQueryPrefixes(query);
  let start = 0;
  if (query.after) {
    start = prefixes.findIndex((prefix) => query.after!.startsWith(prefix));
    if (
      start < 0 ||
      !z.string().uuid().safeParse(query.after.slice(prefixes[start].length)).success
    )
      return { error: 'Annotation selection changed; reload its first page' };
  }
  const items: AnnotationSummary[] = [];
  let scanned = 0;
  for (let index = start; index < prefixes.length; index++) {
    const entries = await read({
      prefix: prefixes[index],
      limit: 100 - scanned,
      ...(index === start && query.after ? { startAfter: query.after } : {}),
    });
    scanned += entries.size;
    items.push(
      ...[...entries.values()].filter((item) => (item.kind || 'annotation') === query.kind),
    );
    if (scanned === 100) return { items, nextCursor: [...entries.keys()].at(-1)! };
  }
  return { items, nextCursor: null };
}

export type RichNode = {
  type: string;
  text?: string;
  content?: RichNode[];
  attrs?: {
    level?: number;
    start?: number;
    colspan?: number;
    rowspan?: number;
    colwidth?: number[] | null;
    language?: string | null;
    latex?: string;
  };
  marks?: Array<{ type: string; attrs?: { href: string } }>;
};
const safeLink = z
  .string()
  .max(2048)
  .refine(
    (value) => /^(https?:\/\/|mailto:)/i.test(value) && !/[\u0000-\u0020]/.test(value),
    'Use an https, http or mailto link',
  );
const richNode: z.ZodType<RichNode> = z.lazy(() =>
  z.object({
    type: z.enum([
      'doc',
      'paragraph',
      'text',
      'heading',
      'bulletList',
      'orderedList',
      'listItem',
      'blockquote',
      'codeBlock',
      'hardBreak',
      'horizontalRule',
      'table',
      'tableRow',
      'tableCell',
      'tableHeader',
      'inlineMath',
      'blockMath',
    ]),
    text: z.string().max(40000).optional(),
    content: z.array(richNode).max(2000).optional(),
    attrs: z
      .object({
        level: z.number().int().min(1).max(3).optional(),
        start: z.number().int().min(1).max(9999).optional(),
        colspan: z.number().int().min(1).max(20).optional(),
        rowspan: z.number().int().min(1).max(100).optional(),
        colwidth: z.array(z.number().min(25).max(2000)).max(20).nullable().optional(),
        language: z.string().max(40).nullable().optional(),
        latex: z.string().max(8000).optional(),
      })
      .optional(),
    marks: z
      .array(
        z
          .object({
            type: z.enum(['bold', 'italic', 'underline', 'strike', 'code', 'link']),
            attrs: z.object({ href: safeLink }).optional(),
          })
          .refine((mark) => mark.type !== 'link' || !!mark.attrs?.href),
      )
      .max(6)
      .optional(),
  }),
);
function boundedDocument(value: unknown) {
  const stack = [{ value, depth: 0 }],
    seen = new Set<object>();
  let count = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (
      ++count > 4000 ||
      item.depth > 24 ||
      !item.value ||
      typeof item.value !== 'object' ||
      seen.has(item.value)
    )
      return false;
    seen.add(item.value);
    const content = (item.value as { content?: unknown }).content;
    if (content !== undefined && !Array.isArray(content)) return false;
    if (Array.isArray(content))
      for (const child of content) stack.push({ value: child, depth: item.depth + 1 });
  }
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= 80000;
}
export const richDocumentSchema = z
  .unknown()
  .refine(boundedDocument, 'Annotation document is too large or deeply nested')
  .pipe(richNode)
  .refine((node) => node.type === 'doc');
export function plainDocument(text = ''): RichNode {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      ...(line ? { content: [{ type: 'text', text: line }] } : {}),
    })),
  };
}
export function richText(node: RichNode): string {
  if (node.type === 'inlineMath' || node.type === 'blockMath') return node.attrs?.latex || '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const text = (node.content || [])
    .map(richText)
    .join(
      ['doc', 'bulletList', 'orderedList', 'blockquote', 'table', 'tableRow'].includes(node.type)
        ? '\n'
        : '',
    );
  return text;
}
export const strokeSchema = z.object({
  /** A pin marks one point for a numbered comment; strokes are freehand lines. */
  kind: z.literal('pin').optional(),
  color: z.enum(['#007f76', '#e5913f', '#1f6bbb', '#c33d45', '#202f36']),
  width: z.number().min(1).max(12),
  points: z
    .array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }))
    .min(1)
    .max(2000),
});
export type DrawingStroke = z.infer<typeof strokeSchema>;
export const drawingSchema = z
  .array(strokeSchema)
  .max(100)
  .refine(
    (strokes) => strokes.reduce((sum, stroke) => sum + stroke.points.length, 0) <= 3000,
    'Drawing is too detailed; save this annotation and start another',
  );
export const annotationInputSchema = z
  .object({
    kind: z.enum(['annotation', 'bookmark']).default('annotation'),
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    sourceId: z.string().uuid().nullable(),
    sourceVersion: z.number().int().positive().nullable(),
    title: z.string().trim().max(240),
    document: richDocumentSchema,
    location: locationSchema,
    strokes: drawingSchema.default([]),
    origin: z.enum(['manual', 'tutor']).default('manual'),
    references: z.array(z.string().uuid()).max(20).default([]),
    expectedRevision: z.number().int().nonnegative(),
    mutationId: z.string().uuid().optional(),
    captures: captureSelectionsSchema.optional(),
    stamps: sourceStampsSchema.optional(),
  })
  .refine(
    (value) => (value.captures === undefined && value.stamps === undefined) || !!value.mutationId,
    'Capture and location saves require a mutation identity',
  )
  .refine(
    (value) => value.kind !== 'bookmark' || (!value.captures?.length && !value.stamps?.length),
    'Bookmarks use a single source location',
  );
export type AnnotationInput = z.infer<typeof annotationInputSchema>;
export type Annotation = Omit<
  AnnotationInput,
  'expectedRevision' | 'kind' | 'mutationId' | 'captures'
> & {
  captures?: PublishedCapture[];
  kind?: 'annotation' | 'bookmark';
  revision: number;
  text: string;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  capture?: {
    id: string;
    width: number;
    height: number;
    size: number;
    operationId?: string;
    digest?: string;
  };
};
export type AnnotationSummary = Omit<Annotation, 'document' | 'strokes'> & { strokeCount: number };
const {
  expectedRevision: _snapshotRevision,
  mutationId: _snapshotMutation,
  captures: _snapshotSelections,
  ...snapshotFields
} = annotationInputSchema.shape;
export const annotationSnapshotSchema = z.object({
  ...snapshotFields,
  captures: z.array(publishedCaptureSchema).max(12).optional(),
  revision: z.number().int().positive(),
  text: z.string().max(120000),
  deleted: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  capture: z
    .object({
      id: z.string().uuid(),
      width: z.number().int().positive().max(4096),
      height: z.number().int().positive().max(4096),
      size: z
        .number()
        .int()
        .positive()
        .max(8 * 1024 * 1024),
      operationId: z.string().uuid().optional(),
      digest: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .optional(),
});
export function annotationSummary({
  document: _document,
  strokes,
  ...annotation
}: Annotation): AnnotationSummary {
  return { ...annotation, text: annotation.text.slice(0, 1000), strokeCount: strokes.length };
}
export async function migratedAnnotations(
  session: StudySession,
  files: Source[],
): Promise<Annotation[]> {
  return Promise.all(
    session.notes.map(async (note) => {
      return {
        id: await stableAnnotationId(`${session.id}:${note.id}`),
        kind: 'annotation' as const,
        sessionId: session.id,
        sourceId: note.sourceId,
        sourceVersion: files.find((file) => file.id === note.sourceId)?.version || 1,
        title: note.text.split('\n')[0].slice(0, 80),
        document: plainDocument(note.text),
        location: {},
        strokes: [],
        origin: 'manual' as const,
        references: [note.sourceId],
        revision: 1,
        text: note.text,
        deleted: false,
        createdAt: note.createdAt,
        updatedAt: note.createdAt,
      };
    }),
  );
}

export async function stableAnnotationId(seed: string) {
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed)),
  );
  hash[6] = (hash[6] & 15) | 128;
  hash[8] = (hash[8] & 63) | 128;
  const hex = [...hash.slice(0, 16)].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function migratedBookmarks(
  session: StudySession,
  files: Source[],
): Promise<Annotation[]> {
  return Promise.all(
    session.bookmarks.map(async (bookmark) => ({
      id: await stableAnnotationId(`bookmark:${session.id}:${bookmark.id}`),
      kind: 'bookmark' as const,
      sessionId: session.id,
      sourceId: bookmark.sourceId,
      sourceVersion: files.find((file) => file.id === bookmark.sourceId)?.version || 1,
      title: bookmark.label,
      document: plainDocument(bookmark.label),
      text: bookmark.label,
      location: {
        ...(bookmark.page ? { page: bookmark.page } : {}),
        ...(bookmark.seconds != null ? { seconds: bookmark.seconds } : {}),
      },
      strokes: [],
      origin: 'manual' as const,
      references: [bookmark.sourceId],
      revision: 1,
      deleted: false,
      createdAt: session.createdAt,
      updatedAt: session.createdAt,
    })),
  );
}
