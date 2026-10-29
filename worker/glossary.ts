import { z } from 'zod';
import type { Concept, ConceptSource, Directory, Learning, Source } from '../shared/domain';
import { sourceState } from '../shared/directories';
import {
  conceptAbbreviation,
  conceptKey,
  conceptOrigin,
  glossaryInputSchema,
  normalizeConcept,
  summarizeConcept,
  matchConcept,
  mergeGeneratedConcept,
  mergeGlossaryEntries,
  orphanConcepts,
  sameSource,
  conceptOrigins,
  type ConceptOrigin,
  type GlossaryEntry,
  type GlossaryInput,
  type GlossarySummary,
} from '../shared/glossary';

export type GlossaryStore = {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(options: {
    prefix: string;
    limit?: number;
    startAfter?: string;
    end?: string;
    reverse?: boolean;
  }): Promise<Map<string, T>>;
};
export type GlossaryStorage = GlossaryStore & {
  transaction<T>(callback: (tx: GlossaryStore) => Promise<T>): Promise<T>;
};
type Store = GlossaryStore;
export class GlossaryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
const entryKey = (id: string) => `concept-entry:${id}`;
const historyKey = (id: string, version: number) =>
  `glossary-history:${id}:${String(version).padStart(10, '0')}`;
const names = (entry: GlossaryEntry) => [
  ...new Set([entry.term, ...entry.aliases].map(conceptKey)),
];
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const revisionSummary = (value: GlossaryEntry) => ({
  version: value.version,
  term: value.term,
  archived: value.archived,
  reviewed: value.reviewed,
  updatedAt: value.updatedAt || null,
});

export async function resolveEntry(tx: Store, id: string) {
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(id)) throw new GlossaryError('A concept merge contains a cycle', 409);
    seen.add(id);
    const entry = await tx.get<GlossaryEntry>(entryKey(id));
    if (!entry?.mergedInto) return entry;
    id = entry.mergedInto;
  }
}

