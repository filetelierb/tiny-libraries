import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from './storage';
import {
  conceptSuggestionsRoute,
  acceptSuggestion,
  suggestionsSnapshot,
} from '../worker/concept-suggestions';
import { saveConcept, glossarySnapshot, GlossaryError } from '../worker/glossary';
import {
  conceptPlanSchema,
  validateConceptPlan,
  type ConceptPlan,
  type ConceptCandidate,
  type ResourceSuggestions,
} from '../shared/concept-suggestions';
import { glossaryInputSchema } from '../shared/glossary';
import { analyzeConcepts } from '../worker/meta';
import type { Learning } from '../shared/domain';

async function fixture() {
  const store = new MemoryStore(),
    sourceId = crypto.randomUUID(),
    owner = crypto.randomUUID(),
    tasks: Promise<unknown>[] = [];
  const learning = {
    sourceId,
    sourceVersion: 1,
    createdAt: '2026-10-26T12:00:00.000Z',
    segments: [
      { id: 'p2', text: 'An 8 Hz signal requires a sampling frequency above 16 Hz.', page: 2 },
    ],
  } as Learning;
  await store.put(`file:${sourceId}`, { id: sourceId, version: 1, folder: 'Sources' });
  await store.put(`learning:${sourceId}`, learning);
  const plan = conceptPlanSchema.parse({
    complete: true,
    warnings: [],
    concepts: [
      {
        id: 'rate',
        term: 'Frecuencia de muestreo',
        label: 'Signals',
        aliases: ['Sampling rate'],
        definition: 'Number of measurements per second.',
        evidence: [{ segmentId: 'p2', quote: 'sampling frequency above 16 Hz' }],
        matches: [],
        relations: [
          {
            candidateId: 'limit',
            entryId: null,
            kind: 'semantic',
            description: 'The sampling rate must exceed twice the signal frequency.',
          },
        ],
      },
      {
        id: 'limit',
        term: 'Nyquist requirement',
        label: 'Sampling',
        aliases: [],
        definition: 'Sampling must be above twice the signal frequency.',
        evidence: [
          { segmentId: 'p2', quote: 'An 8 Hz signal requires a sampling frequency above 16 Hz.' },
        ],
        matches: [],
        relations: [],
      },
    ],
  });
  let calls = 0;
  const run = async (
    path: string,
    method = 'GET',
    body?: unknown,
    override?: () => Promise<ConceptPlan>,
  ) =>
    conceptSuggestionsRoute({
      request: new Request(`http://local/api/concept-suggestions${path}`, { method }),
      storage: store.storage(),
      executionId: owner,
      body: async () => body,
      settings: async () => ({ configured: true, model: 'muse-spark-1.3', locale: 'en' }),
      start: (task) => tasks.push(task),
      analyze: async () => {
        calls++;
        return override ? override() : plan;
      },
    });
  const analyze = async (force = false) => {
    const response = await run('/analyze', 'POST', {
      sourceId,
      sourceVersion: 1,
      requestId: crypto.randomUUID(),
      force,
    });
    await Promise.all(tasks);
    return suggestionsSnapshot(
      store.storage(),
      ((await response!.json()) as ResourceSuggestions).analysis!.id,
      owner,
    );
  };
  return { store, sourceId, owner, tasks, learning, plan, run, analyze, calls: () => calls };
}
function choice(candidate: ConceptCandidate) {
  return {
    revision: candidate.revision,
    mutationId: crypto.randomUUID(),
    mode: 'create' as const,
    entryId: candidate.entryId,
    version: 0,
    senseId: `${candidate.id}:meaning`,
    term: candidate.term,
    label: candidate.label,
    definition: candidate.definition,
    aliases: candidate.aliases,
    links: [],
  };
}
test('concept analysis validates literal evidence and both relationship namespaces before saving proposals', async () => {
  const f = await fixture();
  assert.equal(validateConceptPlan(f.plan, f.learning, []).concepts.length, 2);
  for (const corrupt of [
    {
      ...f.plan,
      concepts: [
        { ...f.plan.concepts[0], evidence: [{ segmentId: 'missing', quote: 'Invented' }] },
      ],
    },
    {
      ...f.plan,
      concepts: [
        { ...f.plan.concepts[0], evidence: [{ segmentId: 'p2', quote: 'Unsupported quotation' }] },
      ],
    },
    {
      ...f.plan,
      concepts: [
        {
          ...f.plan.concepts[0],
          relations: [
            {
              candidateId: null,
              entryId: crypto.randomUUID(),
              kind: 'semantic',
              description: 'Related',
            },
          ],
        },
      ],
    },
  ])
    assert.throws(() => validateConceptPlan(corrupt, f.learning, []));
  const snapshot = await f.analyze();
  assert.equal(snapshot.analysis?.status, 'ready');
  assert.equal(snapshot.concepts.length, 2);
  assert.equal(snapshot.concepts[0].sources[0].location?.page, 2);
  assert.equal(
    (await glossarySnapshot(f.store.storage())).length,
    0,
    'analysis must not publish glossary entries',
  );
  await f.analyze();
  assert.equal(f.calls(), 1, 'source cache avoids duplicate provider calls');
});
test('running analyses have one owner, support interruption recovery, and reject reused request identity', async () => {
  const f = await fixture(),
    requestId = crypto.randomUUID();
  let finish!: (p: ConceptPlan) => void;
  const held = new Promise<ConceptPlan>((resolve) => {
    finish = resolve;
  });
  const response = await f.run(
    '/analyze',
    'POST',
    { sourceId: f.sourceId, sourceVersion: 1, requestId },
    () => held,
  );
  assert.equal(response?.status, 202);
  const duplicate = await f.run('/analyze', 'POST', {
    sourceId: f.sourceId,
    sourceVersion: 1,
    requestId: crypto.randomUUID(),
  });
  assert.equal(duplicate?.status, 200);
  assert.equal(f.calls(), 1);
  const snapshot = await suggestionsSnapshot(f.store.storage(), requestId, 'new-execution');
  assert.equal(snapshot.analysis?.status, 'interrupted');
  finish(f.plan);
  await Promise.all(f.tasks);
  assert.equal(
    (await suggestionsSnapshot(f.store.storage(), requestId, 'new-execution')).analysis?.status,
    'interrupted',
    'old owner cannot publish after interruption',
  );
  const other = crypto.randomUUID();
  await f.store.put(`file:${other}`, { id: other, version: 1, folder: '' });
  await f.store.put(`learning:${other}`, { ...f.learning, sourceId: other });
  await assert.rejects(
    f.run('/analyze', 'POST', { sourceId: other, sourceVersion: 1, requestId }),
    /another source/,
  );
});
test('review acceptance creates selected related concepts atomically and stores retry identity', async () => {
  const f = await fixture(),
    snapshot = await f.analyze(),
    candidate = snapshot.concepts.find((c) => c.term.startsWith('Frecuencia'))!,
    related = snapshot.concepts.find((c) => c.id === candidate.relations[0].candidateId)!;
  const input = {
    ...choice(candidate),
    links: [{ index: 0, entryId: related.entryId, create: true }],
  };
  const result = await acceptSuggestion(
    f.store.storage(),
    snapshot.analysis!.id,
    candidate.id,
    input,
  );
  assert.equal(result.entry?.senses[0].relations[0].entryId, related.entryId);
  assert.equal(result.entry?.reviewed, true);
  const all = await glossarySnapshot(f.store.storage());
  assert.equal(all.length, 2);
  assert.equal(
    all.find((e) => e.id === related.entryId)?.reviewed,
    false,
    'related draft keeps its review state explicit',
  );
  assert.deepEqual(
    await acceptSuggestion(f.store.storage(), snapshot.analysis!.id, candidate.id, input),
    result,
  );
  await assert.rejects(
    acceptSuggestion(f.store.storage(), snapshot.analysis!.id, candidate.id, {
      ...input,
      definition: 'Different payload',
    }),
    /another decision/,
  );
  assert.equal(
    (await suggestionsSnapshot(f.store.storage(), snapshot.analysis!.id, f.owner)).concepts.find(
      (c) => c.id === related.id,
    )?.decision?.status,
    'accepted',
  );
});
test('semantic acceptance adds a meaning and source without replacing a reviewed definition', async () => {
  const f = await fixture();
  const existing = await saveConcept(
    f.store.storage(),
    glossaryInputSchema.parse({
      id: crypto.randomUUID(),
      term: 'Sampling frequency',
      version: 0,
      archived: false,
      aliases: [],
      mutationId: crypto.randomUUID(),
      senses: [
        {
          id: crypto.randomUUID(),
          label: 'Reviewed',
          definition: 'Original reviewed definition',
          reviewed: true,
          sources: [],
          synonyms: [],
          relations: [],
        },
      ],
    }),
  );
  f.plan.concepts[0].matches = [
    { entryId: existing.id, reason: 'Spanish name for the same quantity' },
  ];
  const snapshot = await f.analyze(),
    candidate = snapshot.concepts.find((c) => c.matches.length)!;
  const input = {
    ...choice(candidate),
    mode: 'add' as const,
    entryId: existing.id,
    version: existing.version,
    aliases: [candidate.term],
  };
  const saved = await acceptSuggestion(
    f.store.storage(),
    snapshot.analysis!.id,
    candidate.id,
    input,
  );
  assert.equal(saved.entry!.definition, existing.definition);
  assert.equal(saved.entry!.senses.length, 2);
  assert.equal(saved.entry!.senses[0].reviewed, true);
  assert.equal(saved.entry!.senses[1].sources[0].location?.page, 2);
  const history = await f.store.get<{ definition: string }>(
    `glossary-history:${existing.id}:0000000001`,
  );
  assert.equal(history?.definition, existing.definition);
  const second = await f.analyze(true),
    again = second.concepts.find((c) => c.matches.length)!;
  const repeated = await acceptSuggestion(f.store.storage(), second.analysis!.id, again.id, {
    ...choice(again),
    mode: 'add',
    entryId: existing.id,
    version: saved.entry!.version,
    aliases: [candidate.term],
  });
  assert.equal(repeated.entry!.senses.length, 2, 'identical definitions reuse a meaning');
});
test('stale destination/source and conflicting decisions cannot partially publish related concepts', async () => {
  const f = await fixture(),
    snapshot = await f.analyze(),
    candidate = snapshot.concepts[0];
  await f.store.put(`file:${f.sourceId}`, { id: f.sourceId, version: 2, folder: 'Sources' });
  await assert.rejects(
    acceptSuggestion(f.store.storage(), snapshot.analysis!.id, candidate.id, choice(candidate)),
    /source changed/,
  );
  assert.equal((await glossarySnapshot(f.store.storage())).length, 0);
  await f.store.put(`file:${f.sourceId}`, { id: f.sourceId, version: 1, folder: 'Sources' });
  const dismiss = {
    action: 'dismiss',
    revision: candidate.revision,
    mutationId: crypto.randomUUID(),
  };
  await f.run(`/${snapshot.analysis!.id}/${candidate.id}`, 'POST', dismiss);
  await assert.rejects(
    acceptSuggestion(f.store.storage(), snapshot.analysis!.id, candidate.id, choice(candidate)),
    /suggestion changed/,
  );
  const now = (
    await suggestionsSnapshot(f.store.storage(), snapshot.analysis!.id, f.owner)
  ).concepts.find((c) => c.id === candidate.id)!;
  await f.run(`/${snapshot.analysis!.id}/${candidate.id}`, 'POST', {
    action: 'restore',
    revision: now.revision,
    mutationId: crypto.randomUUID(),
  });
  const restored = (
    await suggestionsSnapshot(f.store.storage(), snapshot.analysis!.id, f.owner)
  ).concepts.find((c) => c.id === candidate.id)!;
  assert.equal(restored.decision, null);
  assert.equal(restored.revision, 3);
});
test('save all resolves candidate relationships in two phases, preserves dismissals and returns a stable result', async () => {
  const f = await fixture(),
    snapshot = await f.analyze(),
    body = { mutationId: crypto.randomUUID() };
  const response = await f.run(`/${snapshot.analysis!.id}/accept-all`, 'POST', body);
  const result = await response!.json();
  assert.equal(result.created, 2);
  assert.equal(result.linksAdded, 1);
  assert.deepEqual(
    await (await f.run(`/${snapshot.analysis!.id}/accept-all`, 'POST', body))!.json(),
    result,
  );
  assert.equal((await glossarySnapshot(f.store.storage())).length, 2);
  const next = await f.analyze(true),
    dismiss = next.concepts.find((c) => c.term.startsWith('Frecuencia'))!;
  await f.run(`/${next.analysis!.id}/${dismiss.id}`, 'POST', {
    action: 'dismiss',
    revision: dismiss.revision,
    mutationId: crypto.randomUUID(),
  });
  await f.run(`/${next.analysis!.id}/accept-all`, 'POST', { mutationId: crypto.randomUUID() });
  assert.equal(
    (await suggestionsSnapshot(f.store.storage(), next.analysis!.id, f.owner)).concepts.find(
      (c) => c.id === dismiss.id,
    )?.decision?.status,
    'dismissed',
  );
});
test('Meta concept analysis receives source evidence and reviewed glossary as untrusted comparison data', async () => {
  const f = await fixture();
  let sent: Record<string, unknown> = {};
  const transport = async (_url: string, options: RequestInit) => {
    sent = JSON.parse(options.body as string);
    return Response.json({ choices: [{ message: { content: JSON.stringify(f.plan) } }] });
  };
  assert.equal(
    (await analyzeConcepts('test-placeholder', 'muse-spark-1.3', f.learning, [], 'es', transport))
      .concepts.length,
    2,
  );
  assert.match(JSON.stringify(sent.messages), /Spanish/);
  assert.match(JSON.stringify(sent.messages), /literal excerpt/);
  assert.equal((sent.response_format as { type: string }).type, 'json_schema');
});

