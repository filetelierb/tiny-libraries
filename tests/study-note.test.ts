import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTutorAnswer, visibleTutorText } from '../shared/study-note';

test('streamed metadata stays hidden, including a partially received marker', () => {
  assert.equal(visibleTutorText('Answer text\n<study_no'), 'Answer text');
  assert.equal(visibleTutorText('Answer text <study_note>{"recom'), 'Answer text');
  assert.equal(visibleTutorText('A < B holds'), 'A < B holds');
});

test('a finished reply yields its answer and a validated suggestion', () => {
  const parsed = parseTutorAnswer(
    'Aliasing folds frequencies [s1].\n<study_note>{"recommended":true,"category":"summary","body":"Aliasing folds frequencies [s1]."}</study_note>',
  );
  assert.equal(parsed.answer, 'Aliasing folds frequencies [s1].');
  assert.deepEqual(parsed.suggestion, {
    recommended: true,
    category: 'summary',
    body: 'Aliasing folds frequencies [s1].',
  });
  assert.deepEqual(parseTutorAnswer('Hi!<study_note>{"recommended":false}</study_note>'), {
    answer: 'Hi!',
    suggestion: { recommended: false },
  });
});

test('malformed or unknown suggestions never discard the answer', () => {
  assert.deepEqual(parseTutorAnswer('Kept.<study_note>{not json</study_note>'), {
    answer: 'Kept.',
  });
  assert.deepEqual(
    parseTutorAnswer(
      'Kept.<study_note>{"recommended":true,"category":"poem","body":"x"}</study_note>',
    ),
    { answer: 'Kept.' },
  );
  assert.deepEqual(parseTutorAnswer('Plain answer.'), { answer: 'Plain answer.' });
});