export async function writeEntry(tx: Store, value: GlossaryEntry, previous?: GlossaryEntry) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 120000)
    throw new GlossaryError(
      'This concept is too large. Shorten definitions or source excerpts.',
      413,
    );
  for (const name of names(value)) {
    const owner = await tx.get<string>(`concept-name:${name}`);
    if (owner && owner !== value.id && (await resolveEntry(tx, owner))?.id !== value.id)
      throw new GlossaryError(
        'A concept already uses this name or alias. Open it or merge the two concepts.',
        409,
      );
  }
  if (previous)
    for (const name of names(previous))
      if (
        !names(value).includes(name) &&
        (await tx.get(`concept-name:${name}`)) === value.id &&
        !(await tx.get(`concept-merge-name:${name}`))
      )
        await tx.delete(`concept-name:${name}`);
  await tx.put(entryKey(value.id), value);
  await tx.put(`concept-summary:${value.id}`, summarizeConcept(value));
  await tx.put(historyKey(value.id, value.version), value);
  await tx.put(
    `glossary-revision:${value.id}:${String(value.version).padStart(10, '0')}`,
    revisionSummary(value),
  );
  for (const name of names(value)) await tx.put(`concept-name:${name}`, value.id);
}
export async function ensureGlossary(storage: GlossaryStorage) {
  await registerConcepts(storage);
  await mergeNearDuplicates(storage);
}
async function registerConcepts(storage: GlossaryStorage) {
  if (await storage.get('glossary-registry:v1')) return;
  let after: string | undefined;
  for (;;) {
    const old = await storage.list<Concept>({
      prefix: 'concept:',
      limit: 50,
      ...(after ? { startAfter: after } : {}),
    });
    for (const value of old.values())
      await storage.transaction(async (tx) => {
        if (await tx.get(entryKey(value.id))) return;
        const entry = normalizeConcept(value);
        await tx.put(entryKey(entry.id), entry);
        await tx.put(`concept-summary:${entry.id}`, summarizeConcept(entry));
        await tx.put(historyKey(entry.id, entry.version), entry);
        await tx.put(
          `glossary-revision:${entry.id}:${String(entry.version).padStart(10, '0')}`,
          revisionSummary(entry),
        );
        // Keep every record if older names normalize to the same spelling.
        for (const name of names(entry))
          if (!(await tx.get(`concept-name:${name}`)))
            await tx.put(`concept-name:${name}`, entry.id);
        const versions = await tx.list<Concept>({ prefix: `concept-history:${entry.id}:` });
        for (const version of versions.values()) {
          const snapshot = normalizeConcept(version);
          if (!(await tx.get(historyKey(entry.id, snapshot.version)))) {
            await tx.put(historyKey(entry.id, snapshot.version), snapshot);
            await tx.put(
              `glossary-revision:${entry.id}:${String(snapshot.version).padStart(10, '0')}`,
              revisionSummary(snapshot),
            );
          }
        }
      });
    if (old.size < 50) break;
    after = [...old.keys()].at(-1);
  }
  await storage.put('glossary-registry:v1', true);
}
const originRank = { manual: 0, chat: 1, analysis: 2 };
/** Folds a concept into another: one revision for the target and a forwarder for the source. */
async function mergeEntries(
  tx: Store,
  source: GlossaryEntry,
  target: GlossaryEntry,
  mutationId: string,
  archived = false,
  fit = false,
) {
  let merged = mergeGlossaryEntries(target, source);
  // Automatic merges keep the target's evidence first; the rest stays in the forwarder's history.
  if (fit)
    merged = normalizeConcept({
      ...merged,
      senses: merged.senses
        .slice(0, 20)
        .map((sense) => ({ ...sense, sources: sense.sources.slice(0, 30) })),
    });
  glossaryInputSchema.parse({ ...merged, mutationId });
  const next = {
    ...merged,
    archived,
    version: target.version + 1,
    updatedAt: new Date().toISOString(),
  };
  // Transfer names in the same transaction as both revisions.
  for (const name of names(source)) {
    if (!(await tx.get(`concept-merge-name:${name}`)))
      await tx.put(`concept-merge-name:${name}`, source.id);
    if ((await tx.get(`concept-name:${name}`)) === source.id)
      await tx.delete(`concept-name:${name}`);
  }
  await writeEntry(tx, next, target);
  const forwarder = {
    ...source,
    version: source.version + 1,
    archived: true,
    mergedInto: target.id,
    updatedAt: next.updatedAt,
  };
  await tx.put(entryKey(source.id), forwarder);
  await tx.put(`concept-summary:${source.id}`, summarizeConcept(forwarder));
  await tx.put(historyKey(source.id, forwarder.version), forwarder);
  await tx.put(
    `glossary-revision:${source.id}:${String(forwarder.version).padStart(10, '0')}`,
    revisionSummary(forwarder),
  );
  return next;
}
/**
 * Names are indexed by concept key, so concepts that differ only in case, punctuation, plural or
 * a trailing abbreviation are one concept. Existing near-duplicates are merged once, keeping the
 * concept the student added or reviewed, else the one with the most evidence.
 */
