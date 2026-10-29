import { z } from 'zod';
import { fold, type Concept, type ConceptSource } from './domain';
import { locationSchema } from './annotations';

export const conceptName = (value: string) => fold(value).replace(/\s+/g, ' ');
const minorWords = new Set([
  'a',
  'an',
  'and',
  'for',
  'in',
  'of',
  'the',
  'to',
  'de',
  'del',
  'el',
  'la',
  'y',
]);
const words = (value: string) =>
  fold(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const initials = (list: string[]) => list.map((word) => word[0]).join('');
/** A trailing abbreviation spelled by the initials before it, as in "discrete Fourier transform (DFT)". */
export function conceptAbbreviation(value: string) {
  const match = value.trim().match(/^(.+?)\s*\(([\p{L}\p{N}]{2,12})\)$/u);
  if (!match) return null;
  const list = words(match[1]),
    short = fold(match[2]);
  return initials(list) === short || initials(list.filter((w) => !minorWords.has(w))) === short
    ? { term: match[1].trim(), abbreviation: match[2] }
    : null;
}
const singular = (word: string) =>
  word.length <= 3 || !word.endsWith('s') || /(ss|us|is|ys)$/.test(word)
    ? word
    : word.endsWith('ies')
      ? `${word.slice(0, -3)}y`
      : word.slice(0, -1);
/**
 * The identity two concept names share when they differ only in case, accents, punctuation,
 * plural endings or a trailing abbreviation: "Linear operations" and "linear operation", or
 * "Discrete Fourier Transform" and "discrete Fourier transform (DFT)".
 */
export function conceptKey(value: string) {
  return (
    words(conceptAbbreviation(value)?.term ?? value)
      .map(singular)
      .join(' ') || conceptName(value)
  );
}
/** Added by hand in the glossary, saved by the tutor on request, or taken from a prepared file. */
export const conceptOrigins = ['manual', 'chat', 'analysis'] as const;
export type ConceptOrigin = (typeof conceptOrigins)[number];
/** Entries from before origins were recorded came from file preparation when they cite a file. */
export const conceptOrigin = (value: Concept): ConceptOrigin =>
  value.origin ?? (normalizeConcept(value).sources.length ? 'analysis' : 'manual');
export const conceptSourceSchema = z.object({
  sourceId: z.string().uuid(),
  sourceVersion: z.number().int().positive(),
  segmentIds: z.array(z.string().min(1).max(240)).max(100),
  location: locationSchema.optional(),
  endSeconds: z.number().nonnegative().optional(),
});
const nameSchema = z.string().trim().min(1).max(200);
export const glossarySenseSchema = z.object({
  id: z.string().min(1).max(100),
  label: z.string().trim().max(160),
  definition: z.string().trim().min(1).max(12000),
  reviewed: z.boolean().default(false),
  synonyms: z.array(z.string().uuid()).max(30).default([]),
  sources: z.array(conceptSourceSchema).max(30).default([]),
  relations: z
    .array(
      z.object({ entryId: z.string().uuid(), description: z.string().trim().min(1).max(2000) }),
    )
    .max(30)
    .default([]),
});
export type GlossarySense = z.infer<typeof glossarySenseSchema>;
export const glossaryInputSchema = z.object({
  id: z.string().uuid(),
  term: nameSchema,
  version: z.number().int().nonnegative(),
  archived: z.boolean(),
  aliases: z.array(nameSchema).max(40),
  senses: z.array(glossarySenseSchema).min(1).max(20),
  mutationId: z.string().uuid(),
});
export type GlossaryInput = z.infer<typeof glossaryInputSchema>;
export type GlossaryEntry = Concept & {
  aliases: string[];
  senses: GlossarySense[];
  archived: boolean;
  updatedAt?: string;
  mergedInto?: string;
};
export type GlossarySummary = {
  id: string;
  term: string;
  version: number;
  archived: boolean;
  reviewed: boolean;
  preview: string;
  aliases: string[];
  sourceIds: string[];
  synonymIds: string[];
  senseCount: number;
  synonymCount: number;
  relationCount: number;
  proposalCount: number;
  origin: ConceptOrigin;
  mergedInto?: string;
  match?: 'title' | 'synonym';
};
export function uniqueNames(values: string[], term = '') {
  const seen = new Set<string>([conceptKey(term)]);
  return values
    .map((value) => value.trim())
    .filter((value) => {
      const key = conceptKey(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
export function sameSource(a: ConceptSource, b: ConceptSource) {
  return (
    a.sourceId === b.sourceId &&
    a.sourceVersion === b.sourceVersion &&
    a.endSeconds === b.endSeconds &&
    [...a.segmentIds].sort().join('|') === [...b.segmentIds].sort().join('|') &&
    JSON.stringify(a.location || {}) === JSON.stringify(b.location || {})
  );
}
export function uniqueSources(values: ConceptSource[]) {
  const result: ConceptSource[] = [];
  for (const value of values)
    if (!result.some((item) => sameSource(item, value))) result.push(value);
  return result;
}
export function normalizeConcept(value: Concept): GlossaryEntry {
  const senses = value.senses?.length
    ? value.senses.map((sense) => ({
        ...sense,
        reviewed: sense.reviewed ?? value.reviewed,
        synonyms: sense.synonyms || [],
        relations: sense.relations || [],
        sources: sense.sources || [],
      }))
    : [
        {
          id: `${value.id}:primary`,
          label: '',
          definition: value.definition,
          reviewed: value.reviewed,
          synonyms: [],
          relations: [],
          sources: value.sources,
        },
      ];
  return {
    ...value,
    aliases: uniqueNames(value.aliases || [], value.term),
    senses,
    archived: !!value.archived,
    definition: senses[0].definition,
    reviewed: senses.every((sense) => sense.reviewed),
    sources: uniqueSources([
      ...senses.flatMap((sense) => sense.sources),
      ...value.proposals.map((proposal) => proposal.source),
    ]),
  };
}
export function summarizeConcept(value: Concept): GlossarySummary {
  const entry = normalizeConcept(value);
  return {
    id: entry.id,
    term: entry.term,
    version: entry.version,
    archived: entry.archived,
    reviewed: entry.reviewed,
    preview: entry.definition.slice(0, 360),
    aliases: entry.aliases,
    sourceIds: [...new Set(entry.sources.map((source) => source.sourceId))],
    synonymIds: [...new Set(entry.senses.flatMap((sense) => sense.synonyms))],
    senseCount: entry.senses.length,
    synonymCount:
      entry.aliases.length + entry.senses.reduce((n, sense) => n + sense.synonyms.length, 0),
    relationCount: entry.senses.reduce((n, sense) => n + sense.relations.length, 0),
    proposalCount: entry.proposals.length,
    origin: conceptOrigin(entry),
    ...(entry.mergedInto ? { mergedInto: entry.mergedInto } : {}),
  };
}
export function matchConcept(
  entry: GlossarySummary,
  query: string,
  all: GlossarySummary[],
): 'title' | 'synonym' | null {
  const needle = conceptName(query);
  if (!needle || conceptName(entry.term).includes(needle)) return 'title';
  const linked = all.filter(
    (item) => entry.synonymIds.includes(item.id) || item.synonymIds.includes(entry.id),
  );
  return [...entry.aliases, ...linked.flatMap((item) => [item.term, ...item.aliases])].some(
    (name) => conceptName(name).includes(needle),
  )
    ? 'synonym'
    : null;
}
export function sameDefinition(a: string, b: string) {
  return (
    a.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase() ===
    b.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
  );
}
/**
 * Adds a term found while preparing a file. A new term becomes a concept right away; a known
 * one gains the file as a source, on the meaning with the same definition or else its first.
 */
export function mergeGeneratedConcept(
  existing: GlossaryEntry | undefined,
  term: string,
  definition: string,
  source: ConceptSource,
  origin: ConceptOrigin = 'analysis',
  aliases: string[] = [],
): GlossaryEntry {
  if (!existing)
    return normalizeConcept({
      id: crypto.randomUUID(),
      term,
      definition,
      version: 1,
      reviewed: false,
      sources: [source],
      proposals: [],
      origin,
      aliases,
    });
  const entry = normalizeConcept(existing),
    target =
      entry.senses.find((sense) => sameDefinition(sense.definition, definition)) || entry.senses[0];
  return normalizeConcept({
    ...entry,
    aliases: [...entry.aliases, ...aliases],
    senses: entry.senses.map((sense) =>
      sense.id === target.id
        ? { ...sense, sources: uniqueSources([...sense.sources, source]) }
        : sense,
    ),
  });
}
/** Concept identities a meaning points at: synonyms and related concepts. */
const linkedIds = (entry: GlossaryEntry) =>
  entry.senses.flatMap((sense) => [...sense.synonyms, ...sense.relations.map((r) => r.entryId)]);
/**
 * Orphans are concepts that cite no existing file (archived and trashed files still count)
 * and are not connected, through synonyms or relations in either direction, to any concept
 * that does. Merged forwarders are not concepts of their own and are skipped.
 */
export function orphanConcepts(entries: GlossaryEntry[], fileIds: Set<string>) {
  const live = entries.filter((entry) => !entry.mergedInto).map(normalizeConcept);
  const forward = new Map(
    entries.filter((e) => e.mergedInto).map((e) => [e.id, e.mergedInto!] as const),
  );
  const resolve = (id: string) => {
    for (let i = 0; i < 20 && forward.has(id); i++) id = forward.get(id)!;
    return id;
  };
  const neighbours = new Map(live.map((entry) => [entry.id, new Set<string>()]));
  for (const entry of live)
    for (const id of linkedIds(entry).map(resolve))
      if (id !== entry.id && neighbours.has(id)) {
        neighbours.get(entry.id)!.add(id);
        neighbours.get(id)!.add(entry.id);
      }
  const anchored = new Set(
    live
      .filter((entry) => entry.sources.some((source) => fileIds.has(source.sourceId)))
      .map((entry) => entry.id),
  );
  const queue = [...anchored];
  while (queue.length)
    for (const id of neighbours.get(queue.pop()!)!)
      if (!anchored.has(id)) {
        anchored.add(id);
        queue.push(id);
      }
  return live.filter((entry) => !anchored.has(entry.id));
}
/** Concepts that cite files, all of them among `removed`: they lose every file with them. */
export function conceptsOnlyIn(
  entries: GlossaryEntry[],
  fileIds: Set<string>,
  removed: Set<string>,
) {
  return entries
    .filter((entry) => !entry.mergedInto)
    .map(normalizeConcept)
    .filter((entry) => {
      const files = entry.sources.map((s) => s.sourceId).filter((id) => fileIds.has(id));
      return files.length > 0 && files.every((id) => removed.has(id));
    });
}
/** Names plus the abbreviations they end with, so "discrete Fourier transform (DFT)" also gives "DFT". */
const withAbbreviations = (names: string[]) =>
  names.flatMap((name) => {
    const short = conceptAbbreviation(name)?.abbreviation;
    return short ? [name, short] : [name];
  });
export function mergeGlossaryEntries(target: GlossaryEntry, source: GlossaryEntry): GlossaryEntry {
  const senses = target.senses.map((sense) => ({
    ...sense,
    sources: [...sense.sources],
    synonyms: [...sense.synonyms],
    relations: [...sense.relations],
  }));
  for (const incoming of source.senses) {
    const same = senses.find((sense) => sameDefinition(sense.definition, incoming.definition));
    if (same) {
      same.sources = uniqueSources([...same.sources, ...incoming.sources]);
      same.reviewed = same.reviewed || incoming.reviewed;
      same.synonyms = [...new Set([...same.synonyms, ...incoming.synonyms])];
      same.relations = [
        ...same.relations,
        ...incoming.relations.filter(
          (link) => !same.relations.some((existing) => existing.entryId === link.entryId),
        ),
      ];
    } else
      senses.push({
        ...incoming,
        id: senses.some((sense) => sense.id === incoming.id) ? crypto.randomUUID() : incoming.id,
      });
  }
  return normalizeConcept({
    ...target,
    aliases: uniqueNames(
      [...target.aliases, ...withAbbreviations([source.term, ...source.aliases])],
      target.term,
    ),
    senses: senses.map((sense) => ({
      ...sense,
      synonyms: sense.synonyms.filter((id) => id !== target.id && id !== source.id),
      relations: sense.relations.filter(
        (link) => link.entryId !== target.id && link.entryId !== source.id,
      ),
    })),
    proposals: [
      ...target.proposals,
      ...source.proposals.filter(
        (proposal) =>
          !target.proposals.some(
            (existing) =>
              sameDefinition(existing.definition, proposal.definition) &&
              sameSource(existing.source, proposal.source),
          ),
      ),
    ],
  });
}
export type ConceptSnapshot = {
  id: string;
  term: string;
  version: number;
  definition: string;
  aliases: string[];
  reviewed: boolean;
};
export const conceptSnapshotSchema = z.object({
  id: z.string().uuid(),
  term: nameSchema,
  version: z.number().int().positive(),
  definition: z.string().max(16000),
  aliases: z.array(nameSchema).max(40),
  reviewed: z.boolean(),
});
export function conceptSnapshot(value: Concept): ConceptSnapshot {
  const entry = normalizeConcept(value);
  return {
    id: entry.id,
    term: entry.term,
    version: entry.version,
    definition: entry.senses
      .map(
        (sense, index) =>
          `${entry.senses.length > 1 ? `${index + 1}. ${sense.label}\n` : ''}${sense.definition}`,
      )
      .join('\n\n')
      .slice(0, 16000),
    aliases: entry.aliases,
    reviewed: entry.reviewed,
  };
}
