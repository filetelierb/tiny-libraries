import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captions,
  fold,
  kindFor,
  publicLearning,
  reviewSummary,
  validateSynthesis,
  mergeConcept,
  type Learning,
  type Segment,
  type Attempt,
} from '../shared/domain';
import { aliasFrequency } from '../src/SignalExplorer';

const segments: Segment[] = [
  {
    id: 'a',
    text: 'Sample at more than twice the highest signal frequency.',
    start: 300,
    end: 305,
  },
];
const synthesis = {
  title: 'Sampling',
  chapters: [
    {
      id: 'chapter-1',
      title: 'Nyquist',
      summary: 'Choose an adequate rate.',
      segmentIds: ['a'],
      questions: [
        {
          id: 'q1',
          kind: null,
          expectedAnswer: null,
          rubric: null,
          prompt: 'What is the minimum threshold for 8 Hz?',
          choices: ['Above 16 Hz', 'Below 8 Hz'],
          correctIndex: 0,
          explanation: 'The rate must exceed twice the frequency.',
          concept: 'Nyquist',
          segmentIds: ['a'],
        },
      ],
    },
  ],
  glossary: [{ term: 'Nyquist', definition: 'Sampling threshold.', segmentIds: ['a'] }],
  artifact: null,
};
test('source references must resolve before learning material is published', () => {
  assert.equal(validateSynthesis(synthesis, segments).chapters.length, 1);
  const broken = structuredClone(synthesis);
  broken.chapters[0].questions[0].segmentIds = ['fabricated'];
  assert.throws(() => validateSynthesis(broken, segments), /Unresolvable question/);
});
test('quiz answer keys never appear in public material', () => {
  const learning: Learning = {
    sourceId: 'a',
    sourceVersion: 1,
    locale: 'en',
    model: 'test',
    segments,
    synthesis,
    createdAt: '2026-10-26',
  };
  const output = JSON.stringify(publicLearning(learning));
  assert.ok(!output.includes('correctIndex'));
  assert.ok(!output.includes('explanation'));
  assert.ok(output.includes('choices'));
});
test('invalid solution indices and repeated question identities are rejected', () => {
  const invalid = structuredClone(synthesis);
  invalid.chapters[0].questions[0].correctIndex = 4;
  assert.throws(() => validateSynthesis(invalid, segments), /Invalid question/);
  const duplicate = structuredClone(synthesis);
  duplicate.chapters[0].questions.push(duplicate.chapters[0].questions[0]);
  assert.throws(() => validateSynthesis(duplicate, segments), /Duplicate question/);
});
test('glossary deduplicates normalized terms and preserves the first definition', () => {
  const value = structuredClone(synthesis);
  value.glossary.push({ term: 'NÝQUIST', definition: 'Conflicting text', segmentIds: ['a'] });
  const result = validateSynthesis(value, segments);
  assert.equal(result.glossary.length, 1);
  assert.equal(result.glossary[0].definition, 'Sampling threshold.');
});
test('caption exports retain global timing and make valid separators', () => {
  assert.match(captions(segments), /WEBVTT\n\na\n00:05:00.000 --> 00:05:05.000/);
  assert.match(captions(segments, true), /1\n00:05:00,000 --> 00:05:05,000/);
});
test('review has no mastery inference when there are no attempts', () => {
  assert.deepEqual(reviewSummary([]), {
    count: 0,
    correct: 0,
    percent: null,
    needsPractice: [],
    evidence: 'insufficient',
  });
});
test('alias calculation agrees with synthetic signal cases', () => {
  assert.equal(aliasFrequency(8, 12), 4);
  assert.equal(aliasFrequency(8, 24), 8);
  assert.equal(aliasFrequency(12, 12), 0);
  assert.equal(aliasFrequency(9, 6), 3);
});
test('supported file detection and accent-insensitive search', () => {
  assert.equal(kindFor('Lecture.MP4'), 'video');
  assert.equal(kindFor('slides.pdf'), 'pdf');
  assert.equal(kindFor('run.exe'), null);
  assert.equal(fold('  SESIÓN  '), 'sesion');
});
test('generated artifacts must have resolvable evidence and bounded parameters', () => {
  const valid = {
    ...synthesis,
    artifact: {
      kind: 'signal',
      title: 'Sampling',
      explanation: 'Compare sampling rates',
      segmentIds: ['a'],
      frequency: 8,
      sampling: 12,
      amplitude: 0.8,
    },
  };
  assert.equal(validateSynthesis(valid, segments).artifact?.kind, 'signal');
  assert.throws(() =>
    validateSynthesis({ ...valid, artifact: { ...valid.artifact, frequency: 999 } }, segments),
  );
  assert.throws(
    () =>
      validateSynthesis(
        { ...valid, artifact: { ...valid.artifact, segmentIds: ['missing'] } },
        segments,
      ),
    /Unresolvable artifact/,
  );
});
test('ambiguous short answers are excluded from numeric scores', () => {
  const pending = {
    id: 'pending',
    correct: false,
    pendingReview: true,
    concept: 'Sampling',
  } as Attempt;
  assert.equal(reviewSummary([pending]).percent, null);
  assert.equal(reviewSummary([pending]).count, 0);
  assert.deepEqual(reviewSummary([pending]).needsPractice, []);
});
test('glossary conflicts preserve reviewed definitions and retry does not duplicate proposals', () => {
  const source = { sourceId: 'one', sourceVersion: 1, segmentIds: ['a'] };
  const original = {
    ...mergeConcept(undefined, 'Sampling', 'Measurements per second.', source),
    reviewed: true,
  };
  const nextSource = { sourceId: 'two', sourceVersion: 1, segmentIds: ['b'] };
  const merged = mergeConcept(original, 'Sámpling', 'A different definition.', nextSource);
  assert.equal(merged.definition, original.definition);
  assert.equal(merged.proposals.length, 1);
  assert.equal(merged.sources.length, 2);
  const repeated = mergeConcept(merged, 'sampling', 'A different definition.', nextSource);
  assert.equal(repeated.proposals.length, 1);
  assert.equal(repeated.version, 1);
});