async function mergeNearDuplicates(storage: GlossaryStorage) {
  if (await storage.get('glossary-names:v2')) return;
  await storage.transaction(async (tx) => {
    for (const prefix of ['concept-name:', 'concept-merge-name:'])
      for (const [key, id] of await tx.list<string>({ prefix })) {
        await tx.delete(key);
        if (prefix === 'concept-merge-name:')
          await tx.put(`${prefix}${conceptKey(key.slice(prefix.length))}`, id);
      }
    const live = [...(await tx.list<GlossaryEntry>({ prefix: 'concept-entry:' })).values()]
      .filter((entry) => !entry.mergedInto)
      .map(normalizeConcept)
      .sort(
        (a, b) =>
          originRank[conceptOrigin(a)] - originRank[conceptOrigin(b)] ||
          Number(b.reviewed) - Number(a.reviewed) ||
          b.sources.length - a.sources.length ||
          a.term.localeCompare(b.term),
      );
    const parent = live.map((_, i) => i),
      root = (i: number): number => (parent[i] === i ? i : (parent[i] = root(parent[i]))),
      byName = new Map<string, number>();
    live.forEach((entry, i) => {
      for (const name of names(entry)) {
        const other = byName.get(name);
        if (other === undefined) byName.set(name, i);
        else parent[Math.max(root(i), root(other))] = Math.min(root(i), root(other));
      }
    });
    const claim = async (entry: GlossaryEntry) => {
      for (const name of names(entry))
        if (!(await tx.get(`concept-name:${name}`))) await tx.put(`concept-name:${name}`, entry.id);
    };
    for (let i = 0; i < live.length; i++) {
      if (root(i) !== i) continue;
      let target = live[i];
      await claim(target);
      for (let j = i + 1; j < live.length; j++) {
        if (root(j) !== i) continue;
        const source = live[j];
        try {
          target = await mergeEntries(
            tx,
            source,
            target,
            crypto.randomUUID(),
            target.archived && source.archived,
            true,
          );
        } catch (error) {
          if (!(error instanceof GlossaryError) && !(error instanceof z.ZodError)) throw error;
          await claim(source);
        }
      }
    }
  });
  await storage.put('glossary-names:v2', true);
}
export async function glossarySnapshot(storage: GlossaryStorage) {
  await ensureGlossary(storage);
  return [...(await storage.list<GlossaryEntry>({ prefix: 'concept-entry:' })).values()];
}
async function fingerprint(value: unknown) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
async function receipt(
  tx: Store,
  mutationId: string,
  hash: string,
): Promise<GlossaryEntry | undefined> {
  const previous = await tx.get<{ hash: string; id: string; version: number }>(
    `glossary-mutation:${mutationId}`,
  );
  if (!previous) return;
  if (previous.hash !== hash)
    throw new GlossaryError('This operation ID has already been used for another change', 409);
  return tx.get<GlossaryEntry>(historyKey(previous.id, previous.version));
}
async function recordReceipt(tx: Store, mutationId: string, hash: string, entry: GlossaryEntry) {
  await tx.put(`glossary-mutation:${mutationId}`, { hash, id: entry.id, version: entry.version });
}
function requireVersion(entry: GlossaryEntry | undefined, version: number) {
  if ((entry?.version || 0) !== version)
    throw new GlossaryError(
      'This concept changed in another window. Reopen it before saving.',
      409,
    );
  if (entry?.mergedInto)
    throw new GlossaryError('This concept was merged. Edit its destination instead.', 409);
}
async function validateInput(tx: Store, input: GlossaryInput, previous?: GlossaryEntry) {
  if (new Set(input.senses.map((s) => s.id)).size !== input.senses.length)
    throw new GlossaryError('Each meaning needs a unique identity');
  const previousSources = previous?.senses.flatMap((s) => s.sources) || [];
  const directories = [...(await tx.list<Directory>({ prefix: 'directory:' })).values()];
  for (const sense of input.senses) {
    if (
      new Set(sense.synonyms).size !== sense.synonyms.length ||
      new Set(sense.relations.map((r) => r.entryId)).size !== sense.relations.length
    )
      throw new GlossaryError('Remove duplicate links from this meaning');
    for (const id of [...sense.synonyms, ...sense.relations.map((r) => r.entryId)]) {
      const linked = await tx.get<GlossaryEntry>(entryKey(id));
      if (id === input.id || linked?.mergedInto === input.id)
        throw new GlossaryError('A concept cannot link to itself');
      if (!linked) throw new GlossaryError('A linked concept is unavailable', 409);
    }
    for (const source of sense.sources) {
      if (previousSources.some((old) => sameSource(old, source))) continue;
      const file = await tx.get<Source>(`file:${source.sourceId}`);
      if (
        !file ||
        sourceState(file, directories) === 'trash' ||
        file.version !== source.sourceVersion
      )
        throw new GlossaryError('A source changed or is unavailable. Choose it again.', 409);
      if (source.segmentIds.length) {
        const learning = await tx.get<Learning>(`learning:${source.sourceId}`);
        if (
          !learning ||
          learning.sourceVersion !== source.sourceVersion ||
          source.segmentIds.some((id) => !learning.segments.some((s) => s.id === id))
        )
          throw new GlossaryError('A source passage is unavailable. Choose it again.', 409);
      }
    }
  }
}
export async function saveConcept(storage: GlossaryStorage, input: GlossaryInput) {
  await ensureGlossary(storage);
  const hash = await fingerprint(input);
  return storage.transaction(async (tx) => {
    const replay = await receipt(tx, input.mutationId, hash);
    if (replay) return replay;
    const previous = await tx.get<GlossaryEntry>(entryKey(input.id));
    requireVersion(previous, input.version);
    await validateInput(tx, input, previous);
    const value = normalizeConcept({
      ...previous,
      id: input.id,
      term: input.term,
      version: input.version + 1,
      archived: input.archived,
      aliases: input.aliases,
      senses: input.senses,
      definition: input.senses[0].definition,
      reviewed: false,
      sources: [],
      proposals: previous?.proposals || [],
      origin: previous ? previous.origin : 'manual',
      updatedAt: new Date().toISOString(),
    });
    await writeEntry(tx, value, previous);
    await recordReceipt(tx, input.mutationId, hash, value);
    return value;
  });
}
export async function ingestGeneratedConcept(
  storage: GlossaryStorage,
  term: string,
  definition: string,
  source: ConceptSource,
  origin: ConceptOrigin = 'analysis',
) {
  await ensureGlossary(storage);
  return storage.transaction(async (tx) => {
    const id = await tx.get<string>(`concept-name:${conceptKey(term)}`);
    const previous = id ? await resolveEntry(tx, id) : undefined;
    // "Fourier transform (FT)" keeps its abbreviation as an alias unless another concept owns it.
    const short = conceptAbbreviation(term)?.abbreviation,
      shortOwner = short ? await tx.get<string>(`concept-name:${conceptKey(short)}`) : undefined,
      aliases =
        short &&
        (!shortOwner || (previous && (await resolveEntry(tx, shortOwner))?.id === previous.id))
          ? [short]
          : [];
    const next = mergeGeneratedConcept(previous, term, definition, source, origin, aliases);
    if (JSON.stringify(previous) === JSON.stringify(next)) return previous!;
    const value = {
      ...next,
      version: previous ? previous.version + 1 : 1,
      updatedAt: new Date().toISOString(),
    };
    glossaryInputSchema.parse({ ...value, mutationId: crypto.randomUUID() });
    await writeEntry(tx, value, previous);
    return value;
  });
}
/** A concept the tutor saves at the student's request, with the evidence it cited, if any. */
export async function saveChatConcept(
  storage: GlossaryStorage,
  input: { term: string; definition: string; sources: ConceptSource[] },
) {
  await ensureGlossary(storage);
  return storage.transaction(async (tx) => {
    const id = await tx.get<string>(`concept-name:${conceptKey(input.term)}`);
    const previous = id ? await resolveEntry(tx, id) : undefined;
    let next: GlossaryEntry = previous
      ? normalizeConcept(previous)
      : normalizeConcept({
          id: crypto.randomUUID(),
          term: input.term,
          definition: input.definition,
          version: 1,
          reviewed: false,
          sources: [],
          proposals: [],
          origin: 'chat',
        });
    for (const source of input.sources)
      next = mergeGeneratedConcept(next, input.term, input.definition, source, 'chat');
    if (previous && JSON.stringify(previous) === JSON.stringify(next)) return previous;
    const value = {
      ...next,
      version: previous ? previous.version + 1 : 1,
      updatedAt: new Date().toISOString(),
    };
    glossaryInputSchema.parse({ ...value, mutationId: crypto.randomUUID() });
    await writeEntry(tx, value, previous);
    return value;
  });
}
/** Every glossary term of a prepared file becomes, or links to, a concept once per preparation. */
export async function ingestLearning(storage: GlossaryStorage, learning: Learning) {
  const marker = `concept-ingested:${learning.sourceId}:${learning.sourceVersion}:${learning.createdAt}`;
  if (await storage.get(marker)) return;
  for (const term of learning.synthesis?.glossary || []) {
    const segments = term.segmentIds
      .map((id) => learning.segments.find((s) => s.id === id && s.text.trim()))
      .filter((s) => !!s)
      .slice(0, 8);
    if (!term.term.trim() || !term.definition.trim() || !segments.length) continue;
    try {
      for (const segment of segments)
        await ingestGeneratedConcept(
          storage,
          term.term.slice(0, 200),
          term.definition.slice(0, 6000),
          {
            sourceId: learning.sourceId,
            sourceVersion: learning.sourceVersion,
            segmentIds: [segment.id],
            ...(segment.end != null ? { endSeconds: segment.end } : {}),
            location: {
              quote: segment.text.slice(0, 2000),
              ...(segment.page ? { page: segment.page } : {}),
              ...(segment.start != null ? { seconds: segment.start } : {}),
            },
          },
        );
    } catch (error) {
      // One unusable term (a name taken by an alias, an oversized entry) never blocks the rest.
      if (!(error instanceof GlossaryError) && !(error instanceof z.ZodError)) throw error;
    }
  }
  await storage.put(marker, true);
}
/** Files prepared before concepts were created automatically get their terms once. */
async function ingestPrepared(storage: GlossaryStorage) {
  if (await storage.get('glossary-ingest:v1')) return;
  for (const learning of (await storage.list<Learning>({ prefix: 'learning:' })).values())
    if (
      (await storage.get<Source>(`file:${learning.sourceId}`))?.version === learning.sourceVersion
    )
      await ingestLearning(storage, learning);
  await storage.put('glossary-ingest:v1', true);
}
async function existingFileIds(storage: GlossaryStore) {
  return new Set(
    [...(await storage.list({ prefix: 'file:' })).keys()].map((key) => key.slice('file:'.length)),
  );
}
/**
 * Removes concepts for good: their records, names and history, and the synonym or relation
 * links other concepts kept to them.
 */
