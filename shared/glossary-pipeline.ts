import { z } from 'zod';
import type { Segment, Synthesis } from './domain';
import { conceptKey, uniqueNames } from './glossary';
import { WINDOW_CHARS } from './synthesis-windows';

/**
 * A file's glossary is built in rounds: a review merges and corrects the candidate terms and
 * names concepts the chapters cover without a term; the missing ones are defined from those
 * chapters' segments, and the next round reviews again. Finished terms are then reconciled
 * with the concepts the library already holds.
 */
export const GLOSSARY_ROUNDS = 3;
export const GLOSSARY_TERMS = 40;
export type GlossaryTerm = {
  term: string;
  definition: string;
  aliases: string[];
  segmentIds: string[];
};
export type GlossaryState = {
  round: number;
  terms: GlossaryTerm[];
  phase: 'review' | 'fill' | 'match' | 'decide';
  missing?: Array<{ name: string; chapter: number }>;
  matches?: Array<string | null>;
};

export const glossaryReviewSchema = z.object({
  terms: z
    .array(
      z.object({
        term: z.string(),
        definition: z.string(),
        aliases: z.array(z.string()),
        from: z.array(z.number().int()),
      }),
    )
    .max(60),
  missing: z.array(z.object({ name: z.string(), chapter: z.number().int() })).max(12),
});
export type GlossaryReview = z.infer<typeof glossaryReviewSchema>;
export const glossaryFillSchema = z.object({
  terms: z
    .array(
      z.object({
        term: z.string(),
        definition: z.string(),
        aliases: z.array(z.string()),
        segmentIds: z.array(z.string()),
      }),
    )
    .max(12),
});
export type GlossaryFill = z.infer<typeof glossaryFillSchema>;

export const initialGlossary = (synthesis: Synthesis): GlossaryTerm[] =>
  synthesis.glossary.map((term) => ({ ...term, aliases: [] }));

export const reviewInput = (terms: GlossaryTerm[], synthesis: Synthesis) => ({
  candidates: terms.map((term, index) => ({
    index,
    term: term.term,
    aliases: term.aliases,
    definition: term.definition,
    citations: term.segmentIds.length,
  })),
  chapters: synthesis.chapters.map((chapter, index) => ({
    index,
    title: chapter.title,
    summary: chapter.summary,
  })),
});

/** Adds a term, or its names and evidence to the term already holding the same concept key. */
function addTerm(terms: GlossaryTerm[], next: GlossaryTerm) {
  const keys = new Set([next.term, ...next.aliases].map(conceptKey)),
    same = terms.find((term) =>
      [term.term, ...term.aliases].some((name) => keys.has(conceptKey(name))),
    );
  if (!same) {
    terms.push(next);
    return;
  }
  same.aliases = uniqueNames([...same.aliases, next.term, ...next.aliases], same.term).slice(0, 10);
  same.segmentIds = [...new Set([...same.segmentIds, ...next.segmentIds])];
}
const cleanTerm = (term: string, definition: string, aliases: string[], segmentIds: string[]) => {
  const name = term.trim().slice(0, 200),
    text = definition.trim().slice(0, 6000);
  return name && text && segmentIds.length
    ? {
        term: name,
        definition: text,
        aliases: uniqueNames(
          aliases.map((alias) => alias.slice(0, 200)),
          name,
        ).slice(0, 10),
        segmentIds,
      }
    : null;
};

/** A reviewed term keeps exactly the evidence of the candidates it was made from. */
export function applyReview(terms: GlossaryTerm[], review: GlossaryReview) {
  const result: GlossaryTerm[] = [];
  for (const item of review.terms) {
    const from = [...new Set(item.from)].filter((i) => i >= 0 && i < terms.length);
    const next = cleanTerm(
      item.term,
      item.definition,
      [...item.aliases],
      [...new Set(from.flatMap((i) => terms[i].segmentIds))],
    );
    if (next) addTerm(result, next);
  }
  return result.slice(0, GLOSSARY_TERMS);
}

/** The segments of the chapters a review found missing terms in, within one analysis window. */
export function fillSegments(
  segments: Segment[],
  synthesis: Synthesis,
  missing: Array<{ chapter: number }>,
) {
  const position = new Map(segments.map((segment, i) => [segment.id, i])),
    chosen = new Set<number>();
  for (const chapter of [...new Set(missing.map((m) => m.chapter))].sort((a, b) => a - b)) {
    const indices = (synthesis.chapters[chapter]?.segmentIds || [])
      .map((id) => position.get(id))
      .filter((i) => i !== undefined);
    if (!indices.length) continue;
    for (let i = Math.min(...indices); i <= Math.max(...indices); i++) chosen.add(i);
  }
  const result: Segment[] = [];
  let size = 0;
  for (const i of [...chosen].sort((a, b) => a - b)) {
    size += JSON.stringify(segments[i]).length;
    if (size > WINDOW_CHARS) break;
    result.push(segments[i]);
  }
  return result;
}

