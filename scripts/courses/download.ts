import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Course, CourseFile } from './source';
import { safeName } from './source';

/** What a downloaded course folder records about itself; the import reads it. */
export type CourseManifest = {
  source: string;
  code: string;
  title: string;
  url: string;
  license: Course['license'];
  instructor?: string;
  downloadedAt: string;
  lectures: Course['lectures'];
  files: Array<CourseFile & { path: string; size: number }>;
};
export const MANIFEST = 'course.json';

export const courseFolderName = (course: Pick<Course, 'code' | 'title'>) =>
  safeName(`${course.code} – ${course.title}`);
export const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
      : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The size a server reports for a file, or null when it does not say. */
export async function remoteSize(url: string) {
  const response = await fetch(url, { method: 'HEAD' });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const length = Number(response.headers.get('content-length'));
  return Number.isSafeInteger(length) && length > 0 ? length : null;
}

/** Sizes for many files, a few requests at a time. */
export async function remoteSizes(urls: string[], parallel = 6) {
  const sizes = new Map<string, number | null>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, urls.length) }, async () => {
      while (next < urls.length) {
        const url = urls[next++];
        sizes.set(url, await remoteSize(url).catch(() => null));
      }
    }),
  );
  return sizes;
}

/**
 * Downloads a file, resuming a partial copy left by an interrupted run. A complete file of the
 * expected size is kept as it is.
 */
export async function downloadFile(
  url: string,
  path: string,
  progress: (done: number, total: number | null) => void,
) {
  const total = await remoteSize(url);
  const existing = await stat(path).catch(() => null);
  if (existing && (total === null || existing.size === total)) return 'kept' as const;
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.part`;
  for (let attempt = 1; ; attempt++) {
    const start = (await stat(partial).catch(() => null))?.size || 0;
    try {
      const response = await fetch(url, {
        headers: start ? { Range: `bytes=${start}-` } : {},
      });
      if (response.status === 416 && total !== null && start === total) break;
      if (!response.ok || !response.body) throw new Error(`${url} answered ${response.status}`);
      // A server that ignores the range sends the whole file again.
      const resumed = response.status === 206;
      let done = resumed ? start : 0;
      const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
      body.on('data', (chunk: Buffer) => {
        done += chunk.length;
        progress(done, total);
      });
      await pipeline(body, createWriteStream(partial, { flags: resumed ? 'a' : 'w' }));
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
    }
  }
  const size = (await stat(partial)).size;
  if (total !== null && size !== total)
    throw new Error(`${url}: received ${size} of ${total} bytes; run the download again.`);
  await rename(partial, path);
  return 'downloaded' as const;
}

export async function readManifest(folder: string): Promise<CourseManifest | null> {
  try {
    return JSON.parse(await readFile(join(folder, MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

/** Keeps what earlier downloads of the course recorded and adds the files just completed. */
export async function writeManifest(
  folder: string,
  course: Course,
  files: CourseManifest['files'],
) {
  const previous = (await readManifest(folder))?.files || [];
  const merged = new Map(previous.map((file) => [file.url, file]));
  for (const file of files) merged.set(file.url, file);
  const manifest: CourseManifest = {
    source: course.source,
    code: course.code,
    title: course.title,
    url: course.url,
    license: course.license,
    ...(course.instructor ? { instructor: course.instructor } : {}),
    downloadedAt: new Date().toISOString(),
    lectures: course.lectures,
    files: [...merged.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
  await writeFile(join(folder, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(folder, 'SOURCE.md'), sourceNotice(manifest));
}

/** Where the material comes from and the terms it is shared under, kept with the files. */
export function sourceNotice(course: CourseManifest) {
  return `# ${course.code} – ${course.title}

- Source: ${course.url}
${course.instructor ? `- Instructor: ${course.instructor}\n` : ''}- License: ${course.license.name} (${course.license.url})
- Downloaded: ${course.downloadedAt.slice(0, 10)}

${course.license.notice}

Attribute the course and its source when you show or share this material.
`;
}
