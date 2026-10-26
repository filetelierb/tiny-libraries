import { z } from 'zod';
import { fold, type Concept, type ConceptSource } from './domain';
import { locationSchema } from './annotations';

export const conceptName = (value: string) => fold(value).replace(/\s+/g, ' ');
export const conceptSourceSchema = z.object({
  sourceId: z.string().uuid(),
  sourceVersion: z.number().int().positive(),
  segmentIds: z.array(z.string().min(1).max(240)).max(100),
  location: locationSchema.optional(),
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
  mergedInto?: string;
  match?: 'title' | 'synonym';
};
export function uniqueNames(values: string[], term = '') {
  const seen = new Set<string>([conceptName(term)]);
  return values
    .map((value) => value.trim())
    .filter((value) => {
      const key = conceptName(value);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
export function sameSource(a: ConceptSource, b: ConceptSource) {
  return (
    a.sourceId === b.sourceId &&
    a.sourceVersion === b.sourceVersion &&
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
export function mergeGeneratedConcept(
  existing: GlossaryEntry | undefined,
  term: string,
  definition: string,
  source: ConceptSource,
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
    });
  const entry = normalizeConcept(existing),
    matching = entry.senses.find((sense) => sameDefinition(sense.definition, definition));
  if (matching)
    return normalizeConcept({
      ...entry,
      senses: entry.senses.map((sense) =>
        sense.id === matching.id
          ? { ...sense, sources: uniqueSources([...sense.sources, source]) }
          : sense,
      ),
    });
  if (
    entry.proposals.some(
      (proposal) =>
        sameDefinition(proposal.definition, definition) && sameSource(proposal.source, source),
    )
  )
    return entry;
  return normalizeConcept({
    ...entry,
    proposals: [...entry.proposals, { id: crypto.randomUUID(), definition, source }],
  });
}
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
    aliases: uniqueNames([...target.aliases, source.term, ...source.aliases], target.term),
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