export async function deleteConcepts(tx: GlossaryStore, ids: string[]) {
  const removed = new Set(ids);
  for (const id of removed) {
    const entry = await tx.get<GlossaryEntry>(entryKey(id));
    if (!entry) continue;
    for (const name of names(entry))
      if ((await tx.get(`concept-name:${name}`)) === id) await tx.delete(`concept-name:${name}`);
    for (const prefix of [`glossary-history:${id}:`, `glossary-revision:${id}:`])
      for (const key of (await tx.list({ prefix })).keys()) await tx.delete(key);
    await tx.delete(entryKey(id));
    await tx.delete(`concept-summary:${id}`);
  }
  for (const other of (await tx.list<GlossaryEntry>({ prefix: 'concept-entry:' })).values()) {
    if (other.mergedInto && removed.has(other.mergedInto)) {
      await tx.delete(entryKey(other.id));
      await tx.delete(`concept-summary:${other.id}`);
      continue;
    }
    const linked = other.senses.some(
      (sense) =>
        sense.synonyms.some((id) => removed.has(id)) ||
        sense.relations.some((r) => removed.has(r.entryId)),
    );
    if (!linked) continue;
    await writeEntry(
      tx,
      normalizeConcept({
        ...other,
        senses: other.senses.map((sense) => ({
          ...sense,
          synonyms: sense.synonyms.filter((id) => !removed.has(id)),
          relations: sense.relations.filter((r) => !removed.has(r.entryId)),
        })),
        version: other.version + 1,
        updatedAt: new Date().toISOString(),
      }),
      other,
    );
  }
  return removed.size;
}
export async function orphanSnapshot(storage: GlossaryStore) {
  return orphanConcepts(
    [...(await storage.list<GlossaryEntry>({ prefix: 'concept-entry:' })).values()],
    await existingFileIds(storage),
  );
}
const proposalAction = z.object({
  version: z.number().int().positive(),
  mutationId: z.string().uuid(),
  action: z.enum(['replace', 'add', 'dismiss']),
  proposalId: z.string().uuid(),
  senseId: z.string().optional(),
});
const mergeInput = z.object({
  sourceId: z.string().uuid(),
  sourceVersion: z.number().int().positive(),
  targetId: z.string().uuid(),
  targetVersion: z.number().int().positive(),
  mutationId: z.string().uuid(),
});
export async function glossaryRoute(
  request: Request,
  storage: GlossaryStorage,
  body: () => Promise<unknown>,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;
  if (!path.startsWith('/api/glossary')) return null;
  await ensureGlossary(storage);
  await ingestPrepared(storage);
  if (path === '/api/glossary' && request.method === 'GET') {
    const query = (url.searchParams.get('q') || '').slice(0, 200),
      archived = url.searchParams.get('archived') === 'true';
    const sourceIds = (url.searchParams.get('sources') || '').split(',').filter(Boolean);
    if (sourceIds.length > 200 || sourceIds.some((id) => !z.string().uuid().safeParse(id).success))
      throw new GlossaryError('Invalid source selection');
    const filter = url.searchParams.get('reviewed') || 'all';
    if (!['all', 'true', 'false'].includes(filter))
      throw new GlossaryError('Invalid review filter');
    const origin = url.searchParams.get('origin') || 'all';
    if (origin !== 'all' && !(conceptOrigins as readonly string[]).includes(origin))
      throw new GlossaryError('Invalid origin filter');
    // The orphan view lists archived and active concepts alike: both can be cleaned up.
    const orphans =
      url.searchParams.get('orphans') === 'true'
        ? new Set((await orphanSnapshot(storage)).map((entry) => entry.id))
        : null;
    // Summaries saved before origins existed infer theirs the same way entries do.
    const all = [...(await storage.list<GlossarySummary>({ prefix: 'concept-summary:' })).values()]
      .map((e) => ({ ...e, origin: e.origin ?? (e.sourceIds.length ? 'analysis' : 'manual') }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const items = all
      .filter(
        (e) =>
          (orphans ? orphans.has(e.id) : e.archived === archived) &&
          (origin === 'all' || e.origin === origin) &&
          (filter === 'all' || e.reviewed === (filter === 'true')) &&
          (!sourceIds.length || e.sourceIds.some((id) => sourceIds.includes(id))),
      )
      .flatMap((e) => {
        const match = matchConcept(e, query, all);
        return match ? [{ ...e, match }] : [];
      });
    const after = url.searchParams.get('after');
    if (after && !z.string().uuid().safeParse(after).success)
      throw new GlossaryError('Invalid glossary cursor');
    const remaining = items.filter((e) => !after || e.id > after),
      page = remaining.slice(0, 50);
    return json({
      items: page,
      nextCursor: remaining.length > 50 ? page.at(-1)!.id : null,
      total: items.length,
    });
  }
  if (path === '/api/glossary/vacuum' && request.method === 'POST') {
    const input = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(2000).optional() })
      .parse(await body());
    // Only concepts that are still orphans when the clean-up runs are removed; without a
    // list, every current orphan is.
    const deleted = await storage.transaction(async (tx) => {
      const orphans = (await orphanSnapshot(tx)).map((entry) => entry.id);
      return deleteConcepts(
        tx,
        input.ids ? orphans.filter((id) => input.ids!.includes(id)) : orphans,
      );
    });
    return json({ deleted });
  }
  if (path === '/api/glossary/merge' && request.method === 'POST') {
    const input = mergeInput.parse(await body()),
      hash = await fingerprint(input);
    if (input.sourceId === input.targetId)
      throw new GlossaryError('Choose a different destination');
    const value = await storage.transaction(async (tx) => {
      const replay = await receipt(tx, input.mutationId, hash);
      if (replay) return replay;
      const source = await tx.get<GlossaryEntry>(entryKey(input.sourceId)),
        target = await tx.get<GlossaryEntry>(entryKey(input.targetId));
      if (!source || !target) throw new GlossaryError('Concept not found', 404);
      requireVersion(source, input.sourceVersion);
      requireVersion(target, input.targetVersion);
      const next = await mergeEntries(tx, source, target, input.mutationId);
      await recordReceipt(tx, input.mutationId, hash, next);
      return next;
    });
    return json(value);
  }
  const match = path.match(/^\/api\/glossary\/([a-f0-9-]+)(?:\/(history|proposals)(?:\/(\d+))?)?$/);
  if (!match) return json({ error: 'Not found' }, 404);
  const id = z.string().uuid().parse(match[1]);
  if (!match[2] && request.method === 'PUT') {
    const input = glossaryInputSchema.parse(await body());
    if (input.id !== id) throw new GlossaryError('Concept identity mismatch');
    return json(await saveConcept(storage, input), input.version ? 200 : 201);
  }
  const entry = await storage.get<GlossaryEntry>(entryKey(id));
  if (!entry) throw new GlossaryError('Concept not found', 404);
  if (match[2] === 'history' && request.method === 'GET') {
    if (match[3]) {
      const version = await storage.get<GlossaryEntry>(historyKey(id, Number(match[3])));
      if (!version) throw new GlossaryError('Revision not found', 404);
      return json(version);
    }
    const prefix = `glossary-revision:${id}:`,
      after = url.searchParams.get('after');
    if (after && !new RegExp(`^${prefix}\\d{10}$`).test(after))
      throw new GlossaryError('Invalid history cursor');
    const page = await storage.list({
      prefix,
      reverse: true,
      limit: 50,
      ...(after ? { end: after } : {}),
    });
    return json({
      items: [...page.values()],
      nextCursor: page.size === 50 ? [...page.keys()].at(-1) : null,
    });
  }
  if (match[2] === 'proposals' && request.method === 'POST') {
    const input = proposalAction.parse(await body()),
      hash = await fingerprint({ id, ...input });
    const result = await storage.transaction(async (tx) => {
      const replay = await receipt(tx, input.mutationId, hash);
      if (replay) return replay;
      const current = await tx.get<GlossaryEntry>(entryKey(id));
      requireVersion(current, input.version);
      if (!current) throw new GlossaryError('Concept not found', 404);
      const proposal = current.proposals.find((p) => p.id === input.proposalId);
      if (!proposal) throw new GlossaryError('Proposal not found', 404);
      const senses = current.senses.map((s) => ({ ...s }));
      if (input.action === 'replace') {
        const index = senses.findIndex((s) => s.id === input.senseId);
        if (index < 0) throw new GlossaryError('Choose a meaning to replace');
        senses[index] = {
          ...senses[index],
          definition: proposal.definition,
          sources: [proposal.source],
          reviewed: true,
        };
      } else if (input.action === 'add')
        senses.push({
          id: crypto.randomUUID(),
          label: '',
          definition: proposal.definition,
          reviewed: true,
          sources: [proposal.source],
          synonyms: [],
          relations: [],
        });
      const next = normalizeConcept({
        ...current,
        senses,
        proposals: current.proposals.filter((p) => p.id !== proposal.id),
        version: current.version + 1,
        updatedAt: new Date().toISOString(),
      });
      glossaryInputSchema.parse({ ...next, mutationId: input.mutationId });
      await writeEntry(tx, next, current);
      await recordReceipt(tx, input.mutationId, hash, next);
      return next;
    });
    return json(result);
  }
  if (!match[2] && request.method === 'GET') return json(entry);
  return json({ error: 'Method not allowed' }, 405);
}
