import type { TutorCitation } from '../../shared/tutor-context';
type Node = { type: string; value?: string; url?: string; children?: Node[] };
export function citationFromHref(href: string | undefined, references: Map<string, TutorCitation>) {
  const match = href?.match(/^#tutor\/(.+)$/);
  if (!match) return undefined;
  try {
    return references.get(decodeURIComponent(match[1]));
  } catch {
    return undefined;
  }
}
/** Files the tutor wrote in its own sandbox are not library resources and cannot be opened. */
export function isTemporaryFileHref(href: string) {
  let path = href.replace(/^sandbox:/i, '');
  if (/^file:/i.test(path)) return true;
  try {
    path = decodeURIComponent(path);
  } catch {
    return false;
  }
  return /^\/?(?:workspace|mnt\/data)(?:\/|$)/i.test(path);
}
export const temporaryFileHref = '#temporary-file';
export function remarkTutorCitations(options: {
  references: TutorCitation[];
  label?: (reference: TutorCitation) => string;
}) {
  const byId = new Map(options.references.map((ref) => [ref.id, ref]));
  return (root: unknown) => {
    const walk = (node: Node) => {
      if (
        !node.children ||
        ['link', 'linkReference', 'code', 'inlineCode', 'html', 'image'].includes(node.type)
      )
        return;
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || !child.value) {
          walk(child);
          return [child];
        }
        const value = child.value,
          parts: Node[] = [];
        let last = 0;
        for (const match of value.matchAll(/(?<![\\!])\[([\w:.-]+)\]/g)) {
          const ref = byId.get(match[1]);
          if (!ref) continue;
          if (match.index! > last)
            parts.push({ type: 'text', value: value.slice(last, match.index) });
          parts.push({
            type: 'link',
            url: `#tutor/${encodeURIComponent(ref.id)}`,
            children: [{ type: 'text', value: options.label?.(ref) || match[1] }],
          });
          last = match.index! + match[0].length;
        }
        if (!last) return [child];
        if (last < value.length) parts.push({ type: 'text', value: value.slice(last) });
        return parts;
      });
    };
    walk(root as Node);
  };
}
