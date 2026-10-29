import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFill,
  applyReview,
  conceptMatches,
  fillSegments,
  planConcepts,
  type ConceptContext,
  type GlossaryTerm,
} from '../shared/glossary-pipeline';
import type { Segment, Synthesis } from '../shared/domain';

const term = (name: string, segmentIds: string[]): GlossaryTerm => ({
  term: name,
  definition: `${name} definition`,
  aliases: [],
  segmentIds,
});
const segments: Segment[] = Array.from({ length: 10 }, (_, i) => ({
  id: `s${i}`,
  text: `Segment ${i}`,
}));
const synthesis = {
  title: 'Signals',
  chapters: [
    { id: 'c1', title: 'One', summary: 'First', segmentIds: ['s1', 's3'], questions: [] },
    { id: 'c2', title: 'Two', summary: 'Second', segmentIds: ['s7', 's8'], questions: [] },
  ],
  glossary: [],
  artifact: null,
} as unknown as Synthesis;

test('a review merges candidates with exactly their evidence and folds name variants', () => {
  const terms = [
    term('Dirac delta', ['s1']),
    term('Delta function', ['s2']),
    term('Analysis', ['s3']),
    term('Linear operations', ['s4']),
  ];
  const result = applyReview(terms, {
    terms: [
      {
        term: 'Dirac delta',
        definition: 'A unit impulse.',
        aliases: ['Delta function'],
        from: [0, 1, 9],
      },
      { term: 'Linear operation', definition: 'Superposition holds.', aliases: [], from: [3] },
      { term: 'linear operations', definition: 'Duplicate.', aliases: [], from: [3] },
      { term: 'Invented', definition: 'No candidates.', aliases: [], from: [] },
    ],
    missing: [],
  });
  assert.deepEqual(
    result.map((t) => [t.term, t.aliases, t.segmentIds]),
    [
      ['Dirac delta', ['Delta function'], ['s1', 's2']],
      ['Linear operation', [], ['s4']],
    ],
  );
});

test('missing terms are defined only from the named chapters and only when they cite them', () => {
  const available = fillSegments(segments, synthesis, [{ chapter: 1 }, { chapter: 7 }]);
  assert.deepEqual(
    available.map((s) => s.id),
    ['s7', 's8'],
  );
  const { terms, added } = applyFill(
    [term('Sampling', ['s1'])],
    {
      terms: [
        { term: 'Aliasing', definition: 'Folding.', aliases: [], segmentIds: ['s7', 's2'] },
        { term: 'Nyquist rate', definition: 'Uncited.', aliases: [], segmentIds: ['s2'] },
        {
          term: 'sampling',
          definition: 'Again.',
          aliases: ['Sampling process'],
          segmentIds: ['s8'],
        },
      ],
    },
    available,
  );
  assert.equal(added, 1);
  assert.deepEqual(
    terms.map((t) => [t.term, t.segmentIds, t.aliases]),
    [
      ['Sampling', ['s1', 's8'], ['Sampling process']],
      ['Aliasing', ['s7'], []],
    ],
  );
});

test('plans never rewrite reviewed meanings and keep unconfirmed synonyms separate', () => {
  const id = crypto.randomUUID(),
    other = crypto.randomUUID();
  const context: ConceptContext = {
    id,
    version: 3,
    term: 'Delta function',
    aliases: [],
    senses: [
      { id: 'reviewed', label: '', definition: 'Kept.', reviewed: true, sources: [] },
      { id: 'draft', label: '', definition: 'Draft.', reviewed: false, sources: [] },
    ],
  };
  const terms = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => term(n, ['s1']));
  const byName = [id, id, id, id, null, id],
    matches = conceptMatches(terms, byName, { matches: [{ term: 4, conceptId: other }] }, [
      { id, term: 'Delta function', aliases: [] },
    ]);
  assert.equal(matches[4], null, 'a pick outside the glossary is ignored');
  const plans = planConcepts(terms, matches, byName, [context], {
    decisions: [
      {
        term: 0,
        action: 'refine',
        senseId: 'reviewed',
        definition: 'New.',
        label: null,
        name: null,
      },
      {
        term: 1,
        action: 'refine',
        senseId: 'draft',
        definition: 'Better.',
        label: null,
        name: null,
      },
      {
        term: 2,
        action: 'new_sense',
        senseId: null,
        definition: 'Other use.',
        label: 'Discrete',
        name: null,
      },
      {
        term: 3,
        action: 'separate',
        senseId: null,
        definition: null,
        label: null,
        name: 'delta functions',
      },
      {
        term: 5,
        action: 'separate',
        senseId: null,
        definition: null,
        label: null,
        name: 'Kronecker delta',
      },
    ],
  });
  assert.deepEqual(
    plans.map((p) => [p.action, p.senseId, p.term]),
    [
      ['attach', 'reviewed', undefined],
      ['refine', 'draft', undefined],
      ['new_sense', undefined, undefined],
      ['new_sense', undefined, undefined],
      ['new', undefined, undefined],
      ['new', undefined, 'Kronecker delta'],
    ],
  );
  assert.equal(plans[1].conceptVersion, 3);
});
