/** A course listed by an open courseware site. */
export type CourseSummary = { code: string; title: string; url: string };
/** A file of a course, placed in the course's folder structure. */
export type CourseFile = {
  url: string;
  /** Folder inside the course, such as `Lectures/Lecture 01`. */
  folder: string;
  name: string;
  role: 'video' | 'transcript' | 'material';
  lecture?: number;
};
export type Lecture = { number: number; duration?: string; topics?: string };
export type Course = CourseSummary & {
  source: string;
  instructor?: string;
  description?: string;
  license: { name: string; url: string; notice: string };
  lectures: Lecture[];
  files: CourseFile[];
};
/** A site whose courses can be listed and downloaded, with the license its material uses. */
export type CourseSource = {
  id: string;
  name: string;
  catalog: () => Promise<CourseSummary[]>;
  course: (code: string) => Promise<Course>;
};

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
};
/** Plain text of an HTML fragment. */
export function text(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) =>
      code[0] === '#'
        ? String.fromCodePoint(
            code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)),
          )
        : (entities[code.toLowerCase()] ?? match),
    )
    .replace(/\s+/g, ' ')
    .trim();
}
/** A name that is safe as a file or folder name on every common disk format. */
export function safeName(value: string) {
  return (
    value
      .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s]+|[.\s]+$/g, '')
      .slice(0, 120) || 'file'
  );
}
export const pad = (n: number) => String(n).padStart(2, '0');

/** Lecture numbers from "1-3,7", "all" or "none". */
export function lectureSelection(value: string | undefined, available: number[]) {
  if (!value || value === 'none') return new Set<number>();
  if (value === 'all') return new Set(available);
  const chosen = new Set<number>();
  for (const part of value.split(',')) {
    const [from, to = from] = part.split('-').map(Number);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to)
      throw new Error(`Read --lectures as 1-3, 1,4,7 or all: ${value}`);
    for (let n = from; n <= to; n++) if (available.includes(n)) chosen.add(n);
  }
  return chosen;
}
