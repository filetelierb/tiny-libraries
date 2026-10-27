import { Node, mergeAttributes } from '@tiptap/core';
import { renderFormula } from '../study/math';

export const InlineMath = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes: () => ({ latex: { default: '' } }),
  parseHTML: () => [{ tag: 'span[data-study-math="inline"]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    'span',
    mergeAttributes(HTMLAttributes, { 'data-study-math': 'inline' }),
    node.attrs.latex,
  ],
  addNodeView:
    () =>
    ({ node }) => {
      const dom = document.createElement('span');
      dom.className = 'study-formula';
      const html = renderFormula(node.attrs.latex);
      if (html) dom.innerHTML = html;
      else dom.textContent = node.attrs.latex;
      return { dom };
    },
  markdownTokenizer: {
    name: 'inlineMath',
    level: 'inline',
    start: (source) => source.search(/\$|\\\(/),
    tokenize(source) {
      const match = source.match(/^(?:\$(?!\$)((?:\\.|[^$\n])+?)\$(?!\$)|\\\(([\s\S]+?)\\\))/);
      if (!match) return undefined;
      return { type: 'inlineMath', raw: match[0], text: match[1] ?? match[2] };
    },
  },
  parseMarkdown: (token) => ({ type: 'inlineMath', attrs: { latex: token.text || '' } }),
  renderMarkdown: (node) => `\\(${node.attrs?.latex || ''}\\)`,
});

export const BlockMath = Node.create({
  name: 'blockMath',
  group: 'block',
  atom: true,
  addAttributes: () => ({ latex: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-study-math="block"]' }],
  renderHTML: ({ node, HTMLAttributes }) => [
    'div',
    mergeAttributes(HTMLAttributes, { 'data-study-math': 'block' }),
    node.attrs.latex,
  ],
  addNodeView:
    () =>
    ({ node }) => {
      const dom = document.createElement('div');
      dom.className = 'study-formula study-formula-display';
      const html = renderFormula(node.attrs.latex, true);
      if (html) dom.innerHTML = html;
      else dom.textContent = node.attrs.latex;
      return { dom };
    },
  markdownTokenizer: {
    name: 'blockMath',
    level: 'block',
    start: (source) => source.search(/\$\$|\\\[/),
    tokenize(source) {
      const match = source.match(/^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:[ \t]*\n|$)/);
      if (!match) return undefined;
      return { type: 'blockMath', raw: match[0], text: (match[1] ?? match[2]).trim() };
    },
  },
  parseMarkdown: (token) => ({ type: 'blockMath', attrs: { latex: token.text || '' } }),
  renderMarkdown: (node) => `$$\n${node.attrs?.latex || ''}\n$$`,
});
