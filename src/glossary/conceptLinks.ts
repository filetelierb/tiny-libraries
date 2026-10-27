import type { Plugin } from 'unified';

export type LinkableConcept = {
  id: string;
  term: string;
  aliases?: string[];
  archived?: boolean;
  mergedInto?: string;
};
type MdNode = {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
};
// Labels longer than this keep plain text and get a separate glossary chip instead.
export const CONCEPT_LINK_MAX = 40;
const skipped = new Set([
  'code',
  'inlineCode',
  'link',
  'linkReference',
  'heading',
  'math',
  'inlineMath',
]);

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Matches whole-word glossary terms and aliases, preferring the longest overlapping term. */
export function conceptMatcher(concepts: LinkableConcept[]) {
  const byName = new Map<string, string>();
  for (const concept of concepts)
    if (!concept.archived && !concept.mergedInto)
      for (const name of [concept.term, ...(concept.aliases || [])])
        if (name.trim().length > 1 && !byName.has(name.trim().toLocaleLowerCase()))
          byName.set(name.trim().toLocaleLowerCase(), concept.id);
  if (!byName.size) return null;
  const names = [...byName.keys()].sort((a, b) => b.length - a.length).map(escape);
  return {
    pattern: new RegExp(`(?<![\\p{L}\\p{N}])(?:${names.join('|')})(?![\\p{L}\\p{N}])`, 'giu'),
    idFor: (text: string) => byName.get(text.toLocaleLowerCase()),
  };
}

/** Links the first mention of each glossary concept in prose; headings and code stay plain. */
export const remarkConceptLinks: Plugin<[LinkableConcept[]], MdNode> = (concepts) => (tree) => {
  const matcher = conceptMatcher(concepts);
  if (!matcher) return;
  const linked = new Set<string>();
  const split = (text: string): MdNode[] => {
    const parts: MdNode[] = [];
    let last = 0;
    for (const match of text.matchAll(matcher.pattern)) {
      const id = matcher.idFor(match[0]);
      if (!id || linked.has(id)) continue;
      linked.add(id);
      if (match.index > last) parts.push({ type: 'text', value: text.slice(last, match.index) });
      parts.push({
        type: 'conceptLink',
        children: [{ type: 'text', value: match[0] }],
        data: {
          hName: 'button',
          hProperties: { type: 'button', className: ['artifact-concept'], dataConcept: id },
        },
      });
      last = match.index + match[0].length;
    }
    if (!parts.length) return [{ type: 'text', value: text }];
    if (last < text.length) parts.push({ type: 'text', value: text.slice(last) });
    return parts;
  };
  const walk = (node: MdNode) => {
    if (skipped.has(node.type) || !node.children) return;
    node.children = node.children.flatMap((child) =>
      child.type === 'text' ? split(child.value || '') : (walk(child), [child]),
    );
  };
  walk(tree);
};
