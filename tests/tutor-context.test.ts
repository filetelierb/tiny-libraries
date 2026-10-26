import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import { glossaryInputSchema } from '../shared/glossary';
import type { Learning } from '../shared/domain';
import {
  conceptCitationId,
  conceptReferencesSchema,
  citedReferences,
  recoverCitations,
  sourceCitation,
  tutorCitationSchema,
  type TutorCitation,
} from '../shared/tutor-context';
import { citationFromHref, remarkTutorCitations } from '../src/tutor/citations';
import { loadTutorConcepts } from '../worker/tutor-context';
import { saveConcept } from '../worker/glossary';
import { runAssistant } from '../worker/meta';
import { MemoryStore } from './storage';

const sourceId = '31c90f6e-93ee-4018-87ab-03964476cb22';
const otherId = '56b051b5-fd75-474e-9e38-acfca62e1929';
const material: Learning = {
  sourceId,
  sourceVersion: 2,
  locale: 'en',
  model: 'test',
  createdAt: 'today',
  segments: [{ id: 'section-1', text: 'Allowed evidence', page: 3 }],
  synthesis: { title: 'Reading', chapters: [], glossary: [], artifact: null },
};
const input = () =>
  glossaryInputSchema.parse({
    id: crypto.randomUUID(),
    term: 'Sampling rate',
    version: 0,
    mutationId: crypto.randomUUID(),
    aliases: ['Measurement rate'],
    archived: false,
    senses: [
      {
        id: `${crypto.randomUUID()}:primary`,
        label: 'Selected source',
        definition: 'Measurements per second.',
        reviewed: true,
        synonyms: [],
        relations: [],
        sources: [{ sourceId, sourceVersion: 2, segmentIds: ['section-1'] }],
      },
      {
        id: crypto.randomUUID(),
        label: 'Another source',
        definition: 'A meaning from an unrelated source.',
        reviewed: false,
        synonyms: [],
        relations: [],
        sources: [{ sourceId: otherId, sourceVersion: 1, segmentIds: ['private'] }],
      },
    ],
  });
async function fixture() {
  const store = new MemoryStore();
  await store.put(`file:${sourceId}`, { id: sourceId, version: 2, path: 'reading.md' });
  await store.put(`file:${otherId}`, { id: otherId, version: 1, path: 'other.md' });
  await store.put(`learning:${sourceId}`, material);
  await store.put(`learning:${otherId}`, {
    ...material,
    sourceId: otherId,
    sourceVersion: 1,
    segments: [{ id: 'private', text: 'Unrelated evidence' }],
  });
  return store;
}

test('concept attachments preserve immutable revisions after later glossary edits', async () => {
  const store = await fixture();
  const original = await saveConcept(store.storage(), input());
  const latest = await saveConcept(store.storage(), {
    ...original,
    mutationId: crypto.randomUUID(),
    senses: [{ ...original.senses[0], definition: 'Later definition.' }],
  });
  const loaded = await loadTutorConcepts(store.storage(), [original], []);
  assert.equal(latest.version, 2);
  assert.equal(loaded.concepts.length, 1);
  assert.deepEqual(loaded.concepts[0].entry, original);
  assert.equal(loaded.concepts[0].scope, 'selection');
  assert.equal(loaded.mentions[0].version, 1);
  assert.equal('senses' in loaded.mentions[0], false);
  await assert.rejects(
    loadTutorConcepts(store.storage(), [{ id: original.id, version: 999 }], []),
    (e: unknown) => (e as { status: number }).status === 409,
  );
});

test('source-associated glossary tools include only meanings and evidence from selected file revisions', async () => {
  const store = await fixture();
  const entry = await saveConcept(store.storage(), input());
  const loaded = await loadTutorConcepts(store.storage(), [], [material]);
  assert.equal(loaded.concepts.length, 1);
  assert.equal(loaded.concepts[0].omittedMeanings, 1);
  assert.equal(loaded.concepts[0].entry.senses.length, 1);
  assert.equal(loaded.concepts[0].entry.senses[0].reviewed, true);
  assert.equal(JSON.stringify(loaded).includes('unrelated'), false);
  assert.equal(JSON.stringify(loaded).includes(otherId), false);
  assert.deepEqual(loaded.mentions, []);
  assert.deepEqual(
    (await loadTutorConcepts(store.storage(), [], [{ ...material, sourceVersion: 3 }])).concepts,
    [],
  );
  const explicit = await loadTutorConcepts(store.storage(), [entry], [material]);
  assert.equal(explicit.concepts[0].entry.senses.length, 2);
  assert.equal(explicit.concepts[0].scope, 'selection');
});

test('question concept references reject duplicates, missing revisions and excessive attachments', () => {
  assert.equal(conceptReferencesSchema.safeParse([{ id: sourceId, version: 1 }]).success, true);
  for (const refs of [
    [{ id: sourceId, version: 0 }],
    [
      { id: sourceId, version: 1 },
      { id: sourceId, version: 2 },
    ],
    Array.from({ length: 11 }, () => ({ id: crypto.randomUUID(), version: 1 })),
  ])
    assert.equal(conceptReferencesSchema.safeParse(refs).success, false);
});

