import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkSourceAnchors } from '../src/study/sourceAnchors';

test('rendered Markdown blocks preserve source offsets without changing formatted text, code or tables', () => {
  const source =
    '# Sampling intervals\n\nA **bold** paragraph.\n\n```js\nconst rate = 1000;\n```\n\n| Kind | Value |\n| --- | --- |\n| Rate | 1000 |';
  const html = renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: [remarkGfm, remarkSourceAnchors] }, source),
  );
  for (const text of ['# Sampling', 'A **bold**', '```js', '| Kind'])
    assert.ok(html.includes(`data-source-start="${source.indexOf(text)}"`));
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /const rate = 1000;/);
  assert.match(html, /<table/);
  assert.equal((html.match(/Sampling intervals/g) || []).length, 1);
});
