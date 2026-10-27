import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findQuote } from '../src/annotations/highlights';

test('saved quotes are found across differently broken whitespace', () => {
  const text = 'Sampling and signals\nA continuous   signal can be\nrepresented with samples.';
  const found = findQuote(text, 'A continuous signal can be represented');
  assert.ok(found);
  assert.equal(text.slice(found[0], found[1]), 'A continuous   signal can be\nrepresented');
  assert.deepEqual(findQuote(text, '  signals  '), [13, 20]);
  assert.equal(findQuote(text, 'missing words'), null);
  assert.equal(findQuote(text, '   '), null);
});
