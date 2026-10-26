import { z } from 'zod';
import type { Directory, Learning, Settings, Source } from '../shared/domain';
import { sourceState } from '../shared/directories';
import { stableAnnotationId } from '../shared/annotations';
import {
  glossaryInputSchema,
  normalizeConcept,
  uniqueNames,
  uniqueSources,
  sameDefinition,
  type GlossaryEntry,
  type GlossarySense,
} from '../shared/glossary';
import {
  acceptSuggestionSchema,
  exactSuggestionMatch,
  suggestionSources,
  validateConceptPlan,
  type AcceptSuggestion,
  type ConceptAnalysis,
  type ConceptCandidate,
  type ConceptPlan,
  type ResourceSuggestions,
} from '../shared/concept-suggestions';
import {
  ensureGlossary,
  glossarySnapshot,
  resolveEntry,
  writeEntry,
  GlossaryError,
  type GlossaryStorage,
  type GlossaryStore,
} from './glossary';

const analysisKey = (id: string) => `concept-analysis:${id}`;
const candidateKey = (analysisId: string, id: string) => `concept-suggestion:${analysisId}:${id}`;
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const uuid = z.string().uuid();
async function hash(value: unknown) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
async function requireSource(
  tx: GlossaryStore,
  sourceId: string,
  version: number,
  createdAt?: string,
) {
  const source = await tx.get<Source>(`file:${sourceId}`);
  const directories = [...(await tx.list<Directory>({ prefix: 'directory:' })).values()];
  if (!source || source.version !== version || sourceState(source, directories) === 'trash')
    throw new GlossaryError('The source changed or is unavailable. Choose it again.', 409);
  const learning = await tx.get<Learning>(`learning:${sourceId}`);
  if (
    !learning ||
    learning.sourceVersion !== version ||
    (createdAt && learning.createdAt !== createdAt)
  )
    throw new GlossaryError('Prepare this source before analyzing its concepts', 409);
  return learning;
}
export async function seedGuideSuggestions(storage: GlossaryStorage, learning: Learning) {
  const index = `concept-analysis-source:${learning.sourceId}:${learning.sourceVersion}:${learning.createdAt}`;
  const cached = await storage.get<string>(index);
  if (cached) return cached;
  const terms = learning.synthesis?.glossary || [];
  if (!terms.length) return null;
  const id = await stableAnnotationId(
    `concept-guide:${learning.sourceId}:${learning.sourceVersion}:${learning.createdAt}`,
  );
  const known = await glossarySnapshot(storage);
  const validTerms = terms.filter(
    (term) =>
      term.term.trim().length > 0 &&
      term.term.length <= 200 &&
      term.definition.trim().length > 0 &&
      term.definition.length <= 6000 &&
      term.segmentIds.length > 0 &&
      term.segmentIds.every((id) =>
        learning.segments.some((s) => s.id === id && s.text.trim().length > 0),
      ),
  );
  const drafts = await Promise.all(
    validTerms.map(async (term, i) => {
      const candidate = {
        id: `guide-${i}`,
        term: term.term,
        label: '',
        aliases: [],
        definition: term.definition,
        evidence: term.segmentIds
          .map((segmentId) => ({
            segmentId,
            quote: learning.segments.find((s) => s.id === segmentId)!.text.slice(0, 2000),
          }))
          .slice(0, 8),
        matches: exactSuggestionMatch({ term: term.term, aliases: [] }, known).map((e) => ({
          entryId: e.id,
          reason: 'Matching title or registered alias',
        })),
        relations: [],
      };
      const candidateId = await stableAnnotationId(`concept-suggestion:${id}:${i}`);
      return {
        ...candidate,
        id: candidateId,
        entryId: await stableAnnotationId(`concept-entry:${id}:${i}`),
        revision: 1,
        sources: suggestionSources(candidate, learning),
        decision: null,
      } satisfies ConceptCandidate;
    }),
  );
  await storage.transaction(async (tx) => {
    if (await tx.get(index)) return;
    await requireSource(tx, learning.sourceId, learning.sourceVersion, learning.createdAt);
    const analysis: ConceptAnalysis = {
      id,
      sourceId: learning.sourceId,
      sourceVersion: learning.sourceVersion,
      learningCreatedAt: learning.createdAt,
      method: 'guide',
      locale: learning.locale,
      model: learning.model,
      createdAt: new Date().toISOString(),
      status: 'ready',
      owner: '',
      until: 0,
      complete: false,
      warnings:
        terms.length === validTerms.length
          ? []
          : [
              'Some preparation proposals could not be shown because their text or evidence is invalid. Run a new analysis to review this resource.',
            ],
      candidateIds: drafts.map((c) => c.id),
    };
    for (const draft of drafts) await tx.put(candidateKey(id, draft.id), draft);
    await tx.put(analysisKey(id), analysis);
    await tx.put(index, id);
  });
  return (await storage.get<string>(index))!;
}
export async function suggestionsSnapshot(
  storage: GlossaryStorage,
  id: string,
  executionId: string,
): Promise<ResourceSuggestions> {
  let analysis = await storage.get<ConceptAnalysis>(analysisKey(id));
  if (!analysis) throw new GlossaryError('Concept analysis not found', 404);
  if (
    analysis.status === 'running' &&
    (analysis.owner !== executionId || analysis.until < Date.now())
  )
    analysis = await storage.transaction(async (tx) => {
      const current = (await tx.get<ConceptAnalysis>(analysisKey(id)))!;
      if (
        current.status === 'running' &&
        (current.owner !== executionId || current.until < Date.now())
      ) {
        const next = {
          ...current,
          status: 'interrupted' as const,
          error: 'Analysis was interrupted. Retry to continue.',
        };
        await tx.put(analysisKey(id), next);
        return next;
      }
      return current;
    });
  const concepts = [
    ...(await storage.list<ConceptCandidate>({ prefix: `concept-suggestion:${id}:` })).values(),
  ];
  return { analysis, concepts, prepared: true };
}
function combinedSense(base: GlossarySense, incoming: GlossarySense) {
  return {
    ...base,
    sources: uniqueSources([...base.sources, ...incoming.sources]),
    reviewed: base.reviewed || incoming.reviewed,
    synonyms: [...new Set([...base.synonyms, ...incoming.synonyms])],
    relations: [
      ...base.relations,
      ...incoming.relations.filter((r) => !base.relations.some((old) => old.entryId === r.entryId)),
    ],
  };
}
function suggestedEntry(
  candidate: ConceptCandidate,
  term = candidate.term,
  definition = candidate.definition,
): GlossaryEntry {
  return normalizeConcept({
    id: candidate.entryId,
    term,
    version: 1,
    reviewed: false,
    definition,
    proposals: [],
    sources: candidate.sources,
    aliases: candidate.aliases,
    senses: [
      {
        id: `${candidate.id}:meaning`,
        label: candidate.label,
        definition,
        reviewed: false,
        sources: candidate.sources,
        synonyms: [],
        relations: [],
      },
    ],
  });
}
export async function acceptSuggestion(
  storage: GlossaryStorage,
  analysisId: string,
  candidateId: string,
  input: AcceptSuggestion,
) {
  const signature = await hash({ analysisId, candidateId, input });
  return storage.transaction(async (tx) => {
    const receiptKey = `concept-decision:${input.mutationId}`;
    const receipt = await tx.get<{ hash: string; entryId: string; version: number }>(receiptKey);
    const candidate = await tx.get<ConceptCandidate>(candidateKey(analysisId, candidateId));
    if (!candidate) throw new GlossaryError('Suggested concept not found', 404);
    if (receipt) {
      if (receipt.hash !== signature)
        throw new GlossaryError('Operation ID belongs to another decision', 409);
      const entry = await tx.get<GlossaryEntry>(
        `glossary-history:${receipt.entryId}:${String(receipt.version).padStart(10, '0')}`,
      );
      return { candidate, entry };
    }
    const analysis = await tx.get<ConceptAnalysis>(analysisKey(analysisId));
    if (!analysis || analysis.status !== 'ready')
      throw new GlossaryError('Concept analysis is not ready', 409);
    await requireSource(tx, analysis.sourceId, analysis.sourceVersion, analysis.learningCreatedAt);
    if (candidate.revision !== input.revision || candidate.decision)
      throw new GlossaryError(
        'This suggestion changed in another window. Reload it before deciding.',
        409,
      );
    const previous = await tx.get<GlossaryEntry>(`concept-entry:${input.entryId}`);
    if ((previous?.version || 0) !== input.version)
      throw new GlossaryError('The destination changed. Reopen it before saving.', 409);
    if (previous?.archived || previous?.mergedInto)
      throw new GlossaryError('Choose an active destination concept', 409);
    if (input.mode === 'create' ? !!previous || input.entryId !== candidate.entryId : !previous)
      throw new GlossaryError('Choose a valid destination and review mode', 409);
    if (new Set(input.links.map((l) => l.index)).size !== input.links.length)
      throw new GlossaryError('Remove duplicate suggested links');
    const synonyms: string[] = [],
      relations: Array<{ entryId: string; description: string }> = [];
    for (const link of input.links) {
      const relation = candidate.relations[link.index];
      if (!relation) throw new GlossaryError('Suggested relationship not found', 404);
      let target = await resolveEntry(tx, link.entryId);
      if (link.create) {
        const related = relation.candidateId
          ? await tx.get<ConceptCandidate>(candidateKey(analysisId, relation.candidateId))
          : null;
        if (
          !related ||
          related.entryId !== link.entryId ||
          related.decision?.status === 'dismissed' ||
          (related.decision?.status === 'accepted' && related.decision.entryId !== related.entryId)
        )
          throw new GlossaryError('A related concept is unavailable for creation', 409);
        if (!target) {
          target = { ...suggestedEntry(related), updatedAt: new Date().toISOString() };
          glossaryInputSchema.parse({ ...target, mutationId: input.mutationId });
          await writeEntry(tx, target);
          await tx.put(candidateKey(analysisId, related.id), {
            ...related,
            revision: related.revision + 1,
            decision: {
              status: 'accepted',
              entryId: target.id,
              senseId: target.senses[0].id,
              mode: 'related',
            },
          });
        }
      }
      if (!target || target.archived)
        throw new GlossaryError('Choose an active relationship target', 409);
      if (target.id === input.entryId) continue;
      if (relation.kind === 'synonym') synonyms.push(target.id);
      else relations.push({ entryId: target.id, description: relation.description });
    }
    const sense: GlossarySense = {
      id: input.senseId,
      label: input.label,
      definition: input.definition,
      reviewed: true,
      sources: candidate.sources,
      synonyms: [...new Set(synonyms)],
      relations,
    };
    let senses = previous ? [...previous.senses] : [];
    if (input.mode === 'replace') {
      const i = senses.findIndex((s) => s.id === input.senseId);
      if (i < 0) throw new GlossaryError('Choose the meaning to replace');
      senses[i] = {
        ...combinedSense(senses[i], sense),
        definition: input.definition,
        label: input.label,
        sources: candidate.sources,
      };
    } else {
      const i = senses.findIndex((s) => sameDefinition(s.definition, input.definition));
      if (i >= 0) senses[i] = combinedSense(senses[i], sense);
      else {
        if (senses.some((s) => s.id === sense.id))
          throw new GlossaryError('Meaning identity already exists', 409);
        senses.push(sense);
      }
    }
    const value = normalizeConcept({
      ...(previous || suggestedEntry(candidate)),
      id: input.entryId,
      term: previous?.term || input.term,
      senses,
      aliases: uniqueNames(
        [...(previous?.aliases || []), ...input.aliases],
        previous?.term || input.term,
      ),
      version: input.version + 1,
      updatedAt: new Date().toISOString(),
    });
    glossaryInputSchema.parse({ ...value, mutationId: input.mutationId });
    await writeEntry(tx, value, previous);
    const saved = {
      ...candidate,
      revision: candidate.revision + 1,
      decision: {
        status: 'accepted' as const,
        entryId: value.id,
        senseId:
          input.mode === 'replace'
            ? input.senseId
            : senses.find((s) => sameDefinition(s.definition, input.definition))!.id,
        mode: input.mode,
      },
    };
    await tx.put(candidateKey(analysisId, candidateId), saved);
    await tx.put(receiptKey, { hash: signature, entryId: value.id, version: value.version });
    return { candidate: saved, entry: value };
  });
}
async function completeLinks(storage: GlossaryStorage, analysisId: string, candidateId: string) {
  return storage.transaction(async (tx) => {
    const analysis = (await tx.get<ConceptAnalysis>(analysisKey(analysisId)))!;
    await requireSource(tx, analysis.sourceId, analysis.sourceVersion, analysis.learningCreatedAt);
    const candidate = (await tx.get<ConceptCandidate>(candidateKey(analysisId, candidateId)))!;
    if (candidate.decision?.status !== 'accepted') return { added: 0, unresolved: [] as string[] };
    const entry = await resolveEntry(tx, candidate.decision.entryId!);
    const sense = entry?.senses.find((s) => s.id === candidate.decision!.senseId);
    if (!entry || entry.archived || !sense) return { added: 0, unresolved: [candidate.term] };
    const synonyms = [...sense.synonyms],
      relations = [...sense.relations],
      unresolved: string[] = [];
    for (const relation of candidate.relations) {
      const related = relation.candidateId
        ? await tx.get<ConceptCandidate>(candidateKey(analysisId, relation.candidateId))
        : null;
      const id =
        related?.decision?.status === 'accepted' ? related.decision.entryId : relation.entryId;
      const target = id ? await resolveEntry(tx, id) : null;
      if (!target || target.archived) {
        unresolved.push(related?.term || relation.description);
        continue;
      }
      if (target.id === entry.id) continue;
      if (relation.kind === 'synonym') {
        if (!synonyms.includes(target.id)) synonyms.push(target.id);
      } else if (!relations.some((r) => r.entryId === target.id))
        relations.push({ entryId: target.id, description: relation.description });
    }
    const added =
      synonyms.length - sense.synonyms.length + relations.length - sense.relations.length;
    if (added) {
      const next = normalizeConcept({
        ...entry,
        version: entry.version + 1,
        updatedAt: new Date().toISOString(),
        senses: entry.senses.map((s) => (s.id === sense.id ? { ...s, synonyms, relations } : s)),
      });
      glossaryInputSchema.parse({ ...next, mutationId: crypto.randomUUID() });
      await writeEntry(tx, next, entry);
    }
    return { added, unresolved };
  });
}
export type BulkConceptResult = {
  created: number;
  updated: number;
  linksAdded: number;
  skipped: Array<{ term: string; reason: string }>;
  unresolved: Array<{ term: string; related: string }>;
};
async function acceptAll(
  storage: GlossaryStorage,
  analysisId: string,
  mutationId: string,
  executionId: string,
) {
  const runKey = `concept-bulk-run:${mutationId}`,
    attempt = crypto.randomUUID();
  const cached = await storage.transaction(async (tx) => {
    const receipt = await tx.get<{ analysisId: string; result: BulkConceptResult }>(
      `concept-bulk:${mutationId}`,
    );
    if (receipt) {
      if (receipt.analysisId !== analysisId)
        throw new GlossaryError('Operation ID belongs to another analysis', 409);
      return receipt.result;
    }
    const running = await tx.get<{ analysisId: string; owner: string; until: number }>(runKey);
    if (running && running.analysisId !== analysisId)
      throw new GlossaryError('Operation ID belongs to another analysis', 409);
    if (running?.owner === executionId && running.until > Date.now())
      throw new GlossaryError(
        'This review operation is already running. Reopen the suggestions shortly.',
        409,
      );
    await tx.put(runKey, {
      analysisId,
      owner: executionId,
      until: Date.now() + 5 * 60 * 1000,
      attempt,
    });
    return null;
  });
  if (cached) return cached;
  try {
    return await runAcceptAll(storage, analysisId, mutationId, executionId);
  } finally {
    await storage.transaction(async (tx) => {
      if ((await tx.get<{ attempt: string }>(runKey))?.attempt === attempt) await tx.delete(runKey);
    });
  }
}
async function runAcceptAll(
  storage: GlossaryStorage,
  analysisId: string,
  mutationId: string,
  executionId: string,
) {
  const key = `concept-bulk:${mutationId}`,
    receipt = await storage.get<{ analysisId: string; result: BulkConceptResult }>(key);
  if (receipt) {
    if (receipt.analysisId !== analysisId)
      throw new GlossaryError('Operation ID belongs to another analysis', 409);
    return receipt.result;
  }
  const snapshot = await suggestionsSnapshot(storage, analysisId, executionId);
  if (snapshot.analysis?.method === 'guide')
    throw new GlossaryError('Analyze glossary matches before saving all suggestions', 409);
  if (snapshot.analysis?.status !== 'ready')
    throw new GlossaryError('Concept analysis is not ready', 409);
  const result: BulkConceptResult = {
    created: 0,
    updated: 0,
    linksAdded: 0,
    skipped: [],
    unresolved: [],
  };
  for (const original of snapshot.concepts) {
    const candidate = (await storage.get<ConceptCandidate>(candidateKey(analysisId, original.id)))!;
    if (candidate.decision) continue;
    const all = await glossarySnapshot(storage),
      exact = exactSuggestionMatch({ term: candidate.term, aliases: [] }, all);
    const matches = exact.length
      ? exact
      : all.filter(
          (e) => !e.archived && !e.mergedInto && candidate.matches.some((m) => m.entryId === e.id),
        );
    if (!exact.length && matches.length) {
      result.skipped.push({
        term: candidate.term,
        reason: 'Semantic or cross-language match. Review the destination individually.',
      });
      continue;
    }
    if (matches.length > 1) {
      result.skipped.push({
        term: candidate.term,
        reason: 'Multiple possible concepts. Choose the destination individually.',
      });
      continue;
    }
    const target = matches[0],
      mode = target ? ('add' as const) : ('create' as const);
    try {
      await acceptSuggestion(storage, analysisId, candidate.id, {
        revision: candidate.revision,
        mutationId: await stableAnnotationId(`concept-bulk:${mutationId}:${candidate.id}`),
        mode,
        entryId: target?.id || candidate.entryId,
        version: target?.version || 0,
        senseId: `${candidate.id}:meaning`,
        term: target?.term || candidate.term,
        label: candidate.label,
        definition: candidate.definition,
        aliases: uniqueNames(
          [candidate.term, ...candidate.aliases],
          target?.term || candidate.term,
        ),
        links: [],
      });
      if (target) result.updated++;
      else result.created++;
    } catch (e) {
      result.skipped.push({
        term: candidate.term,
        reason: e instanceof Error ? e.message : 'Unable to save this proposal',
      });
    }
  }
  for (const candidate of snapshot.concepts) {
    try {
      const links = await completeLinks(storage, analysisId, candidate.id);
      result.linksAdded += links.added;
      for (const related of links.unresolved)
        result.unresolved.push({ term: candidate.term, related });
    } catch (e) {
      result.skipped.push({
        term: candidate.term,
        reason: e instanceof Error ? e.message : 'Unable to save relationships',
      });
    }
  }
  await storage.put(key, { analysisId, result });
  return result;
}

