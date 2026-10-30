import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { kindFor, MAX_FILE_BYTES } from '../shared/domain';

/**
 * A project's files can live as ordinary files in a folder of its own, such as one on an
 * external disk. The companion reads and writes them there for the library, always inside
 * that folder.
 */
export class DiskFolderError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/**
 * A folder on a volume under /Volumes must be on a mounted disk: with the disk away, macOS
 * would let the folder be created on the internal disk.
 */
export async function assertVolumeMounted(folder: string) {
  const volume = folder.match(/^\/Volumes\/[^/]+/)?.[0];
  if (!volume) return;
  const [disk, system] = await Promise.all([stat(volume).catch(() => null), stat('/')]);
  if (!disk || disk.dev === system.dev)
    throw new DiskFolderError(`${volume} is not mounted. Connect the disk and try again.`, 409);
}

/** Checks the folder can be written, with a hint when macOS withholds access to the disk. */
export async function assertWritable(folder: string) {
  const probe = join(folder, `.write-check-${process.pid}`);
  try {
    await writeFile(probe, '');
    await unlink(probe);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES')
      throw new DiskFolderError(
        `macOS denied access to ${folder}. In System Settings › Privacy & Security › Full Disk Access, allow the program that starts the app, then try again.`,
        403,
      );
    throw error;
  }
}

/** A path inside the folder; anything that would leave it is refused. */
export function inside(root: string, path: string) {
  if (!isAbsolute(root)) throw new DiskFolderError('The project folder must be an absolute path');
  const base = resolve(root),
    target = resolve(base, path);
  if (isAbsolute(path) || (target !== base && !target.startsWith(base + sep)))
    throw new DiskFolderError('Path is outside the project folder');
  return target;
}
const relativeTo = (root: string, path: string) =>
  relative(resolve(root), path).split(sep).join('/');
const hidden = (name: string) => name.startsWith('.');

/** The path itself when free, otherwise the first "name (2).ext" that is. */
async function freePath(path: string) {
  const extension = extname(path),
    stem = path.slice(0, path.length - extension.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? path : `${stem} (${n})${extension}`;
    if (!(await stat(candidate).catch(() => null))) return candidate;
  }
}

/** Removes folders left empty by a move or deletion, up to the project folder. */
async function pruneEmpty(root: string, from: string) {
  const base = resolve(root);
  for (let folder = dirname(from); folder.startsWith(base + sep); folder = dirname(folder)) {
    const entries = await readdir(folder).catch(() => null);
    if (!entries) continue;
    // Finder and exFAT leave bookkeeping files that do not make a folder worth keeping.
    if (entries.some((name) => name !== '.DS_Store' && !name.startsWith('._'))) return;
    for (const name of entries) await unlink(join(folder, name)).catch(() => {});
    await rmdir(folder).catch(() => {});
  }
}

export async function checkFolder(root: string) {
  if (!isAbsolute(root)) throw new DiskFolderError('Choose an absolute folder path');
  await assertVolumeMounted(root);
  await mkdir(root, { recursive: true });
  await assertWritable(root);
  return { folder: resolve(root) };
}

/** Sub-folders to choose from; with no path, the mounted volumes and the home folder. */
export async function browse(path?: string) {
  if (!path)
    return {
      path: null,
      parent: null,
      folders: [
        homedir(),
        ...(await readdir('/Volumes').catch(() => []))
          .filter((name) => !hidden(name))
          .map((name) => `/Volumes/${name}`),
      ],
    };
  if (!isAbsolute(path)) throw new DiskFolderError('Choose an absolute folder path');
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    throw new DiskFolderError(
      code === 'EPERM' || code === 'EACCES'
        ? `macOS denied access to ${path}`
        : `${path} cannot be read`,
      code === 'ENOENT' ? 404 : 403,
    );
  });
  return {
    path: resolve(path),
    parent: dirname(resolve(path)) === resolve(path) ? null : dirname(resolve(path)),
    folders: entries
      .filter((entry) => entry.isDirectory() && !hidden(entry.name))
      .map((entry) => join(resolve(path), entry.name))
      .sort((a, b) => a.localeCompare(b)),
  };
}

/** Every file of the folder the library can read, with its path inside the folder. */
export async function scan(root: string, limit = 5000) {
  const base = inside(root, '.'),
    files: Array<{ path: string; size: number }> = [];
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (hidden(entry.name) || files.length >= limit) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && kindFor(entry.name) && kindFor(entry.name) !== 'artifact') {
        const { size } = await stat(path);
        if (size > 0 && size <= MAX_FILE_BYTES) files.push({ path: relativeTo(base, path), size });
      }
    }
  };
  await walk(base);
  return { files };
}

