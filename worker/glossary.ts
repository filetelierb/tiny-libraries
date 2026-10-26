import { z } from 'zod';
import type { Concept, ConceptSource, Directory, Learning, Source } from '../shared/domain';
import { sourceState } from '../shared/directories';
import {
  conceptName,
  glossaryInputSchema,
  normalizeConcept,
  summarizeConcept,
  matchConcept,
  mergeGeneratedConcept,
  mergeGlossaryEntries,
  sameSource,
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
  ...new Set([entry.term, ...entry.aliases].map(conceptName)),
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
) {
  await ensureGlossary(storage);
  return storage.transaction(async (tx) => {
    const id = await tx.get<string>(`concept-name:${conceptName(term)}`);
    const previous = id ? await resolveEntry(tx, id) : undefined;
    const next = mergeGeneratedConcept(previous, term, definition, source);
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
  if (path === '/api/glossary' && request.method === 'GET') {
    const query = (url.searchParams.get('q') || '').slice(0, 200),
      archived = url.searchParams.get('archived') === 'true';
    const sourceIds = (url.searchParams.get('sources') || '').split(',').filter(Boolean);
    if (sourceIds.length > 200 || sourceIds.some((id) => !z.string().uuid().safeParse(id).success))
      throw new GlossaryError('Invalid source selection');
    const filter = url.searchParams.get('reviewed') || 'all';
    if (!['all', 'true', 'false'].includes(filter))
      throw new GlossaryError('Invalid review filter');
    const all = [
      ...(await storage.list<GlossarySummary>({ prefix: 'concept-summary:' })).values(),
    ].sort((a, b) => a.id.localeCompare(b.id));
    const items = all
      .filter(
        (e) =>
          e.archived === archived &&
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
      const merged = mergeGlossaryEntries(target, source);
      glossaryInputSchema.parse({ ...merged, mutationId: input.mutationId });
      const next = {
        ...merged,
        archived: false,
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
