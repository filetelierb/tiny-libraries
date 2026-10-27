import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../shared/csv';

test('CSV fields may be quoted, contain separators, quotes and line breaks', () => {
  const { rows, total } = parseCsv(
    '\uFEFFname,note\r\n"Nyquist, H.","said ""twice""\nthe rate"\n\nfs,8\n',
  );
  assert.equal(total, 3);
  assert.deepEqual(rows, [
    ['name', 'note'],
    ['Nyquist, H.', 'said "twice"\nthe rate'],
    ['fs', '8'],
  ]);
});

test('semicolon files are detected and long files are capped but counted', () => {
  const body = ['a;b', ...Array.from({ length: 300 }, (_, i) => `${i};${i * 2}`)].join('\n');
  const { rows, total } = parseCsv(body, 201);
  assert.equal(total, 301);
  assert.equal(rows.length, 201);
  assert.deepEqual(rows[1], ['0', '0']);
});