test('concept tools do not grant file or bookmark access and citations require reading an available revision', async () => {
  const store = await fixture(),
    entry = await saveConcept(store.storage(), input());
  const loaded = await loadTutorConcepts(store.storage(), [entry], []);
  const id = conceptCitationId(entry),
    unread = `${sourceId}:section-1`;
  let calls = 0,
    writes = 0;
  const result = await runAssistant(
    'placeholder',
    'model',
    'Explain the attached concept.',
    [],
    [],
    { count: 0, correct: 0, percent: 0, needsPractice: [], evidence: 'Recorded attempts only' },
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      if (++calls === 1) {
        assert.match(body.messages[0].content, /Available segment index: \[\]/);
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'read',
                    type: 'function',
                    function: {
                      name: 'read_concepts',
                      arguments: JSON.stringify({ ids: [id, `concept.${entry.id}.v999`] }),
                    },
                  },
                  {
                    id: 'file',
                    type: 'function',
                    function: {
                      name: 'read_segments',
                      arguments: JSON.stringify({ ids: [unread] }),
                    },
                  },
                  {
                    id: 'bookmark',
                    type: 'function',
                    function: {
                      name: 'create_bookmark',
                      arguments: JSON.stringify({ segmentId: id, label: 'A concept' }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      const outputs = body.messages
        .filter((m: { role: string }) => m.role === 'tool')
        .map((m: { content: string }) => JSON.parse(m.content));
      assert.equal(outputs[0].length, 1);
      assert.equal(outputs[0][0].entry.senses[1].reviewed, false);
      assert.deepEqual(outputs[1], []);
      assert.match(outputs[2].error, /not available/);
      return Response.json({
        choices: [{ message: { content: `Meaning [${id}] [${unread}] [original]` } }],
      });
    },
    undefined,
    {
      concepts: loaded.concepts,
      createBookmark: async () => {
        writes++;
      },
    },
  );
  assert.equal(writes, 0);
  assert.deepEqual(
    result.citations.map((c) => c.id),
    [id],
  );
});

test('source-scoped concept citations retain the exact meaning IDs read and omit unread source references', async () => {
  const store = await fixture(),
    entry = await saveConcept(store.storage(), input());
  const loaded = await loadTutorConcepts(store.storage(), [], [material]);
  const id = conceptCitationId(entry),
    sourceRef = `${sourceId}:section-1`;
  let calls = 0;
  const result = await runAssistant(
    'placeholder',
    'model',
    'Read the current definition.',
    [],
    [material],
    { count: 0, correct: 0, percent: 0, needsPractice: [], evidence: 'Recorded attempts only' },
    async () => {
      if (++calls === 1)
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'read',
                    type: 'function',
                    function: { name: 'read_concepts', arguments: JSON.stringify({ ids: [id] }) },
                  },
                ],
              },
            },
          ],
        });
      return Response.json({
        choices: [
          {
            message: {
              content: `Definition [${id}] [${sourceRef}]. Labels [original] [continuous].`,
            },
          },
        ],
      });
    },
    undefined,
    { concepts: loaded.concepts },
  );
  assert.equal(result.citations.length, 1);
  const citation = result.citations[0];
  assert.equal(citation.kind, 'concept');
  if (citation.kind === 'concept') assert.deepEqual(citation.meaningIds, [entry.senses[0].id]);
  assert.equal(tutorCitationSchema.safeParse(citation).success, true);
});

test('citation extraction and Markdown rendering preserve ordinary labels, code, links and images', () => {
  const ref = sourceCitation(`${sourceId}:section-1`, sourceId, 2, material.segments[0]);
  const id = ref.id;
  const content = `Evidence [${id}]. Labels [original], [continuous].\n\n\`[${id}]\`\n\n~~~text\n[${id}]\n~~~\n\n[Link](https://example.com) ![${id}](https://example.com/image.png)`;
  const refs = citedReferences(content, [ref]);
  assert.equal(refs.length, 1);
  const html = renderToStaticMarkup(
    createElement(
      Markdown,
      { remarkPlugins: [[remarkTutorCitations, { references: refs, label: () => 'Page 3' }]] },
      content,
    ),
  );
  assert.equal((html.match(/href="#tutor\//g) || []).length, 1);
  assert.match(html, /Labels \[original\], \[continuous\]/);
  assert.match(html, /<code>\[/);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.equal(citationFromHref('#tutor/%', new Map([[id, ref]])), undefined);
  assert.equal(citationFromHref(`#tutor/${encodeURIComponent(id)}`, new Map([[id, ref]])), ref);
  assert.deepEqual(citedReferences(`\`[${id}]\``, [ref]), []);
});

test('historical citation recovery uses recorded source scope and rejects ambiguous or invented IDs', () => {
  const message = {
    content: `[${sourceId}:section-1] [original] [section-1]`,
    sourceIds: [sourceId],
  };
  const conversation = { id: 'current', sourceIds: [otherId], messages: [] };
  assert.deepEqual(
    recoverCitations(message, conversation, [material]).map((c) => c.id),
    [`${sourceId}:section-1`, 'section-1'],
  );
  assert.deepEqual(recoverCitations({ content: message.content }, conversation, [material]), []);
  const other = { ...material, sourceId: otherId };
  assert.deepEqual(
    recoverCitations({ content: '[section-1]', sourceIds: [sourceId, otherId] }, conversation, [
      material,
      other,
    ]),
    [],
  );
  const recovered = recoverCitations(message, conversation, [material])[0];
  assert.equal(recovered.kind, 'source');
  assert.equal((recovered as Extract<TutorCitation, { kind: 'source' }>).recovered, true);
});
