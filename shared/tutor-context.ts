import { z } from 'zod';
import { locationSchema, type SourceLocation } from './annotations';
import { glossarySenseSchema, type GlossaryEntry } from './glossary';
import type { Learning } from './domain';

export const MAX_QUESTION_CONCEPTS = 10;
export const conceptReferenceSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
});
export const conceptReferencesSchema = z
  .array(conceptReferenceSchema)
  .max(MAX_QUESTION_CONCEPTS)
  .refine((refs) => new Set(refs.map((ref) => ref.id)).size === refs.length);
export type ConceptReference = z.infer<typeof conceptReferenceSchema>;
export const conceptMentionSchema = conceptReferenceSchema.extend({
  term: z.string().min(1).max(200),
  reviewed: z.boolean(),
});
export type ConceptMention = z.infer<typeof conceptMentionSchema>;
export const conceptMentionsSchema = z
  .array(conceptMentionSchema)
  .max(MAX_QUESTION_CONCEPTS)
  .refine((refs) => new Set(refs.map((ref) => ref.id)).size === refs.length);
export function conceptMention(entry: GlossaryEntry): ConceptMention {
  return { id: entry.id, version: entry.version, term: entry.term, reviewed: entry.reviewed };
}
export const conceptCitationId = (entry: ConceptReference) =>
  `concept.${entry.id}.v${entry.version}`;
const identity = z.string().min(1).max(500);
export const tutorCitationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('source'),
    id: identity,
    sourceId: z.string().uuid(),
    sourceVersion: z.number().int().positive(),
    segmentId: identity,
    location: locationSchema,
    excerptTruncated: z.boolean().optional(),
    recovered: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('concept'),
    id: identity,
    conceptId: z.string().uuid(),
    version: z.number().int().positive(),
    term: z.string().min(1).max(200),
    reviewed: z.boolean(),
    meaningIds: z.array(glossarySenseSchema.shape.id).max(20).optional(),
  }),
]);
export type TutorCitation = z.infer<typeof tutorCitationSchema>;
export type TutorConcept = {
  entry: GlossaryEntry;
  scope: 'selection' | 'source';
  omittedMeanings: number;
};
export function citedIds(content: string) {
  const prose = content
    .replace(/(`+)[\s\S]*?\1/g, '')
    .replace(/^ *~{3,}[^\n]*\n[\s\S]*?^ *~{3,} *$/gm, '');
  return [
    ...new Set([...prose.matchAll(/(?<![\\!])\[([\w:.-]+)\](?!\()/g)].map((match) => match[1])),
  ];
}
export function citedReferences(content: string, allowed: TutorCitation[]) {
  const ids = new Set(citedIds(content));
  return allowed.filter((ref) => ids.has(ref.id)).slice(0, 40);
}
export function sourceCitation(
  id: string,
  sourceId: string,
  sourceVersion: number,
  segment: { id: string; text: string; page?: number; start?: number },
  recovered = false,
): TutorCitation {
  return {
    kind: 'source',
    id,
    sourceId,
    sourceVersion,
    segmentId: segment.id,
    location: {
      quote: segment.text.slice(0, 600),
      ...(segment.page ? { page: segment.page } : {}),
      ...(segment.start != null ? { seconds: segment.start } : {}),
    },
    ...(segment.text.length > 600 ? { excerptTruncated: true } : {}),
    ...(recovered ? { recovered: true } : {}),
  };
}
export function recoverCitations(
  message: { content: string; sourceIds?: string[]; requestId?: string },
  conversation: {
    id: string;
    messages: Array<{
      role: string;
      requestId?: string;
      context?: { sourceId: string; sourceVersion: number; location: SourceLocation };
    }>;
  },
  materials: Learning[],
) {
  const question = message.requestId
    ? conversation.messages.find((m) => m.role === 'user' && m.requestId === message.requestId)
        ?.context
    : undefined;
  const historicalSource = conversation.id.match(/^history-[a-f0-9-]{36}-([a-f0-9-]{36})$/)?.[1];
  const scope = new Set(message.sourceIds || (historicalSource ? [historicalSource] : []));
  if (question) scope.add(question.sourceId);
  const refs: TutorCitation[] = [];
  for (const id of citedIds(message.content)) {
    const matches: TutorCitation[] = [];
    for (const material of materials.filter((m) => scope.has(m.sourceId)))
      for (const segment of material.segments)
        if (id === `${material.sourceId}:${segment.id}` || (!id.includes(':') && id === segment.id))
          matches.push(
            sourceCitation(id, material.sourceId, material.sourceVersion, segment, true),
          );
    if (question && (id === `${question.sourceId}:selected-passage` || id === 'selected-passage'))
      matches.push({
        kind: 'source',
        id,
        sourceId: question.sourceId,
        sourceVersion: question.sourceVersion,
        segmentId: 'selected-passage',
        location: question.location,
        recovered: true,
      });
    if (matches.length === 1) refs.push(matches[0]);
  }
  return refs;
}
