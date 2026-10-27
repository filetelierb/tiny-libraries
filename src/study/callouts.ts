import type { Plugin } from 'unified';

export const calloutVariants = ['key', 'warning', 'example', 'analogy', 'definition'] as const;
export type CalloutVariant = (typeof calloutVariants)[number];
const marker = new RegExp(`^\\[!(${calloutVariants.join('|')})\\][ \\t]*\\n?`);

type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};

/** Splits a leading `[!variant]` marker off text, as written by the artifact editor. */
export function calloutMarker(text: string): { variant: CalloutVariant; rest: string } | null {
  const match = text.match(marker);
  return match ? { variant: match[1] as CalloutVariant, rest: text.slice(match[0].length) } : null;
}

/** Turns `> [!key]` blockquotes into callout asides; other blockquotes are untouched. */
export const remarkCallouts: Plugin<[], MdNode> = () => (tree) => {
  const walk = (node: MdNode) => {
    for (const child of node.children || []) walk(child);
    if (node.type !== 'blockquote') return;
    const paragraph = node.children?.[0],
      text = paragraph?.type === 'paragraph' ? paragraph.children?.[0] : undefined;
    const found = text?.type === 'text' && calloutMarker(text.value || '');
    if (!found) return;
    text!.value = found.rest;
    if (!found.rest && paragraph!.children!.length === 1) node.children!.shift();
    node.data = {
      hName: 'aside',
      hProperties: { className: ['study-callout', found.variant], dataCallout: found.variant },
    };
  };
  walk(tree);
};

/**
 * The editor escapes square brackets in text, but `\[ … \]` is display math to the reader,
 * so brackets are written back plain; formulas are serialized with other delimiters.
 */
export function editorMarkdown(markdown: string) {
  return markdown.replace(/\\([[\]])/g, '$1').trim();
}
