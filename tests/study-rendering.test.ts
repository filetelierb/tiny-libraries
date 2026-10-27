import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkSourceAnchors } from '../src/study/sourceAnchors';
import { StudyMarkdown } from '../src/study/StudyMarkdown';
import { dictionaries } from '../src/i18n';
import { renderFormula, MAX_FORMULA_LENGTH } from '../src/study/math';
import { diagramSourceAllowed, MAX_DIAGRAM_LENGTH } from '../src/study/diagrams';
import { MarkdownManager } from '@tiptap/markdown';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { InlineMath, BlockMath } from '../src/annotations/mathNodes';
import { richDocumentSchema } from '../shared/annotations';
import { RichContent } from '../src/annotations/RichContent';
import { remarkTutorCitations } from '../src/tutor/citations';

const t = dictionaries.en;
const study = (source: string) =>
  renderToStaticMarkup(
    createElement(StudyMarkdown, { t, remarkPlugins: [remarkSourceAnchors] }, source),
  );

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

test('formulas, code, tables and diagrams retain original source anchors', () => {
  const source = String.raw`# Formulas

Inline $f_s > 2 f_{max}$ and \(x_1^2 + x_2^2\).

$$
\frac{1}{T} = f_s
$$

\[
\sum_{n=0}^{N-1} x_n
\]

\`\`\`mermaid
flowchart LR
  A[Sample] --> B[Reconstruct]
\`\`\`

| Rate | Meaning |
| --- | --- |
| $f_s$ | Samples per second |
`.replaceAll('\\`', '`');
  const html = study(source);
  assert.equal((html.match(/class="katex"/g) || []).length, 5);
  assert.equal((html.match(/<math /g) || []).length, 5);
  assert.match(html, /class="study-diagram"/);
  assert.match(html, /role="region" aria-label="Study table"/);
  for (const text of ['# Formulas', 'Inline $', '$$\n', '\\[\n', '```mermaid', '| Rate'])
    assert.ok(html.includes(`data-source-start="${source.indexOf(text)}"`), text);
  assert.match(html, /flowchart LR/);
});

test('escaped delimiters, literal code, HTML and invalid math stay readable', () => {
  const html = study(
    String.raw`Cost \$5. Literal \`$x$\`.

\`\`\`js
const price = '$5'; // \(literal\)
\`\`\`

Bad $\frac{$. Unclosed \(z. <script>alert(1)</script>`.replaceAll('\\`', '`'),
  );
  assert.match(html, /Cost \$5/);
  assert.match(html, /<code>\$x\$<\/code>/);
  assert.match(html, /class="language-js"/);
  assert.match(html, /class="formula-source"/);
  assert.match(html, /Unclosed/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /class="katex"/);
});

test('formula rendering bounds expansion and dimensions and never trusts external HTML', () => {
  assert.equal(renderFormula('x'.repeat(MAX_FORMULA_LENGTH + 1)), null);
  assert.equal(renderFormula(String.raw`\def\a{\a}\a`), null);
  assert.equal(renderFormula(String.raw`\frac{`), null);
  const html = renderFormula(String.raw`\href{https://example.test}{x}`) || '';
  assert.doesNotMatch(html, /<a\b|href="https:|<script|<img/);
  assert.ok(renderFormula(String.raw`\frac{1}{T}`)?.includes('<math'));
  renderFormula(String.raw`\gdef\privateMacro{x}\privateMacro`);
  assert.equal(renderFormula(String.raw`\privateMacro`), null);
});

test('diagrams reject external resources, configuration and excess input before rendering', () => {
  assert.equal(diagramSourceAllowed('flowchart LR\n A-->B'), true);
  for (const source of [
    '',
    'x'.repeat(MAX_DIAGRAM_LENGTH + 1),
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B',
    '---\nconfig:\n theme: dark\n---\nflowchart LR\nA-->B',
    'flowchart LR\n A@{img: "https://example.test/pixel"}',
    'flowchart LR\n A-->B\nclick A "https://example.test"',
    'flowchart LR\n A-->B\nclassDef a fill:url(//example.test/x)',
  ])
    assert.equal(diagramSourceAllowed(source), false);
});

test('saved annotations preserve formulas and fenced diagrams through Markdown editing', () => {
  const manager = new MarkdownManager({
    extensions: [StarterKit, TableKit, InlineMath, BlockMath],
  });
  const source =
    'Inline $x_1^2$ and \\(f_s\\).\n\n$$\n\\frac{1}{T}\n$$\n\n```mermaid\nflowchart LR\n A-->B\n```';
  const document = richDocumentSchema.parse(manager.parse(source));
  const serialized = manager.serialize(document);
  const reopened = richDocumentSchema.parse(manager.parse(serialized));
  const getMath = (value: typeof document): string[] => [
    ...(['inlineMath', 'blockMath'].includes(value.type) ? [value.attrs!.latex!] : []),
    ...(value.content || []).flatMap(getMath),
  ];
  assert.deepEqual(getMath(document), ['x_1^2', 'f_s', String.raw`\frac{1}{T}`]);
  assert.deepEqual(getMath(reopened), getMath(document));
  assert.match(serialized, /```mermaid\nflowchart LR\n A-->B\n```/);
  const html = renderToStaticMarkup(createElement(RichContent, { document: reopened, t }));
  assert.equal((html.match(/class="katex"/g) || []).length, 3);
  assert.match(html, /class="study-diagram"/);
});

test('study formulas retain tutor citation identities without interpreting math brackets', () => {
  const reference = {
    id: 'section-1',
    sourceId: 'source-id',
    sourceName: 'Sampling',
    kind: 'source' as const,
    sourceVersion: 1,
    segmentId: 'section-1',
    quote: 'Sampling',
    label: 'Sampling',
  };
  const html = renderToStaticMarkup(
    createElement(
      StudyMarkdown,
      {
        t,
        remarkPlugins: [[remarkTutorCitations, { references: [reference] }]],
      },
      '$x[section-1]$ then evidence [section-1].',
    ),
  );
  assert.equal((html.match(/href="#tutor\/section-1"/g) || []).length, 1);
  assert.match(html, /class="katex"/);
});
