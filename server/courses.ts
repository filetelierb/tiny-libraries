import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { kindFor, MAX_FILE_BYTES } from '../shared/domain';

/**
 * Downloaded courses stay in their own folders. The companion lists them, reads their files
 * for the library to copy, and keeps the material the library prepared for them beside them,
 * always inside the courses folder.
 */
export class CourseFolderError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** A path inside the folder; anything that would leave it is refused. */
export function inside(root: string, path: string) {
  if (!isAbsolute(root)) throw new CourseFolderError('The folder must be an absolute path');
  const base = resolve(root),
    target = resolve(base, path);
  if (isAbsolute(path) || (target !== base && !target.startsWith(base + sep)))
    throw new CourseFolderError('Path is outside the course folder');
  return target;
}
const hidden = (name: string) => name.startsWith('.');
const exists = async (path: string) => !!(await stat(path).catch(() => null));
const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
};

/** A disk under /Volumes that is not connected would read as an empty folder. */
async function assertMounted(folder: string) {
  const volume = folder.match(/^\/Volumes\/[^/]+/)?.[0];
  if (!volume) return;
  const [disk, system] = await Promise.all([stat(volume).catch(() => null), stat('/')]);
  if (!disk || disk.dev === system.dev)
    throw new CourseFolderError(`${volume} is not mounted. Connect the disk and try again.`, 409);
}

/** Every file of the folder the library can read, with its path inside the folder. */
export async function scan(root: string, limit = 5000) {
  const base = inside(root, '.'),
    files: Array<{ path: string; size: number }> = [];
  const walk = async (folder: string) => {
    const entries = (await readdir(folder, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true }),
    );
    for (const entry of entries) {
      if (hidden(entry.name) || files.length >= limit) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && kindFor(entry.name) && kindFor(entry.name) !== 'artifact') {
        const { size } = await stat(path);
        if (size > 0 && size <= MAX_FILE_BYTES)
          files.push({ path: relative(base, path).split(sep).join('/'), size });
      }
    }
  };
  await walk(base);
  return { files };
}

/** Streams one file of a course. */
async function read(root: string, path: string, res: ServerResponse) {
  const target = inside(root, path);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new CourseFolderError('The file is no longer in the course', 404);
  res.writeHead(200, { 'Content-Length': info.size });
  await pipeline(createReadStream(target), res);
}

/** Where a course keeps the material the library prepared for it, so it can be imported ready. */
export const PACK_FOLDER = '.tailored-library';
export type CourseFolder = {
  path: string;
  title: string;
  files: number;
  videos: number;
  documents: number;
  bytes: number;
  pack: { files: number; locale: string; exportedAt: string } | null;
};

/** A course folder's title, size and prepared pack, if it has one. */
async function describeCourse(path: string): Promise<CourseFolder | null> {
  const { files } = await scan(path);
  if (!files.length) return null;
  const record = await readJson<{ code?: string; title?: string }>(join(path, 'course.json'));
  const pack = await readJson<{ files: unknown[]; locale: string; exportedAt: string }>(
    join(path, PACK_FOLDER, 'manifest.json'),
  );
  const kinds = files.map((file) => kindFor(file.path));
  return {
    path,
    title: record?.title
      ? `${record.code ? `${record.code} – ` : ''}${record.title}`
      : (path.split(sep).pop() || path).replace(/_/g, ' '),
    files: files.length,
    videos: kinds.filter((kind) => kind === 'video' || kind === 'audio').length,
    documents: kinds.filter((kind) => kind === 'pdf' || kind === 'markdown' || kind === 'text')
      .length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
    pack: pack
      ? { files: pack.files.length, locale: pack.locale, exportedAt: pack.exportedAt }
      : null,
  };
}

/**
 * The courses in the courses folder: each sub-folder with readable files, or, for a folder
 * that groups courses by site (`see/…`), each of its courses. A library data folder is skipped.
 */
