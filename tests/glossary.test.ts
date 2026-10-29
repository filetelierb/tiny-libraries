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
  conceptAbbreviation,
  conceptKey,
  type GlossaryEntry,
} from '../shared/glossary';
import {
  ensureGlossary,
  glossaryRoute,
  glossarySnapshot,
  ingestGeneratedConcept,
  ingestLearning,
  saveChatConcept,
  saveTutorConcept,
  searchConcepts,
  deleteConcepts,
  saveConcept,
  conceptIndex,
  conceptContexts,
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

test('concept keys ignore case, punctuation, plurals and a trailing abbreviation only', () => {
  assert.equal(conceptKey('Linear operations'), conceptKey('linear operation'));
  assert.equal(
    conceptKey('discrete Fourier transform (DFT)'),
    conceptKey('Discrete Fourier Transform'),
  );
  assert.equal(conceptKey('Period / wavelength'), conceptKey('period wavelength'));
  assert.equal(conceptKey('Frequencies'), conceptKey('frequency'));
  assert.equal(conceptKey('Analysis'), 'analysis');
  assert.deepEqual(conceptAbbreviation('linear time-invariant (LTI)'), {
    term: 'linear time-invariant',
    abbreviation: 'LTI',
  });
  assert.equal(conceptAbbreviation('Sampling theorem (WKS)'), null);
  // A parenthetical that is not an abbreviation still tells two concepts apart.
  assert.notEqual(conceptKey('Sampling interval (verification)'), conceptKey('sampling interval'));
  assert.notEqual(conceptKey('power (energy) spectrum'), conceptKey('power spectrum'));
});

test('generated near-duplicate terms join one concept and keep the abbreviation as an alias', async () => {
  const store = new MemoryStore(),
    source = (n: number) => ({
      sourceId: crypto.randomUUID(),
      sourceVersion: 1,
      segmentIds: [`segment-${n}`],
    });
  const first = await ingestGeneratedConcept(
    store.storage(),
    'Discrete Fourier Transform',
    'Samples of a spectrum.',
    source(1),
  );
  const second = await ingestGeneratedConcept(
    store.storage(),
    'discrete Fourier transform (DFT)',
    'Samples of a spectrum.',
    source(2),
  );
  assert.equal(second.id, first.id);
  assert.equal(second.term, 'Discrete Fourier Transform');
  assert.deepEqual(second.aliases, ['DFT']);
  assert.equal(second.senses[0].sources.length, 2);
  assert.equal(
    (await ingestGeneratedConcept(store.storage(), 'DFT', 'Samples.', source(3))).id,
    first.id,
  );
  const plural = await ingestGeneratedConcept(
    store.storage(),
    'Linear operations',
    'Maps.',
    source(4),
  );
  assert.equal(
    (await ingestGeneratedConcept(store.storage(), 'linear operation', 'Maps.', source(5))).id,
    plural.id,
  );
  assert.equal((await glossarySnapshot(store.storage())).length, 2);
});

test('existing near-duplicates merge once into the concept the student added', async () => {
  const store = new MemoryStore(),
    legacy = (term: string, origin: Concept['origin'], sources = 1): Concept => ({
      id: crypto.randomUUID(),
      term,
      version: 1,
      definition: `${term} definition`,
      reviewed: false,
      sources: Array.from({ length: sources }, (_, i) => ({
        sourceId: crypto.randomUUID(),
        sourceVersion: 1,
        segmentIds: [`segment-${i}`],
      })),
      proposals: [],
      origin,
    });
  const concepts = [
    legacy('discrete Fourier transform (DFT)', 'analysis', 20),
    legacy('Discrete Fourier Transform', 'manual'),
    legacy('Linear operation', 'analysis'),
    legacy('Linear operations', 'analysis', 2),
    legacy('Sampling interval (verification)', 'manual'),
    legacy('sampling interval', 'analysis'),
  ];
  for (const concept of concepts) await store.put(`concept:${concept.id}`, concept);
  await ensureGlossary(store.storage());
  await ensureGlossary(store.storage());
  const entries = await glossarySnapshot(store.storage()),
    live = entries.filter((entry) => !entry.mergedInto);
  assert.deepEqual(live.map((entry) => entry.term).sort(), [
    'Discrete Fourier Transform',
    'Linear operations',
    'Sampling interval (verification)',
    'sampling interval',
  ]);
  const dft = live.find((entry) => entry.term === 'Discrete Fourier Transform')!;
  assert.equal(dft.id, concepts[1].id);
  assert.equal(dft.origin, 'manual');
  assert.deepEqual(dft.aliases, ['DFT']);
  assert.equal(dft.sources.length, 21);
  const forwarder = entries.find((entry) => entry.id === concepts[0].id)!;
  assert.equal(forwarder.mergedInto, dft.id);
  assert.equal(
    (
      await ingestGeneratedConcept(store.storage(), 'Discrete Fourier transforms', 'x', {
        sourceId: crypto.randomUUID(),
        sourceVersion: 1,
        segmentIds: ['segment-x'],
      })
    ).id,
    dft.id,
  );
});

test('reviewed plans attach, refine or add meanings, and fall back to names when a concept changed', async () => {
  const store = new MemoryStore(),
    first = crypto.randomUUID(),
    second = crypto.randomUUID();
  await store.put(`file:${first}`, { id: first, version: 1, name: 'Lecture 1.pdf' });
  await store.put(`file:${second}`, { id: second, version: 1, name: 'Reader.pdf' });
  const learning = (sourceId: string, glossary: Learning['synthesis']['glossary']) =>
    ({
      sourceId,
      sourceVersion: 1,
      createdAt: new Date().toISOString(),
      segments: [
        { id: 's1', text: 'The delta function picks out a value.' },
        { id: 's2', text: 'The discrete delta is one at zero.' },
        { id: 's3', text: 'A shah function is a train of deltas.' },
      ],
      synthesis: { glossary },
    }) as unknown as Learning;
  await ingestLearning(
    store.storage(),
    learning(first, [
      { term: 'Delta function', definition: 'Picks out a value.', segmentIds: ['s1'] },
      { term: 'Sampling', definition: 'Taking values.', segmentIds: ['s1'] },
    ]),
  );
  const { index, byName } = await conceptIndex(store.storage(), [
    ['Dirac delta', 'Delta functions'],
    ['Shah function'],
  ]);
  assert.equal(index.length, 2);
  const delta = index.find((item) => item.term === 'Delta function')!;
  assert.deepEqual(byName, [delta.id, null]);
  const [context] = await conceptContexts(store.storage(), [delta.id]);
  assert.deepEqual(context.senses[0].sources, [
    { file: 'Lecture 1.pdf', quote: 'The delta function picks out a value.' },
  ]);
  const sampling = index.find((item) => item.term === 'Sampling')!;
  const reader = learning(second, [
    { term: 'Dirac delta', definition: 'A unit impulse.', segmentIds: ['s1'] },
    { term: 'Discrete delta', definition: 'One at zero.', segmentIds: ['s2'] },
    { term: 'Shah function', definition: 'A train of deltas.', segmentIds: ['s3'] },
    { term: 'Sampling', definition: 'Recording values.', segmentIds: ['s3'] },
  ]);
  reader.concepts = [
    {
      action: 'refine',
      conceptId: delta.id,
      conceptVersion: context.version,
      senseId: context.senses[0].id,
      definition: 'A unit impulse that picks out a value.',
      aliases: ['Dirac delta'],
    },
    {
      action: 'new_sense',
      conceptId: delta.id,
      conceptVersion: context.version,
      definition: 'One at zero and zero elsewhere.',
      label: 'Discrete',
      aliases: [],
    },
    { action: 'new', aliases: ['III'] },
    // Planned against a version that no longer exists: joins by name instead.
    { action: 'attach', conceptId: sampling.id, conceptVersion: 99, aliases: ['Taking samples'] },
  ];
  await ingestLearning(store.storage(), reader);
  const entries = (await glossarySnapshot(store.storage())).filter((e) => !e.mergedInto),
    updated = entries.find((e) => e.id === delta.id)!;
  assert.equal(updated.senses[0].definition, 'A unit impulse that picks out a value.');
  assert.equal(updated.senses[0].sources.length, 2);
  assert.deepEqual(updated.aliases, ['Dirac delta']);
  assert.deepEqual(
    updated.senses.slice(1).map((s) => [s.label, s.definition, s.sources[0].sourceId]),
    [['Discrete', 'One at zero and zero elsewhere.', second]],
  );
  assert.equal(updated.version, context.version + 2);
  assert.deepEqual(entries.find((e) => e.term === 'Shah function')!.aliases, ['III']);
  const samplingEntry = entries.find((e) => e.id === sampling.id)!;
  assert.deepEqual(samplingEntry.aliases, []);
  assert.equal(samplingEntry.sources.length, 2);
});

test('a planned refinement never replaces a definition the student reviewed', async () => {
  const store = new MemoryStore(),
    sourceId = crypto.randomUUID(),
    reviewed = await saveConcept(store.storage(), input('Convolution'));
  const plan = {
    action: 'refine' as const,
    conceptId: reviewed.id,
    conceptVersion: reviewed.version,
    senseId: reviewed.senses[0].id,
    definition: 'Rewritten.',
    aliases: [],
  };
  await ingestLearning(store.storage(), {
    sourceId,
    sourceVersion: 1,
    createdAt: new Date().toISOString(),
    segments: [{ id: 's1', text: 'Convolution smooths.' }],
    synthesis: {
      glossary: [{ term: 'Convolution', definition: 'Rewritten.', segmentIds: ['s1'] }],
    },
    concepts: [plan],
  } as unknown as Learning);
  const [entry] = await glossarySnapshot(store.storage());
  assert.equal(entry.senses[0].definition, 'Convolution definition');
  assert.equal(entry.senses[0].sources[0].sourceId, sourceId);
});

test('the tutor creates, refines and extends concepts without rewriting reviewed meanings', async () => {
  const store = new MemoryStore(),
    storage = store.storage();
  const change = (value: Partial<Parameters<typeof saveTutorConcept>[1]>) =>
    saveTutorConcept(storage, {
      action: 'create',
      mutationId: crypto.randomUUID(),
      sources: [],
      basis: 'general',
      links: [],
      ...value,
    });
  const wavelet = await change({
    term: 'Wavelet transform',
    definition: 'Decomposes a signal into shifted and scaled copies of a short wave.',
    aliases: ['Wavelet'],
  });
  assert.equal(wavelet.origin, 'chat');
  assert.equal(wavelet.senses[0].basis, 'general');
  await assert.rejects(
    change({ term: 'wavelet transforms', definition: 'Again.' }),
    /already in the glossary/,
  );
  const refined = await change({
    action: 'refine',
    conceptId: wavelet.id,
    version: wavelet.version,
    senseId: wavelet.senses[0].id,
    definition: 'Decomposes a signal into shifted and scaled copies of a mother wavelet.',
    basis: 'web',
    links: [{ url: 'https://example.org/wavelets', title: 'Wavelets' }],
  });
  assert.equal(refined.version, 2);
  assert.equal(refined.senses[0].basis, 'web');
  assert.deepEqual(refined.senses[0].links, [
    { url: 'https://example.org/wavelets', title: 'Wavelets' },
  ]);
  const extended = await change({
    action: 'add_sense',
    conceptId: wavelet.id,
    version: refined.version,
    label: 'Image compression',
    definition: 'The basis of compression formats such as JPEG 2000.',
  });
  assert.equal(extended.senses.length, 2);
  assert.deepEqual(
    (await searchConcepts(storage, 'wavelet')).map((e) => e.id),
    [wavelet.id],
  );
  await assert.rejects(
    change({
      action: 'refine',
      conceptId: wavelet.id,
      version: 1,
      senseId: wavelet.senses[0].id,
      definition: 'Stale.',
    }),
    /changed in another window/,
  );
  const reviewed = await saveConcept(storage, input('Aliasing'));
  await assert.rejects(
    change({
      action: 'refine',
      conceptId: reviewed.id,
      version: reviewed.version,
      senseId: reviewed.senses[0].id,
      definition: 'Rewritten.',
    }),
    /reviewed meaning keeps its definition/,
  );
  const linked = await change({
    action: 'add_evidence',
    conceptId: reviewed.id,
    version: reviewed.version,
    senseId: reviewed.senses[0].id,
    basis: 'web',
    links: [{ url: 'https://example.org/aliasing', title: 'Aliasing' }],
  });
  assert.equal(linked.senses[0].definition, 'Aliasing definition');
  assert.equal(linked.senses[0].links?.length, 1);
});