test('concurrent bulk retries have one active operation and completed replay does not duplicate writes', async () => {
  const f = await fixture(),
    snapshot = await f.analyze(),
    input = { mutationId: crypto.randomUUID() };
  const result = await Promise.allSettled([
    f.run(`/${snapshot.analysis!.id}/accept-all`, 'POST', input),
    f.run(`/${snapshot.analysis!.id}/accept-all`, 'POST', input),
  ]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(
    (result.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.status,
    409,
  );
  const replay = await (await f.run(`/${snapshot.analysis!.id}/accept-all`, 'POST', input))!.json();
  assert.equal(replay.created, 2);
  assert.equal((await glossarySnapshot(f.store.storage())).length, 2);
});
test('explicit replacement retains earlier revision and bulk follow-up cannot mutate a different meaning', async () => {
  const f = await fixture(),
    existing = await saveConcept(
      f.store.storage(),
      glossaryInputSchema.parse({
        id: crypto.randomUUID(),
        term: 'Existing concept',
        version: 0,
        archived: false,
        aliases: [],
        mutationId: crypto.randomUUID(),
        senses: [
          {
            id: 'first',
            label: 'First',
            definition: 'Identical definition',
            reviewed: true,
            sources: [],
            synonyms: [],
            relations: [],
          },
          {
            id: 'second',
            label: 'Second',
            definition: 'Earlier reviewed definition',
            reviewed: true,
            sources: [],
            synonyms: [],
            relations: [],
          },
        ],
      }),
    );
  const snapshot = await f.analyze(),
    candidate = snapshot.concepts[0];
  const result = await acceptSuggestion(f.store.storage(), snapshot.analysis!.id, candidate.id, {
    ...choice(candidate),
    mode: 'replace',
    entryId: existing.id,
    version: existing.version,
    senseId: 'second',
    definition: 'Identical definition',
    aliases: [],
  });
  assert.equal(result.candidate.decision?.senseId, 'second');
  assert.equal(result.entry?.senses[0].sources.length, 0);
  assert.equal(result.entry?.senses[1].sources.length, 1);
  const history = await f.store.get<{ senses: Array<{ definition: string }> }>(
    `glossary-history:${existing.id}:0000000001`,
  );
  assert.equal(history?.senses[1].definition, 'Earlier reviewed definition');
});

test('prepared guide concepts stay as reviewable drafts and cannot bypass semantic comparison in bulk', async () => {
  const f = await fixture();
  f.learning.synthesis = {
    glossary: [
      { term: 'Frecuencia de muestreo', definition: 'Measurements per second', segmentIds: ['p2'] },
    ],
  } as Learning['synthesis'];
  await f.store.put(`learning:${f.sourceId}`, f.learning);
  const result = (await (await f.run(
    `?sourceId=${f.sourceId}&version=1`,
  ))!.json()) as ResourceSuggestions;
  assert.equal(result.analysis?.method, 'guide');
  assert.equal(result.concepts.length, 1);
  assert.equal((await glossarySnapshot(f.store.storage())).length, 0);
  await assert.rejects(
    f.run(`/${result.analysis!.id}/accept-all`, 'POST', { mutationId: crypto.randomUUID() }),
    /Analyze glossary matches/,
  );
  const compared = await f.analyze();
  assert.equal(compared.analysis?.method, 'semantic');
  assert.equal(f.calls(), 1);
  assert.equal(compared.concepts.length, 2);
});

test('recording hints begin at evidence and continue through its end plus twenty seconds', async () => {
  const { nearbyConcept } = await import('../shared/concept-suggestions');
  const f = await fixture(),
    snapshot = await f.analyze();
  const candidate = {
    ...snapshot.concepts[0],
    sources: [
      {
        sourceId: f.sourceId,
        sourceVersion: 1,
        segmentIds: ['p2'],
        location: { seconds: 10 },
        endSeconds: 40,
      },
    ],
  };
  assert.equal(nearbyConcept(candidate, { seconds: 5 }), false);
  assert.equal(nearbyConcept(candidate, { seconds: 10 }), true);
  assert.equal(nearbyConcept(candidate, { seconds: 59 }), true);
  assert.equal(nearbyConcept(candidate, { seconds: 61 }), false);
});

test('bulk review reports semantic-only matches instead of merging concepts solely on model judgment', async () => {
  const f = await fixture();
  const existing = await saveConcept(
    f.store.storage(),
    glossaryInputSchema.parse({
      id: crypto.randomUUID(),
      term: 'Existing rate',
      version: 0,
      archived: false,
      aliases: [],
      mutationId: crypto.randomUUID(),
      senses: [
        {
          id: 'reviewed',
          label: 'Reviewed',
          definition: 'Keep this reviewed definition',
          reviewed: true,
          sources: [],
          synonyms: [],
          relations: [],
        },
      ],
    }),
  );
  f.plan.concepts[0].matches = [
    { entryId: existing.id, reason: 'Possible cross-language equivalent' },
  ];
  f.plan.concepts[0].aliases = [existing.term];
  const snapshot = await f.analyze(),
    result = await (await f.run(`/${snapshot.analysis!.id}/accept-all`, 'POST', {
      mutationId: crypto.randomUUID(),
    }))!.json();
  assert.ok(
    result.skipped.some(
      (s: { term: string; reason: string }) =>
        s.term === f.plan.concepts[0].term && s.reason.includes('individually'),
    ),
  );
  assert.deepEqual(
    (await glossarySnapshot(f.store.storage())).find((c) => c.id === existing.id),
    existing,
  );
});

test('source analysis history retains preparation proposals, prior model analyses and decisions', async () => {
  const f = await fixture();
  f.learning.synthesis = {
    glossary: [{ term: 'Prepared term', definition: 'Source proposal', segmentIds: ['p2'] }],
  } as Learning['synthesis'];
  await f.store.put(`learning:${f.sourceId}`, f.learning);
  const guide = (await (await f.run(
    `?sourceId=${f.sourceId}&version=1`,
  ))!.json()) as ResourceSuggestions;
  const first = await f.analyze();
  const candidate = first.concepts[0];
  await f.run(`/${first.analysis!.id}/${candidate.id}`, 'POST', {
    action: 'dismiss',
    revision: candidate.revision,
    mutationId: crypto.randomUUID(),
  });
  const latest = await f.analyze(true);
  const history = await (await f.run(`/history?sourceId=${f.sourceId}&version=1`))!.json();
  assert.equal(history.items.length, 3);
  assert.ok(history.items.some((a: { id: string }) => a.id === guide.analysis!.id));
  assert.ok(history.items.some((a: { id: string }) => a.id === latest.analysis!.id));
  const old = (await (await f.run(`/${first.analysis!.id}`))!.json()) as ResourceSuggestions;
  assert.equal(old.concepts.find((c) => c.id === candidate.id)?.decision?.status, 'dismissed');
});