export async function listCourses(root: string) {
  await assertMounted(root);
  const courses: CourseFolder[] = [];
  const children = async (folder: string) =>
    (await readdir(folder, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory() && !hidden(entry.name))
      .map((entry) => join(folder, entry.name));
  for (const folder of await children(root)) {
    if (await exists(join(folder, 'tailored-library.json'))) continue;
    const marked = async (path: string) =>
      (await exists(join(path, 'course.json'))) || (await exists(join(path, PACK_FOLDER)));
    const inner = await children(folder);
    const grouped = !(await marked(folder)) && (await Promise.all(inner.map(marked))).some(Boolean);
    for (const path of grouped ? inner : [folder]) {
      const course = await describeCourse(path);
      if (course) courses.push(course);
    }
  }
  return { root, courses: courses.sort((a, b) => a.title.localeCompare(b.title)) };
}

/**
 * A prepared pack is written into a folder named for the export, then its manifest names that
 * folder and earlier exports are removed, so an interrupted export leaves the last one intact.
 */
const packed = (root: string, path: string) => inside(inside(root, PACK_FOLDER), path);
async function writePack(root: string, path: string, body: IncomingMessage) {
  const target = packed(root, path);
  await mkdir(dirname(target), { recursive: true });
  try {
    await pipeline(body, createWriteStream(`${target}.part`));
    await rename(`${target}.part`, target);
  } catch (error) {
    await unlink(`${target}.part`).catch(() => {});
    throw error;
  }
  return { path };
}
async function readPack(root: string, path: string, res: ServerResponse) {
  const target = packed(root, path);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new CourseFolderError('Not in the prepared material', 404);
  res.writeHead(200, { 'Content-Length': info.size });
  await pipeline(createReadStream(target), res);
}
export async function commitPack(root: string, manifest: { dir: string }) {
  if (!/^files-[\w-]+$/.test(manifest.dir)) throw new CourseFolderError('Unknown export', 400);
  const folder = inside(root, PACK_FOLDER);
  if (!(await exists(join(folder, manifest.dir))))
    throw new CourseFolderError('The export wrote no files', 400);
  await writeFile(join(folder, 'manifest.json.part'), JSON.stringify(manifest, null, 2));
  await rename(join(folder, 'manifest.json.part'), join(folder, 'manifest.json'));
  for (const entry of await readdir(folder, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name.startsWith('files-') && entry.name !== manifest.dir)
      await rm(join(folder, entry.name), { recursive: true, force: true });
  return { dir: manifest.dir };
}

/** A course is a folder inside the courses folder, never the courses folder itself. */
export function assertCourse(coursesDir: string, root: string) {
  const base = resolve(coursesDir),
    target = resolve(root);
  if (!isAbsolute(root) || !target.startsWith(base + sep))
    throw new CourseFolderError('Choose a course in the courses folder');
}

const query = z.object({ root: z.string().min(1).max(1024), path: z.string().max(1024) });

/**
 * The companion's /courses routes, used by the library through the loopback. Every course is
 * inside `coursesDir`; without one, there are no courses to reach.
 */
export async function courseRoute(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  coursesDir?: string,
) {
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  try {
    if (!coursesDir) throw new CourseFolderError('No courses folder is set', 404);
    if (url.pathname === '/courses/list' && req.method === 'GET')
      return send(await listCourses(coursesDir));
    const { root, path } = query.parse({
      root: url.searchParams.get('root'),
      path: url.searchParams.get('path') ?? '',
    });
    assertCourse(coursesDir, root);
    await assertMounted(root);
    if (url.pathname === '/courses/scan' && req.method === 'GET') return send(await scan(root));
    if (url.pathname === '/courses/file' && req.method === 'GET')
      return await read(root, path, res);
    if (url.pathname === '/courses/pack' && req.method === 'PUT')
      return send(await writePack(root, path, req), 201);
    if (url.pathname === '/courses/pack' && req.method === 'GET')
      return await readPack(root, path, res);
    if (url.pathname === '/courses/pack/commit' && req.method === 'POST') {
      const parts: Buffer[] = [];
      for await (const part of req) parts.push(Buffer.from(part));
      const manifest = z
        .object({ dir: z.string() })
        .passthrough()
        .parse(JSON.parse(Buffer.concat(parts).toString() || '{}'));
      return send(await commitPack(root, manifest));
    }
    send({ error: 'Not found' }, 404);
  } catch (error) {
    if (res.headersSent) return void res.destroy();
    send(
      { error: error instanceof Error ? error.message : 'Course operation failed' },
      error instanceof CourseFolderError ? error.status : error instanceof z.ZodError ? 400 : 500,
    );
  }
}
