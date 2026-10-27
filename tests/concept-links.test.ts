import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conceptMatcher, remarkConceptLinks } from '../src/glossary/conceptLinks';

const concepts = [
  { id: 'alias', term: 'aliasing' },
  { id: 'rate', term: 'sampling rate', aliases: ['sampling frequency'] },
  { id: 'gone', term: 'signal', archived: true },
];
type Node = {
  type: string;
  value?: string;
  children?: Node[];
  data?: { hProperties?: { dataConcept?: string } };
};
const run = (children: Node[]) => {
  const tree: Node = { type: 'root', children };
  (remarkConceptLinks as unknown as (c: typeof concepts) => (tree: Node) => void)(concepts)(tree);
  return tree;
};

test('terms and aliases match whole words, case-insensitively, longest first', () => {
  const matcher = conceptMatcher(concepts)!;
  const found = [
    ...'Sampling Frequency and Aliasing, not dealiasing or signal'.matchAll(matcher.pattern),
  ].map((match) => [match[0], matcher.idFor(match[0])]);
  assert.deepEqual(found, [
    ['Sampling Frequency', 'rate'],
    ['Aliasing', 'alias'],
  ]);
  assert.equal(conceptMatcher([]), null);
});

test('the first mention in prose becomes a glossary link and headings stay plain', () => {
  const tree = run([
    { type: 'heading', children: [{ type: 'text', value: 'Aliasing' }] },
    {
      type: 'paragraph',
      children: [
        { type: 'text', value: 'Aliasing appears below the sampling rate; aliasing again.' },
      ],
    },
    { type: 'paragraph', children: [{ type: 'inlineCode', value: 'aliasing' }] },
  ]);
  assert.equal(tree.children![0].children![0].type, 'text');
  const paragraph = tree.children![1].children!;
  assert.deepEqual(
    paragraph.map((node) =>
      node.type === 'conceptLink'
        ? `[${node.children![0].value}→${node.data!.hProperties!.dataConcept}]`
        : node.value,
    ),
    ['[Aliasing→alias]', ' appears below the ', '[sampling rate→rate]', '; aliasing again.'],
  );
  assert.equal(tree.children![2].children![0].type, 'inlineCode');
});
