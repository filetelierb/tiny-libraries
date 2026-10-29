import { z } from 'zod';
import { segmentSchema } from './domain';
import { assessmentCounts, difficulties } from './assessments';
import type { RichNode } from './annotations';

/**
 * What the tutor may do in the library on the student's behalf. Each action runs through the
 * same routes as the app; deleting and merging wait for the student's confirmation in the chat.
 */
const itemSchema = { type: z.enum(['file', 'folder']), id: z.string().uuid() };
const name = z.string().trim().min(1).max(200);
const path = z.string().trim().max(240);
export const tutorActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('folder.create'), parentPath: path, name }),
  z.object({ op: z.literal('item.rename'), ...itemSchema, name }),
  z.object({ op: z.literal('item.move'), ...itemSchema, destination: path }),
  z.object({
    op: z.enum(['item.archive', 'item.unarchive', 'item.trash', 'item.restore', 'item.delete']),
    ...itemSchema,
  }),
  z.object({
    op: z.literal('note.create'),
    kind: z.enum(['annotation', 'bookmark']),
    title: z.string().trim().min(1).max(240),
    text: z.string().trim().max(20000),
    sourceId: z.string().uuid().nullable(),
    sourceVersion: z.number().int().positive().nullable(),
    segment: segmentSchema.nullable(),
  }),
  z.object({
    op: z.literal('note.update'),
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(240).optional(),
    text: z.string().trim().max(20000).optional(),
  }),
  z.object({ op: z.literal('note.delete'), id: z.string().uuid() }),
  z.object({
    op: z.literal('concept.merge'),
    sourceId: z.string().uuid(),
    targetId: z.string().uuid(),
  }),
  z.object({
    op: z.literal('test.start'),
    sourceIds: z.array(z.string().uuid()).min(1).max(40),
    count: z.number().refine((value) => assessmentCounts.includes(value as 12)),
    difficulty: z.enum(difficulties),
    guidance: z.string().trim().max(4000),
  }),
]);
export type TutorAction = z.infer<typeof tutorActionSchema>;
export type TutorActionOp = TutorAction['op'];
/** Actions that change nothing until the student confirms them. */
export const confirmedOps: ReadonlySet<TutorActionOp> = new Set([
  'item.trash',
  'item.delete',
  'note.delete',
  'concept.merge',
]);

/** One line of the reply's action log, or a confirmation card while it is proposed. */
export const replyActionSchema = z.object({
  id: z.string().uuid(),
  op: z.string().max(40),
  /** The record acted on, by name, as the student sees it. */
  subject: z.string().max(300),
  /** The new name, destination or merge target. */
  detail: z.string().max(300).optional(),
  status: z.enum(['done', 'proposed']),
  /** The test a test.start action created. */
  testId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
});
export type ReplyAction = z.infer<typeof replyActionSchema>;
export type TutorActionRecord = ReplyAction & {
  conversationId: string;
  action: TutorAction;
  state: 'proposed' | 'running' | 'done' | 'cancelled' | 'failed';
  error?: string;
  createdAt: string;
  updatedAt: string;
};
export type TutorActionState = Pick<
  TutorActionRecord,
  'id' | 'op' | 'subject' | 'detail' | 'state' | 'error' | 'testId' | 'sessionId'
>;
export const actionState = (record: TutorActionRecord): TutorActionState => ({
  id: record.id,
  op: record.op,
  subject: record.subject,
  ...(record.detail ? { detail: record.detail } : {}),
  state: record.state,
  ...(record.error ? { error: record.error } : {}),
  ...(record.testId ? { testId: record.testId } : {}),
  ...(record.sessionId ? { sessionId: record.sessionId } : {}),
});

type Mark = NonNullable<RichNode['marks']>[number];
/** Inline Markdown the tutor writes: bold, italic, code and \( math \) or $math$. */
function inline(text: string): RichNode[] {
  const nodes: RichNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|`([^`]+)`|\\\((.+?)\\\)|\$([^$\n]+)\$/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index! > last) nodes.push({ type: 'text', text: text.slice(last, match.index) });
    const [, bold, italic, code, math, dollar] = match;
    const mark = (value: string, type: Mark['type']) =>
      nodes.push({ type: 'text', text: value, marks: [{ type }] });
    if (bold) mark(bold, 'bold');
    else if (italic) mark(italic, 'italic');
    else if (code) mark(code, 'code');
    else nodes.push({ type: 'inlineMath', attrs: { latex: (math || dollar).trim() } });
    last = match.index! + match[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes;
}
const paragraph = (text: string): RichNode =>
  text ? { type: 'paragraph', content: inline(text) } : { type: 'paragraph' };

/** A note document from the Markdown the tutor writes: headings, lists, quotes and math. */
export function markdownDocument(markdown: string): RichNode {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const content: RichNode[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: Math.min(3, heading[1].length) },
        content: inline(heading[2]),
      });
      continue;
    }
    if (line.trim() === '$$' || line.trim() === '\\[') {
      const end = line.trim() === '$$' ? '$$' : '\\]';
      const body: string[] = [];
      while (++index < lines.length && lines[index].trim() !== end) body.push(lines[index]);
      content.push({ type: 'blockMath', attrs: { latex: body.join('\n').trim() } });
      continue;
    }
    const list = line.match(/^\s*([-*]|\d+[.)])\s+/);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const items: RichNode[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*([-*]|\d+[.)])\s+(.*)$/);
        if (!item || /\d/.test(item[1]) !== ordered) break;
        items.push({ type: 'listItem', content: [paragraph(item[2])] });
        index++;
      }
      index--;
      content.push({ type: ordered ? 'orderedList' : 'bulletList', content: items });
      continue;
    }
    if (line.startsWith('>')) {
      const quoted: RichNode[] = [];
      while (index < lines.length && lines[index].startsWith('>'))
        quoted.push(paragraph(lines[index++].replace(/^>\s?/, '')));
      index--;
      content.push({ type: 'blockquote', content: quoted });
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      content.push({ type: 'horizontalRule' });
      continue;
    }
    content.push(paragraph(line));
  }
  // Runs of blank lines collapse to one empty paragraph.
  const compact = content.filter(
    (node, index) =>
      node.type !== 'paragraph' ||
      node.content ||
      (index > 0 && content[index - 1].type !== 'paragraph') ||
      (index > 0 && !!content[index - 1].content),
  );
  return { type: 'doc', content: compact.length ? compact : [{ type: 'paragraph' }] };
}
