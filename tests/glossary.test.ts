import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  glossaryInputSchema,
  normalizeConcept,
  matchConcept,
  summarizeConcept,
  mergeGeneratedConcept,
  orphanConcepts,
  conceptsOnlyIn,
  type GlossaryEntry,
} from '../shared/glossary';
import {
  ensureGlossary,
  glossaryRoute,
  glossarySnapshot,
  ingestGeneratedConcept,
  ingestLearning,
  saveChatConcept,
  deleteConcepts,
  saveConcept,
} from '../worker/glossary';
import type { Concept, Learning } from '../shared/domain';
import { MemoryStore } from './storage';

const input = (term: string) =>
  glossaryInputSchema.parse({
    id: crypto.randomUUID(),
    term,
    version: 0,
    aliases: [],
    archived: false,
    mutationId: crypto.randomUUID(),
    senses: [
      {
        id: crypto.randomUUID(),
        label: '',
        definition: `${term} definition`,
        reviewed: true,
        synonyms: [],
        relations: [],
        sources: [],
      },
    ],
  });
const route = (store: MemoryStore, path: string, method = 'GET', body?: unknown) =>
  glossaryRoute(
    new Request(`http://local/api/glossary${path}`, { method }),
    store.storage(),
    async () => body,
  );

test('glossary migration preserves identities, reviewed definitions and earlier versions', async () => {
  const store = new MemoryStore(),
    id = crypto.randomUUID();
  const old: Concept = {
    id,
    term: 'Sampling',
    version: 2,
    definition: 'Reviewed definition',
    reviewed: true,
    sources: [],
    proposals: [],
  };
  await store.put('concept:sampling', old);
  await store.put(`concept-history:${id}:1`, {
    ...old,
    version: 1,
    definition: 'First definition',
  });
  await ensureGlossary(store.storage());
  await ensureGlossary(store.storage());
  const entries = await glossarySnapshot(store.storage());
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, id);
  assert.equal(entries[0].senses[0].definition, old.definition);
  assert.equal(entries[0].reviewed, true);
  assert.deepEqual(await store.get('concept:sampling'), old);
  const history = (await (await route(store, `/${id}/history/1`))!.json()) as Concept;
  assert.equal(history.definition, 'First definition');
});

