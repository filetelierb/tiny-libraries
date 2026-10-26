import type { Learning } from '../shared/domain';
import { normalizeConcept, uniqueSources, type GlossaryEntry } from '../shared/glossary';
import { conceptMention, type ConceptReference, type TutorConcept } from '../shared/tutor-context';
import { glossarySnapshot, GlossaryError, type GlossaryStorage } from './glossary';

export async function loadTutorConcepts(
  storage: GlossaryStorage,
  selected: ConceptReference[],
  materials: Learning[],
) {
  const byId = new Map<string, TutorConcept>(),
    versions = new Map(materials.map((m) => [m.sourceId, m.sourceVersion]));
  if (materials.length)
    for (const raw of await glossarySnapshot(storage)) {
      const entry = normalizeConcept(raw);
      if (entry.archived || entry.mergedInto) continue;
      const senses = entry.senses.flatMap((sense) => {
        const sources = sense.sources.filter(
          (source) => versions.get(source.sourceId) === source.sourceVersion,
        );
        return sources.length ? [{ ...sense, sources }] : [];
      });
      if (!senses.length) continue;
      byId.set(entry.id, {
        entry: {
          ...entry,
          senses,
          definition: senses[0].definition,
          sources: uniqueSources(senses.flatMap((s) => s.sources)),
          proposals: entry.proposals.filter(
            (p) => versions.get(p.source.sourceId) === p.source.sourceVersion,
          ),
        },
        scope: 'source',
        omittedMeanings: entry.senses.length - senses.length,
      });
    }
  const mentions = [];
  for (const reference of selected) {
    const saved = await storage.get<GlossaryEntry>(
      `glossary-history:${reference.id}:${String(reference.version).padStart(10, '0')}`,
    );
    if (!saved)
      throw new GlossaryError(
        'This glossary revision is unavailable. Reattach the concept before sending.',
        409,
      );
    const entry = normalizeConcept(saved);
    mentions.push(conceptMention(entry));
    byId.set(entry.id, { entry, scope: 'selection', omittedMeanings: 0 });
  }
  return { concepts: [...byId.values()], mentions };
}
