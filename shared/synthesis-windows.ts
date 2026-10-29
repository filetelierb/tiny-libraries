import { z } from 'zod';
import { type Segment, type Synthesis } from './domain';
import { conceptKey } from './glossary';

// Long sources are analysed in overlapping windows. Each window owns the segments from
// `owned` to `end`; the segments from `start` to `owned` repeat the end of the previous
// window so ideas that cross the boundary keep their context.
export type SynthesisWindow = { start: number; owned: number; end: number };

export const WINDOW_CHARS = 200_000;
export const WINDOW_OVERLAP = 2;

const size = (segment: Segment) => JSON.stringify(segment).length + 1;

export function synthesisWindows(
  segments: Segment[],
  maxChars = WINDOW_CHARS,
  overlap = WINDOW_OVERLAP,
): SynthesisWindow[] {
  const windows: SynthesisWindow[] = [];
  let owned = 0;
  while (owned < segments.length) {
    const start = windows.length ? Math.max(0, owned - overlap) : owned;
    let chars = segments.slice(start, owned).reduce((sum, s) => sum + size(s), 0),
      end = owned;
    // A window always takes at least one new segment, even an oversized one.
    while (end < segments.length && (end === owned || chars + size(segments[end]) <= maxChars))
      chars += size(segments[end++]);
    windows.push({ start, owned, end });
    owned = end;
  }
  return windows.length ? windows : [{ start: 0, owned: 0, end: 0 }];
}

// Drops what a window produced only from its repeated context, which the previous
// window already covered.
export function ownedPart(part: Synthesis, segments: Segment[], window: SynthesisWindow) {
  const owned = new Set(segments.slice(window.owned, window.end).map((s) => s.id));
  const chapters = part.chapters.filter((c) => c.segmentIds.some((id) => owned.has(id)));
  return { ...part, chapters: chapters.length ? chapters : part.chapters };
}

export const outlineSchema = z.object({
  title: z.string(),
  chapters: z
    .array(
      z.object({
        title: z.string(),
        summary: z.string(),
        sections: z.array(z.string()).min(1),
      }),
    )
    .min(1)
    .max(12),
});
export type Outline = z.infer<typeof outlineSchema>;

// Section ids name a window's chapter, so the outline can regroup them.
export const sectionId = (part: number, chapter: number) => `part-${part + 1}-${chapter + 1}`;

export function outlineInput(parts: Synthesis[]) {
  return parts.map((part, p) => ({
    part: p + 1,
    title: part.title,
    sections: part.chapters.map((c, i) => ({
      id: sectionId(p, i),
      title: c.title,
      summary: c.summary,
    })),
  }));
}

// Builds one study guide from the windows and the model's regrouping. Every section ends
// up in exactly one chapter, in source order, whatever the outline omits or repeats.
export function mergeParts(parts: Synthesis[], outline: Outline): Synthesis {
  const sections = parts.flatMap((part, p) =>
    part.chapters.map((chapter, i) => ({
      id: sectionId(p, i),
      chapter,
      questions: chapter.questions.map((q) => ({ ...q, id: `p${p + 1}-${q.id}` })),
    })),
  );
  const order = new Map(sections.map((s, i) => [s.id, i]));
  const owner = new Map<string, number>();
  outline.chapters.forEach((chapter, c) => {
    for (const id of chapter.sections) if (order.has(id) && !owner.has(id)) owner.set(id, c);
  });
  // An omitted section joins the chapter of the section before it.
  let previous = 0;
  for (const section of sections) {
    if (!owner.has(section.id)) owner.set(section.id, previous);
    previous = owner.get(section.id)!;
  }
  const chapters = outline.chapters
    .map((chapter, c) => {
      const members = sections.filter((s) => owner.get(s.id) === c);
      // Take questions in turn from each section so a chapter's practice spans all of it.
      const questions: Synthesis['chapters'][number]['questions'] = [];
      for (let round = 0; questions.length < 3; round++) {
        const next = members.map((m) => m.questions[round]).filter(Boolean);
        if (!next.length) break;
        questions.push(...next.slice(0, 3 - questions.length));
      }
      return {
        id: `chapter-${c + 1}`,
        title: chapter.title,
        summary: chapter.summary,
        segmentIds: [...new Set(members.flatMap((m) => m.chapter.segmentIds))],
        questions,
      };
    })
    .filter((chapter) => chapter.segmentIds.length && chapter.questions.length);
  // Terms are taken from each window in turn, so the glossary covers the whole source.
  const terms = new Map<string, Synthesis['glossary'][number]>();
  for (let round = 0; terms.size < 40; round++) {
    const next = parts.map((part) => part.glossary[round]).filter(Boolean);
    if (!next.length) break;
    for (const term of next) {
      const key = conceptKey(term.term),
        existing = terms.get(key);
      if (existing)
        existing.segmentIds = [...new Set([...existing.segmentIds, ...term.segmentIds])];
      else if (terms.size < 40) terms.set(key, { ...term });
    }
  }
  return {
    title: outline.title,
    chapters: chapters.map((chapter, i) => ({ ...chapter, id: `chapter-${i + 1}` })),
    glossary: [...terms.values()],
    artifact: parts.find((part) => part.artifact)?.artifact ?? null,
  };
}