/** Writes an uploaded file at the first free path for its name, finishing with a rename. */
export async function write(root: string, path: string, body: IncomingMessage) {
  const target = await freePath(inside(root, path));
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.part`;
  let bytes = 0;
  body.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_FILE_BYTES) body.destroy(new DiskFolderError('File exceeds 2 GB', 413));
  });
  try {
    await pipeline(body, createWriteStream(partial));
    await rename(partial, target);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
  return { path: relativeTo(root, target), size: bytes };
}

/** Streams a file, or the byte range a player asks for. */
export async function read(root: string, path: string, req: IncomingMessage, res: ServerResponse) {
  const target = inside(root, path);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile())
    throw new DiskFolderError('The file is no longer in the project folder', 404);
  const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
  let start = 0,
    end = info.size - 1;
  if (range && (range[1] || range[2])) {
    if (range[1]) {
      start = Number(range[1]);
      if (range[2]) end = Math.min(Number(range[2]), end);
    } else start = Math.max(0, info.size - Number(range[2]));
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      res.end();
      return;
    }
  }
  const partial = !!range && (start > 0 || end < info.size - 1);
  res.writeHead(partial ? 206 : 200, {
    'Content-Length': end - start + 1,
    'X-File-Size': info.size,
    ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}),
  });
  if (req.method === 'HEAD') return void res.end();
  await pipeline(createReadStream(target, { start, end }), res);
}

/** Moves a file to its new place in the project, keeping any file already there. */
export async function move(root: string, from: string, to: string) {
  const source = inside(root, from),
    wanted = inside(root, to);
  if (source === wanted) return { path: relativeTo(root, source) };
  if (!(await stat(source).catch(() => null)))
    throw new DiskFolderError('The file is no longer in the project folder', 404);
  const target = await freePath(wanted);
  await mkdir(dirname(target), { recursive: true });
  await rename(source, target);
  await pruneEmpty(root, source);
  return { path: relativeTo(root, target) };
}

export async function makeFolder(root: string, path: string) {
  await mkdir(inside(root, path), { recursive: true });
  return { path };
}

export async function remove(root: string, path: string) {
  const target = inside(root, path);
  await unlink(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  // exFAT keeps a file's extended attributes beside it.
  await unlink(join(dirname(target), `._${target.split(sep).pop()}`)).catch(() => {});
  await pruneEmpty(root, target);
  return { deleted: path };
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
const exists = async (path: string) => !!(await stat(path).catch(() => null));
const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
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
 * The courses in a folder: each sub-folder with readable files, or, for a folder that groups
 * downloaded courses by site (`see/…`), each of its courses. A library data folder is skipped.
 */
export async function listCourses(root: string) {
  await assertVolumeMounted(root);
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
export async function writePack(root: string, path: string, body: IncomingMessage) {
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
export async function readPack(root: string, path: string, res: ServerResponse) {
  const target = packed(root, path);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new DiskFolderError('Not in the prepared material', 404);
  res.writeHead(200, { 'Content-Length': info.size });
  await pipeline(createReadStream(target), res);
}
export async function commitPack(root: string, manifest: { dir: string }) {
  if (!/^files-[\w-]+$/.test(manifest.dir)) throw new DiskFolderError('Unknown export', 400);
  const folder = inside(root, PACK_FOLDER);
  if (!(await exists(join(folder, manifest.dir))))
    throw new DiskFolderError('The export wrote no files', 400);
  await writeFile(join(folder, 'manifest.json.part'), JSON.stringify(manifest, null, 2));
  await rename(join(folder, 'manifest.json.part'), join(folder, 'manifest.json'));
  for (const entry of await readdir(folder, { withFileTypes: true }))
    if (entry.isDirectory() && entry.name.startsWith('files-') && entry.name !== manifest.dir)
      await rm(join(folder, entry.name), { recursive: true, force: true });
  return { dir: manifest.dir };
}

const rootQuery = z.object({ root: z.string().min(1).max(1024), path: z.string().max(1024) });

/** The companion's /disk routes, used by the library through the loopback. */
export async function diskRoute(url: URL, req: IncomingMessage, res: ServerResponse) {
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const query = () =>
    rootQuery.parse({
      root: url.searchParams.get('root'),
      path: url.searchParams.get('path') ?? '',
    });
  const body = async () => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    return JSON.parse(Buffer.concat(parts).toString() || '{}');
  };
  try {
    if (url.pathname === '/disk/check' && req.method === 'POST')
      return send(
        await checkFolder(z.object({ root: z.string().min(1).max(1024) }).parse(await body()).root),
      );
    if (url.pathname === '/disk/courses' && req.method === 'GET')
      return send(await listCourses(query().root));
    if (url.pathname === '/disk/browse' && req.method === 'GET')
      return send(await browse(url.searchParams.get('path') || undefined));
    if (url.pathname === '/disk/scan' && req.method === 'GET') {
      const { root } = query();
      await assertVolumeMounted(root);
      return send(await scan(root));
    }
    if (url.pathname === '/disk/file') {
      const { root, path } = query();
      await assertVolumeMounted(root);
      if (req.method === 'PUT') return send(await write(root, path, req), 201);
      if (req.method === 'GET' || req.method === 'HEAD') return await read(root, path, req, res);
      if (req.method === 'DELETE') return send(await remove(root, path));
    }
    if (url.pathname === '/disk/pack') {
      const { root, path } = query();
      await assertVolumeMounted(root);
      if (req.method === 'PUT') return send(await writePack(root, path, req), 201);
      if (req.method === 'GET') return await readPack(root, path, res);
    }
    if (url.pathname === '/disk/pack/commit' && req.method === 'POST') {
      const input = z
        .object({ root: z.string().min(1), manifest: z.object({ dir: z.string() }).passthrough() })
        .parse(await body());
      await assertVolumeMounted(input.root);
      return send(await commitPack(input.root, input.manifest));
    }
    if (url.pathname === '/disk/move' && req.method === 'POST') {
      const input = z
        .object({ root: z.string().min(1), from: z.string().max(1024), to: z.string().max(1024) })
        .parse(await body());
      await assertVolumeMounted(input.root);
      return send(await move(input.root, input.from, input.to));
    }
    if (url.pathname === '/disk/folder' && req.method === 'POST') {
      const input = z
        .object({ root: z.string().min(1), path: z.string().max(1024) })
        .parse(await body());
      await assertVolumeMounted(input.root);
      return send(await makeFolder(input.root, input.path));
    }
    send({ error: 'Not found' }, 404);
  } catch (error) {
    if (res.headersSent) return void res.destroy();
    send(
      { error: error instanceof Error ? error.message : 'Disk operation failed' },
      error instanceof DiskFolderError ? error.status : error instanceof z.ZodError ? 400 : 500,
    );
  }
}
