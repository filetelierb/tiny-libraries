import { useEffect, useState } from 'react';
import type { Source } from '../../shared/domain';
import type { AnnotationSummary } from '../../shared/annotations';
import { listAnnotations } from './api';

const HIGHLIGHT_NAME = 'tl-saved-highlight';
const painted = new Map<string, Range[]>();

/**
 * Finds a quote in text, ignoring differences in whitespace, since a selection's text and the
 * rendered text nodes break lines differently. Returns offsets into the original text.
 */
export function findQuote(text: string, quote: string): [number, number] | null {
  const wanted = quote.replace(/\s+/g, ' ').trim();
  if (!wanted) return null;
  let collapsed = '';
  const offsets: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const space = /\s/.test(text[index]);
    if (space && (collapsed.endsWith(' ') || !collapsed)) continue;
    collapsed += space ? ' ' : text[index];
    offsets.push(index);
  }
  const start = collapsed.indexOf(wanted);
  if (start < 0) return null;
  return [offsets[start], offsets[start + wanted.length - 1] + 1];
}

/** Builds DOM ranges for every quote found under a root's text nodes. */
export function quoteRanges(root: Node, quotes: string[]): Range[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  const text = nodes.map((node) => node.data).join('');
  const locate = (offset: number, end: boolean) => {
    let consumed = 0;
    for (const node of nodes) {
      if (offset < consumed + node.data.length || (end && offset === consumed + node.data.length))
        return { node, offset: offset - consumed };
      consumed += node.data.length;
    }
    return null;
  };
  const ranges: Range[] = [];
  for (const quote of quotes) {
    const found = findQuote(text, quote);
    if (!found) continue;
    const start = locate(found[0], false),
      end = locate(found[1], true);
    if (!start || !end) continue;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    ranges.push(range);
  }
  return ranges;
}

/** Paints one group of ranges; every group shares a single named CSS highlight. */
export function paintHighlights(key: string, ranges: Range[]) {
  if (ranges.length) painted.set(key, ranges);
  else painted.delete(key);
  if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
  CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...[...painted.values()].flat()));
}

/** Saved annotations on this source that quote its text, for drawing them back. */
export function useSavedQuotes(sessionId: string, source: Source, tick: number) {
  const [items, setItems] = useState<AnnotationSummary[]>([]);
  useEffect(() => {
    let live = true;
    listAnnotations(sessionId, source.id)
      .then((values) => {
        if (live)
          setItems(
            values.filter(
              (item) =>
                !item.deleted && !!item.location.quote && item.sourceVersion === source.version,
            ),
          );
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sessionId, source.id, source.version, tick]);
  return items;
}