/** Defined missing terms join the list when they cite segments the fill call was given. */
export function applyFill(terms: GlossaryTerm[], fill: GlossaryFill, available: Segment[]) {
  const ids = new Set(available.map((segment) => segment.id)),
    result = terms.map((term) => ({ ...term }));
  let added = 0;
  for (const item of fill.terms) {
    const next = cleanTerm(
      item.term,
      item.definition,
      item.aliases,
      [...new Set(item.segmentIds)].filter((id) => ids.has(id)),
    );
    if (!next || result.length >= GLOSSARY_TERMS) continue;
    const before = result.length;
    addTerm(result, next);
    if (result.length > before) added++;
  }
  return { terms: result, added };
}

/** Concepts already in the library, compact enough to match a file's terms against. */
export type ConceptIndexItem = { id: string; term: string; aliases: string[] };
export const conceptMatchSchema = z.object({
  matches: z.array(z.object({ term: z.number().int(), conceptId: z.string().nullable() })),
});
export type ConceptMatch = z.infer<typeof conceptMatchSchema>;
/** An existing concept with the evidence other files give for each of its meanings. */
export type ConceptContext = {
  id: string;
  version: number;
  term: string;
  aliases: string[];
  senses: Array<{
    id: string;
    label: string;
    definition: string;
    reviewed: boolean;
    sources: Array<{ file: string; quote: string }>;
  }>;
};
export const conceptDecisionSchema = z.object({
  decisions: z.array(
    z.object({
      term: z.number().int(),
      action: z.enum(['attach', 'refine', 'new_sense', 'separate']),
      senseId: z.string().nullable(),
      definition: z.string().nullable(),
      label: z.string().nullable(),
      name: z.string().nullable(),
    }),
  ),
});
export type ConceptDecision = z.infer<typeof conceptDecisionSchema>;
/** How one finished term enters the glossary, aligned with the learning's glossary. */
export type ConceptPlan = {
  action: 'new' | 'attach' | 'refine' | 'new_sense';
  aliases: string[];
  conceptId?: string;
  conceptVersion?: number;
  senseId?: string;
  definition?: string;
  label?: string;
  term?: string;
};

/** A concept named like the term is its match; otherwise the model's pick, if it exists. */
export function conceptMatches(
  terms: GlossaryTerm[],
  byName: Array<string | null>,
  model: ConceptMatch,
  index: ConceptIndexItem[],
) {
  const known = new Set(index.map((item) => item.id));
  return terms.map((_, i) => {
    if (byName[i]) return byName[i];
    const pick = model.matches.find((match) => match.term === i)?.conceptId;
    return pick && known.has(pick) ? pick : null;
  });
}

/**
 * Turns the model's decisions into safe plans: reviewed meanings are never rewritten, unknown
 * meanings fall back to attaching, and a different concept that shares the name becomes a new
 * meaning of it rather than a second concept with the same name.
 */
export function planConcepts(
  terms: GlossaryTerm[],
  matches: Array<string | null>,
  byName: Array<string | null>,
  contexts: ConceptContext[],
  decided: ConceptDecision,
): ConceptPlan[] {
  return terms.map((term, i) => {
    const context = contexts.find((c) => c.id === matches[i]);
    if (!context) return { action: 'new', aliases: term.aliases };
    const decision = decided.decisions.find((d) => d.term === i),
      base = { aliases: term.aliases, conceptId: context.id, conceptVersion: context.version },
      sense = context.senses.find((s) => s.id === decision?.senseId) || context.senses[0],
      definition = decision?.definition?.trim().slice(0, 6000) || term.definition,
      label = decision?.label?.trim().slice(0, 160) || '';
    if (!decision)
      // A name match without a decision links as before; an unconfirmed synonym stays separate.
      return byName[i]
        ? { ...base, action: 'attach', senseId: sense.id }
        : { action: 'new', aliases: term.aliases };
    if (decision.action === 'refine' && !sense.reviewed && decision.definition?.trim())
      return { ...base, action: 'refine', senseId: sense.id, definition };
    if (decision.action === 'new_sense') return { ...base, action: 'new_sense', definition, label };
    if (decision.action === 'separate') {
      if (!byName[i]) return { action: 'new', aliases: term.aliases };
      const name = decision.name?.trim().slice(0, 200);
      return name &&
        ![context.term, ...context.aliases].some((n) => conceptKey(n) === conceptKey(name))
        ? { action: 'new', aliases: [], term: name }
        : { ...base, action: 'new_sense', definition, label };
    }
    return { ...base, action: 'attach', senseId: sense.id };
  });
}
