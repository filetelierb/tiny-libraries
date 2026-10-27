import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calloutMarker, editorMarkdown, remarkCallouts } from '../src/study/callouts';

test('a leading [!variant] line marks a callout', () => {
  assert.deepEqual(calloutMarker('[!key]\nRemember the Nyquist rate.'), {
    variant: 'key',
    rest: 'Remember the Nyquist rate.',
  });
  assert.deepEqual(calloutMarker('[!warning] Inline'), { variant: 'warning', rest: 'Inline' });
  assert.equal(calloutMarker('[!poem] nope'), null);
  assert.equal(calloutMarker('Plain [!key] later'), null);
});

test('callout blockquotes become labelled asides and plain quotes stay quotes', () => {
  const callout = {
    type: 'blockquote',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: '[!example]\nAt 12 Hz.' }] }],
  };
  const quote = {
    type: 'blockquote',
    children: [{ type: 'paragraph', children: [{ type: 'text', value: 'Just a quote.' }] }],
  };
  const tree = { type: 'root', children: [callout, quote] };
  (remarkCallouts as unknown as () => (tree: unknown) => void)()(tree);
  assert.equal((callout as { data?: { hName: string } }).data?.hName, 'aside');
  assert.equal(callout.children[0].children[0].value, 'At 12 Hz.');
  assert.equal((quote as { data?: unknown }).data, undefined);
});

test('editor markdown keeps citation brackets plain so they never read as display math', () => {
  assert.equal(
    editorMarkdown('> [!key]\n> Aliasing \\[section-1\\] folds frequencies.\n'),
    '> [!key]\n> Aliasing [section-1] folds frequencies.',
  );
});
