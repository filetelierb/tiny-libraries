import {
  pad,
  safeName,
  text,
  type Course,
  type CourseFile,
  type CourseSource,
  type CourseSummary,
  type Lecture,
} from './source';

/** Stanford Engineering Everywhere: recorded Stanford engineering courses with their materials. */
const HOST = 'https://see.stanford.edu';
export const SEE_LICENSE = {
  name: 'CC BY-NC-SA 4.0',
  url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  notice:
    'Unless otherwise indicated, SEE content is licensed under Creative Commons Attribution-NonCommercial-ShareAlike 4.0 (see https://see.stanford.edu/UsingSEE). Check individual items for different notices.',
};
// Sections of a course page that describe the course rather than offer files.
const DESCRIPTIVE = new Set(['course description', 'instructor']);

/** The courses on the catalog page. Courses hosted elsewhere, under other terms, are left out. */
export function parseSeeCatalog(html: string): CourseSummary[] {
  const seen = new Map<string, CourseSummary>();
  // A course can be linked more than once, sometimes around an image; the named link counts.
  for (const [, code, label] of html.matchAll(/href="\/Course\/([A-Za-z0-9]+)"[^>]*>([^<]*)</g)) {
    const title = text(label ?? '');
    if (code && title && !seen.has(code))
      seen.set(code, { code, title, url: `${HOST}/Course/${code}` });
  }
  return [...seen.values()];
}

/** A course page: each section is a panel headed by an h2 (Handouts, Assignments, Lecture 1…). */
export function parseSeeCourse(html: string, code: string): Course {
  const panels = html
    .split(/<div class="panel panel-collapsable">/)
    .slice(1)
    .map((chunk) => ({
      title: text(chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)?.[1] || ''),
      body: chunk,
    }));
  const lectures: Lecture[] = [],
    files: CourseFile[] = [],
    names = new Set<string>();
  const add = (file: Omit<CourseFile, 'url'> & { href: string }) => {
    const { href, ...rest } = file;
    const url = new URL(href, HOST);
    // Only the site's own files; links to other sites keep their own terms.
    if (url.origin !== HOST || url.pathname.startsWith('/Course/')) return;
    const extension = url.pathname.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase() || '';
    // A label that is already the file name keeps a single extension.
    const base = safeName(
      extension && rest.name.toLowerCase().endsWith(extension)
        ? rest.name.slice(0, -extension.length)
        : rest.name,
    );
    let name = `${base}${extension}`;
    for (let n = 2; names.has(`${rest.folder}/${name}`); n++) name = `${base} (${n})${extension}`;
    names.add(`${rest.folder}/${name}`);
    if (!files.some((item) => item.url === url.href)) files.push({ ...rest, name, url: url.href });
  };
  for (const { title, body } of panels) {
    const lecture = title.match(/^Lecture (\d+)$/i);
    if (lecture) {
      const number = Number(lecture[1]),
        label = `Lecture ${pad(number)}`,
        folder = `Lectures/${label}`;
      const duration = body.match(/>\s*((?:\d+\s*h(?:ou)?rs?\s*)?\d+\s*min)\s*</i)?.[1];
      const topics = body.match(/<strong>Topics:<\/strong>([\s\S]*?)<\/td>/i)?.[1];
      lectures.push({
        number,
        ...(duration ? { duration: text(duration) } : {}),
        ...(topics ? { topics: text(topics) } : {}),
      });
      const video = body.match(/href="([^"]+\.mp4)"/i)?.[1];
      if (video) add({ href: video, folder, name: label, role: 'video', lecture: number });
      const transcript = body.match(/href="([^"]+\.pdf)"/i)?.[1];
      if (transcript)
        add({
          href: transcript,
          folder,
          name: `${label} transcript`,
          role: 'transcript',
          lecture: number,
        });
      continue;
    }
    if (!title || DESCRIPTIVE.has(title.toLowerCase()) || /^course sessions/i.test(title)) continue;
    const folder = safeName(title);
    // A table row names its files with its first cell: "Problem Set 1" + "Questions".
    const rows = body.match(/<tr[\s\S]*?<\/tr>/gi) || [body];
    for (const row of rows) {
      const cells = row.match(/<td[\s\S]*?<\/td>/gi) || [];
      const first = cells[0] ?? '';
      const heading = cells.length > 1 && !/<a\s/i.test(first) ? text(first) : '';
      for (const [, href, label] of row.matchAll(
        /<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi,
      )) {
        const name = text(label) || href.split('/').pop()!;
        add({
          href,
          folder,
          name: heading && heading !== name ? `${heading} – ${name}` : name,
          role: 'material',
        });
      }
    }
  }
  const description = panels.find((panel) => panel.title.toLowerCase() === 'course description');
  const instructor = panels.find((panel) => panel.title.toLowerCase() === 'instructor');
  return {
    source: 'see',
    code,
    // The page repeats the site's name in its heading; the catalog gives the course title.
    title: code,
    url: `${HOST}/Course/${code}`,
    ...(description
      ? { description: text(description.body.replace(/<h2[\s\S]*?<\/h2>/, '')).slice(0, 1200) }
      : {}),
    ...(instructor
      ? { instructor: text(instructor.body.match(/<img[^>]*>\s*<p>([\s\S]*?)<\/p>/)?.[1] || '') }
      : {}),
    license: SEE_LICENSE,
    lectures: lectures.sort((a, b) => a.number - b.number),
    files,
  };
}

async function page(path: string) {
  const response = await fetch(`${HOST}${path}`);
  if (!response.ok) throw new Error(`${HOST}${path} answered ${response.status}`);
  return response.text();
}

export const see: CourseSource = {
  id: 'see',
  name: 'Stanford Engineering Everywhere',
  catalog: async () => parseSeeCatalog(await page('/Course')),
  course: async (code) => {
    const known = parseSeeCatalog(await page('/Course')).find(
      (item) => item.code.toLowerCase() === code.toLowerCase(),
    );
    if (!known) throw new Error(`SEE has no course ${code}; run "npm run courses -- list see".`);
    const course = parseSeeCourse(await page(`/Course/${known.code}`), known.code);
    return { ...course, title: known.title };
  },
};