test('concurrent glossary saves use revision checks; retries are idempotent and names have one owner', async () => {
  const store = new MemoryStore(),
    original = input('Sampling');
  const created = await saveConcept(store.storage(), original);
  assert.equal((await saveConcept(store.storage(), original)).version, 1);
  const edits = ['First edit', 'Second edit'].map((definition) => ({
    ...original,
    version: created.version,
    mutationId: crypto.randomUUID(),
    aliases: ['Sample rate'],
    senses: [{ ...created.senses[0], definition }],
  }));
  const outcomes = await Promise.allSettled(
    edits.map((edit) => saveConcept(store.storage(), edit)),
  );
  assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
  assert.equal(
    (outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason.status,
    409,
  );
  await assert.rejects(
    saveConcept(store.storage(), { ...original, term: 'Different payload' }),
    /operation ID/,
  );
  await assert.rejects(saveConcept(store.storage(), input('  SAMPLE  RATE ')), /already uses/);
  const entry = (await glossarySnapshot(store.storage()))[0];
  assert.equal(entry.version, 2);
  const revisions = (await (await route(store, `/${entry.id}/history`))!.json()) as {
    items: Concept[];
  };
  assert.deepEqual(
    revisions.items.map((v) => v.version),
    [2, 1],
  );
});

test('generation resolves aliases and links the file to a reviewed meaning without proposals', async () => {
  const store = new MemoryStore(),
    original = input('Sampling frequency');
  original.aliases = ['Sample rate'];
  const entry = await saveConcept(store.storage(), original);
  assert.equal(entry.origin, 'manual');
  const source = { sourceId: crypto.randomUUID(), sourceVersion: 1, segmentIds: ['segment-1'] };
  const linked = await ingestGeneratedConcept(
    store.storage(),
    'Sample rate',
    'A different explanation.',
    source,
  );
  assert.equal(linked.id, entry.id);
  assert.equal(linked.reviewed, true);
  assert.equal(linked.definition, entry.definition);
  assert.equal(linked.proposals.length, 0);
  assert.deepEqual(linked.senses[0].sources, [source]);
  assert.equal(linked.origin, 'manual');
  assert.equal(
    (
      await ingestGeneratedConcept(
        store.storage(),
        'sample rate',
        'A different explanation.',
        source,
      )
    ).version,
    linked.version,
  );
  const fresh = mergeGeneratedConcept(undefined, 'Aliasing', 'Folding of frequencies.', source);
  assert.equal(fresh.origin, 'analysis');
});

test('prepared files create concepts once, tagged as file analysis', async () => {
  const store = new MemoryStore(),
    sourceId = crypto.randomUUID();
  await store.put(`file:${sourceId}`, { id: sourceId, version: 1 });
  const learning = {
    sourceId,
    sourceVersion: 1,
    createdAt: '2026-10-28T00:00:00.000Z',
    segments: [
      { id: 's1', text: 'Aliasing folds high frequencies.' },
      { id: 's2', text: 'The Nyquist rate is twice the bandwidth.' },
    ],
    synthesis: {
      glossary: [
        { term: 'Aliasing', definition: 'Folding of frequencies.', segmentIds: ['s1'] },
        { term: 'Nyquist rate', definition: 'Twice the bandwidth.', segmentIds: ['s2', 'missing'] },
        { term: 'Unsupported', definition: 'No evidence.', segmentIds: ['missing'] },
      ],
    },
  } as unknown as Learning;
  await ingestLearning(store.storage(), learning);
  await ingestLearning(store.storage(), learning);
  const entries = await glossarySnapshot(store.storage());
  assert.deepEqual(entries.map((e) => e.term).sort(), ['Aliasing', 'Nyquist rate']);
  assert.ok(entries.every((e) => e.origin === 'analysis' && e.version === 1));
  assert.deepEqual(
    entries.find((e) => e.term === 'Nyquist rate')!.senses[0].sources.map((s) => s.segmentIds),
    [['s2']],
  );
  const chat = await saveChatConcept(store.storage(), {
    term: 'Sampling theorem',
    definition: 'Sampling above twice the bandwidth allows reconstruction.',
    sources: [],
  });
  assert.equal(chat.origin, 'chat');
  assert.equal(summarizeConcept(chat).origin, 'chat');
});

test('orphans cite no file and reach no concept that does; deleting them drops links', async () => {
  const store = new MemoryStore(),
    fileId = crypto.randomUUID(),
    gone = crypto.randomUUID();
  await store.put(`file:${fileId}`, { id: fileId, version: 1 });
  const cite = (sourceId: string) => [{ sourceId, sourceVersion: 1, segmentIds: ['s1'] }];
  const anchored = await saveConcept(store.storage(), input('Anchored'));
  const near = await saveConcept(store.storage(), input('Near'));
  const lonely = await saveConcept(store.storage(), input('Lonely'));
  const stale = await saveConcept(store.storage(), input('Stale'));
  const save = (entry: GlossaryEntry, sources: ReturnType<typeof cite>, links: string[] = []) =>
    store.storage().transaction(async (tx) => {
      const next = normalizeConcept({
        ...entry,
        senses: entry.senses.map((sense) => ({
          ...sense,
          sources,
          relations: links.map((entryId) => ({ entryId, description: 'Related' })),
        })),
      });
      await tx.put(`concept-entry:${entry.id}`, next);
      return next;
    });
  // Near has no file of its own but relates to Anchored; Stale cites a deleted file.
  const all = [
    await save(anchored, cite(fileId)),
    await save(near, [], [anchored.id]),
    await save(lonely, []),
    await save(stale, cite(gone), [lonely.id]),
  ];
  const files = new Set([fileId]);
  assert.deepEqual(
    orphanConcepts(all, files)
      .map((e) => e.term)
      .sort(),
    ['Lonely', 'Stale'],
  );
  assert.deepEqual(
    conceptsOnlyIn(all, new Set([fileId, gone]), new Set([gone])).map((e) => e.term),
    ['Stale'],
  );
  const listed = (await (await route(store, '?orphans=true'))!.json()) as { total: number };
  assert.equal(listed.total, 2);
  const result = (await (await route(store, '/vacuum', 'POST', {}))!.json()) as {
    deleted: number;
  };
  assert.equal(result.deleted, 2);
  const left = await glossarySnapshot(store.storage());
  assert.deepEqual(left.map((e) => e.term).sort(), ['Anchored', 'Near']);
  assert.equal(await store.get(`concept-name:lonely`), undefined);
  await store.storage().transaction((tx) => deleteConcepts(tx, [anchored.id]));
  const remaining = await glossarySnapshot(store.storage());
  assert.deepEqual(remaining[0].senses[0].relations, []);
});

test('explicit merge retains distinct meanings, archive forwarding, history and canonical alias ownership', async () => {
  const store = new MemoryStore(),
    a = input('Sample rate'),
    b = input('Sampling frequency');
  const source = await saveConcept(store.storage(), a),
    target = await saveConcept(store.storage(), b);
  const request = {
    sourceId: source.id,
    sourceVersion: source.version,
    targetId: target.id,
    targetVersion: target.version,
    mutationId: crypto.randomUUID(),
  };
  const merged = (await (await route(store, '/merge', 'POST', request))!.json()) as ReturnType<
    typeof normalizeConcept
  >;
  assert.equal(merged.id, target.id);
  assert.equal(merged.senses.length, 2);
  assert.ok(merged.aliases.includes(source.term));
  const forwarder = (await (await route(store, `/${source.id}`))!.json()) as ReturnType<
    typeof normalizeConcept
  >;
  assert.equal(forwarder.mergedInto, target.id);
  assert.equal(forwarder.archived, true);
  assert.equal(
    ((await (await route(store, '/merge', 'POST', request))!.json()) as Concept).version,
    merged.version,
  );
  const fromAlias = await ingestGeneratedConcept(
    store.storage(),
    'Sample rate',
    source.definition,
    { sourceId: crypto.randomUUID(), sourceVersion: 1, segmentIds: [] },
  );
  assert.equal(fromAlias.id, target.id);
  assert.equal(fromAlias.senses.length, 2);
  const old = (await (await route(store, `/${source.id}/history/1`))!.json()) as Concept;
  assert.equal(old.definition, source.definition);
});

test('source, link and identity validation rejects stale sources and dangling relationships', async () => {
  const store = new MemoryStore(),
    original = input('Verified concept'),
    sourceId = crypto.randomUUID();
  original.senses[0].sources = [{ sourceId, sourceVersion: 1, segmentIds: [] }];
  await assert.rejects(saveConcept(store.storage(), original), /source changed/);
  await store.put(`file:${sourceId}`, { id: sourceId, version: 2 });
  await assert.rejects(saveConcept(store.storage(), original), /source changed/);
  original.senses[0].sources[0].sourceVersion = 2;
  original.senses[0].relations = [{ entryId: crypto.randomUUID(), description: 'Related' }];
  await assert.rejects(saveConcept(store.storage(), original), /linked concept/);
  original.senses[0].relations = [];
  original.senses[0].synonyms = [original.id];
  await assert.rejects(saveConcept(store.storage(), original), /itself/);
  original.senses[0].synonyms = [];
  original.senses.push({ ...original.senses[0] });
  await assert.rejects(saveConcept(store.storage(), original), /unique identity/);
});

test('glossary title and synonym search, scope and cursor paging return each matching entry once', async () => {
  const store = new MemoryStore(),
    linked = input('Nyquist limit'),
    entry = input('Sampling theorem');
  const synonym = await saveConcept(store.storage(), linked);
  entry.senses[0].synonyms = [synonym.id];
  await saveConcept(store.storage(), entry);
  for (let i = 0; i < 102; i++) await saveConcept(store.storage(), input(`Unrelated ${i}`));
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = (await (await route(store, cursor ? `?after=${cursor}` : ''))!.json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    for (const item of page.items) {
      assert.equal(seen.has(item.id), false);
      seen.add(item.id);
    }
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(seen.size, 104);
  const found = (await (await route(store, '?q=nyquist'))!.json()) as {
    items: { id: string; match: string }[];
  };
  assert.equal(found.items.length, 2);
  assert.equal(found.items.find((e) => e.id === entry.id)?.match, 'synonym');
  assert.equal(
    matchConcept(
      summarizeConcept(
        normalizeConcept({
          ...entry,
          definition: 'Definition',
          reviewed: true,
          sources: [],
          proposals: [],
        }),
      ),
      'nyquist',
      [summarizeConcept(synonym)],
    ),
    'synonym',
  );
  const scoped = (await (await route(store, `?sources=${crypto.randomUUID()}`))!.json()) as {
    items: unknown[];
  };
  assert.equal(scoped.items.length, 0);
});

test('merged names keep resolving after restoring earlier content and merging the destination again', async () => {
  const store = new MemoryStore();
  const a = await saveConcept(store.storage(), input('First name'));
  const b = await saveConcept(store.storage(), input('Second name'));
  const c = await saveConcept(store.storage(), input('Third name'));
  const merged = (await (await route(store, '/merge', 'POST', {
    sourceId: a.id,
    sourceVersion: a.version,
    targetId: b.id,
    targetVersion: b.version,
    mutationId: crypto.randomUUID(),
  }))!.json()) as ReturnType<typeof normalizeConcept>;
  const restored = await saveConcept(store.storage(), {
    ...b,
    version: merged.version,
    mutationId: crypto.randomUUID(),
  });
  assert.equal(restored.aliases.length, 0);
  const final = (await (await route(store, '/merge', 'POST', {
    sourceId: restored.id,
    sourceVersion: restored.version,
    targetId: c.id,
    targetVersion: c.version,
    mutationId: crypto.randomUUID(),
  }))!.json()) as ReturnType<typeof normalizeConcept>;
  const generated = await ingestGeneratedConcept(
    store.storage(),
    'First name',
    'Additional definition',
    { sourceId: crypto.randomUUID(), sourceVersion: 1, segmentIds: [] },
  );
  assert.equal(generated.id, final.id);
  await assert.rejects(saveConcept(store.storage(), input('First name')), /already uses/);
});