type Dependencies = {
  request: Request;
  storage: GlossaryStorage;
  executionId: string;
  body: () => Promise<unknown>;
  settings: () => Promise<Settings>;
  start: (task: Promise<unknown>) => void;
  analyze: (
    learning: Learning,
    known: GlossaryEntry[],
    locale: 'en' | 'es',
    model: string,
  ) => Promise<ConceptPlan>;
};
export async function conceptSuggestionsRoute(deps: Dependencies): Promise<Response | null> {
  const { request, storage, executionId, body } = deps,
    url = new URL(request.url),
    path = url.pathname;
  if (!path.startsWith('/api/concept-suggestions')) return null;
  await ensureGlossary(storage);
  if (path === '/api/concept-suggestions/history' && request.method === 'GET') {
    const sourceId = uuid.parse(url.searchParams.get('sourceId')),
      version = z.coerce.number().int().positive().parse(url.searchParams.get('version'));
    const all = [...(await storage.list<ConceptAnalysis>({ prefix: 'concept-analysis:' })).values()]
      .filter((a) => a.sourceId === sourceId && a.sourceVersion === version)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return json({
      items: all.map((a) => ({
        id: a.id,
        createdAt: a.createdAt,
        locale: a.locale,
        method: a.method || 'semantic',
        status:
          a.status === 'running' && (a.owner !== executionId || a.until < Date.now())
            ? 'interrupted'
            : a.status,
      })),
    });
  }
  if (path === '/api/concept-suggestions' && request.method === 'GET') {
    const sourceId = uuid.parse(url.searchParams.get('sourceId')),
      version = z.coerce.number().int().positive().parse(url.searchParams.get('version'));
    const file = await storage.get<Source>(`file:${sourceId}`);
    if (!file || file.version !== version)
      throw new GlossaryError('Source changed or is unavailable', 409);
    const learning = await storage.get<Learning>(`learning:${sourceId}`);
    if (!learning || learning.sourceVersion !== version)
      return json({ analysis: null, concepts: [], prepared: false } satisfies ResourceSuggestions);
    const id = await seedGuideSuggestions(storage, learning);
    return json(
      id
        ? await suggestionsSnapshot(storage, id, executionId)
        : { analysis: null, concepts: [], prepared: true },
    );
  }
  if (path === '/api/concept-suggestions/analyze' && request.method === 'POST') {
    const input = z
      .object({
        sourceId: uuid,
        sourceVersion: z.number().int().positive(),
        requestId: uuid,
        force: z.boolean().default(false),
      })
      .parse(await body());
    const settings = await deps.settings();
    if (!settings.configured) throw new GlossaryError('Add a Meta API key in Settings', 409);
    const learning = await requireSource(storage, input.sourceId, input.sourceVersion);
    const index = `concept-analysis-source:${input.sourceId}:${input.sourceVersion}:${learning.createdAt}`;
    const reservation = await storage.transaction(async (tx) => {
      const prior = await tx.get<ConceptAnalysis>(analysisKey(input.requestId));
      if (
        prior &&
        (prior.sourceId !== input.sourceId ||
          prior.sourceVersion !== input.sourceVersion ||
          prior.learningCreatedAt !== learning.createdAt)
      )
        throw new GlossaryError('Analysis request ID belongs to another source', 409);
      const currentId = await tx.get<string>(index),
        cached = currentId ? await tx.get<ConceptAnalysis>(analysisKey(currentId)) : null;
      const running =
        cached?.status === 'running' && cached.owner === executionId && cached.until > Date.now();
      if (running || (cached?.status === 'ready' && cached.method !== 'guide' && !input.force))
        return { start: false, analysis: cached! };
      if (prior?.status === 'ready') return { start: false, analysis: prior };
      const analysis: ConceptAnalysis = {
        id: input.requestId,
        sourceId: input.sourceId,
        sourceVersion: input.sourceVersion,
        learningCreatedAt: learning.createdAt,
        method: 'semantic',
        locale: settings.locale,
        model: settings.model,
        createdAt: prior?.createdAt || new Date().toISOString(),
        status: 'running',
        owner: executionId,
        until: Date.now() + 5 * 60 * 1000,
        complete: false,
        warnings: [],
        candidateIds: [],
      };
      await tx.put(analysisKey(analysis.id), analysis);
      await tx.put(index, analysis.id);
      return { start: true, analysis };
    });
    if (reservation.start)
      deps.start(
        (async () => {
          const analysis = reservation.analysis;
          try {
            const known = await glossarySnapshot(storage);
            const plan = validateConceptPlan(
              await deps.analyze(learning, known, analysis.locale, analysis.model),
              learning,
              known.filter((e) => !e.archived && !e.mergedInto),
            );
            const idMap = new Map(
              await Promise.all(
                plan.concepts.map(
                  async (c) =>
                    [
                      c.id,
                      await stableAnnotationId(`concept-suggestion:${analysis.id}:${c.id}`),
                    ] as const,
                ),
              ),
            );
            const candidates: ConceptCandidate[] = await Promise.all(
              plan.concepts.map(async (c) => ({
                ...c,
                id: idMap.get(c.id)!,
                entryId: await stableAnnotationId(`concept-entry:${analysis.id}:${c.id}`),
                revision: 1,
                sources: suggestionSources(c, learning),
                decision: null,
                relations: c.relations.map((r) => ({
                  ...r,
                  candidateId: r.candidateId ? idMap.get(r.candidateId)! : null,
                })),
                matches: [
                  ...c.matches,
                  ...exactSuggestionMatch(c, known)
                    .filter((e) => !c.matches.some((m) => m.entryId === e.id))
                    .map((e) => ({ entryId: e.id, reason: 'Matching title or registered alias' })),
                ],
              })),
            );
            await storage.transaction(async (tx) => {
              await requireSource(
                tx,
                analysis.sourceId,
                analysis.sourceVersion,
                analysis.learningCreatedAt,
              );
              const current = await tx.get<ConceptAnalysis>(analysisKey(analysis.id));
              if (current?.owner !== executionId || current.status !== 'running') return;
              for (const candidate of candidates)
                await tx.put(candidateKey(analysis.id, candidate.id), candidate);
              await tx.put(analysisKey(analysis.id), {
                ...analysis,
                status: 'ready',
                candidateIds: candidates.map((c) => c.id),
                complete: plan.complete,
                warnings: plan.warnings,
                until: 0,
              });
            });
          } catch (e) {
            await storage.transaction(async (tx) => {
              const current = await tx.get<ConceptAnalysis>(analysisKey(analysis.id));
              if (current?.owner === executionId && current.status === 'running')
                await tx.put(analysisKey(analysis.id), {
                  ...current,
                  status: 'failed',
                  until: 0,
                  error:
                    e instanceof Error ? e.message.slice(0, 600) : 'Unable to analyze concepts',
                });
            });
          }
        })(),
      );
    return json(
      await suggestionsSnapshot(storage, reservation.analysis.id, executionId),
      reservation.start ? 202 : 200,
    );
  }
  const match = path.match(
    /^\/api\/concept-suggestions\/([a-f0-9-]+)(?:\/(accept-all|[a-f0-9-]+))?$/,
  );
  if (!match) return json({ error: 'Not found' }, 404);
  const id = uuid.parse(match[1]);
  if (!match[2] && request.method === 'GET')
    return json(await suggestionsSnapshot(storage, id, executionId));
  if (match[2] === 'accept-all' && request.method === 'POST') {
    const input = z.object({ mutationId: uuid }).parse(await body());
    return json(await acceptAll(storage, id, input.mutationId, executionId));
  }
  if (match[2] && request.method === 'POST') {
    const candidateId = uuid.parse(match[2]),
      raw = await body();
    const choice = z.object({ action: z.enum(['accept', 'dismiss', 'restore']) }).parse(raw);
    if (choice.action === 'accept')
      return json(
        await acceptSuggestion(storage, id, candidateId, acceptSuggestionSchema.parse(raw)),
      );
    const input = z.object({ revision: z.number().int().positive(), mutationId: uuid }).parse(raw),
      signature = await hash({ id, candidateId, ...choice, ...input });
    const candidate = await storage.transaction(async (tx) => {
      const key = candidateKey(id, candidateId),
        current = await tx.get<ConceptCandidate>(key);
      if (!current) throw new GlossaryError('Suggested concept not found', 404);
      const receiptKey = `concept-decision:${input.mutationId}`,
        prior = await tx.get<{ hash: string }>(receiptKey);
      if (prior) {
        if (prior.hash !== signature)
          throw new GlossaryError('Operation ID belongs to another decision', 409);
        return current;
      }
      if (current.revision !== input.revision || current.decision?.status === 'accepted')
        throw new GlossaryError('This suggestion changed. Reload before deciding.', 409);
      const next = {
        ...current,
        revision: current.revision + 1,
        decision: choice.action === 'dismiss' ? { status: 'dismissed' as const } : null,
      };
      await tx.put(key, next);
      await tx.put(receiptKey, { hash: signature });
      return next;
    });
    return json({ candidate });
  }
  return json({ error: 'Method not allowed' }, 405);
}
