import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { MAX_FILE_BYTES } from '../shared/domain';

/**
 * Each project has a folder of its own under `projects/` in the library's data folder. The
 * Worker cannot reach the disk, so the companion writes uploads there, streams reads back,
 * moves files when the student rearranges them in the library, and deletes them.
 */
export class DiskError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** The project folders live beside the Worker state inside the data folder. */
const projectsRoot = (dataDir: string) => join(dataDir, 'projects');

/** A path inside the folder; anything that would leave it is refused. */
function inside(root: string, path: string) {
  if (!isAbsolute(root)) throw new DiskError('The project folder must be an absolute path');
  const base = resolve(root),
    target = resolve(base, path);
  if (isAbsolute(path) || (target !== base && !target.startsWith(base + sep)))
    throw new DiskError('Path is outside the project folder');
  return target;
}

/** Folders left empty by a move or deletion are removed, up to the project folder. */
async function pruneEmpty(root: string, from: string) {
  const base = resolve(root);
  for (let folder = dirname(from); folder.startsWith(base + sep); folder = dirname(folder)) {
    const entries = await readdir(folder).catch(() => null);
    if (!entries) return;
    // Finder and exFAT leave bookkeeping files that do not make a folder worth keeping.
    if (entries.some((name) => name !== '.DS_Store' && !name.startsWith('._'))) return;
    for (const name of entries) await unlink(join(folder, name)).catch(() => {});
    await rmdir(folder).catch(() => {});
  }
}

const safe = (name: string) =>
  name
    .trim()
    .replace(/[\/\\:*?"<>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'project';

/** The folder a new project will keep its files in, under `projects/`. Names that would clash */
/* with a folder already used by another project get a numeric suffix. */
export function newProjectFolder(dataDir: string, name: string, used: string[]) {
  const taken = new Set(used.map((folder) => resolve(folder)));
  const base = projectsRoot(dataDir),
    stem = safe(name);
  for (let n = 1; ; n++) {
    const folder = resolve(join(base, n === 1 ? stem : `${stem} (${n})`));
    if (!taken.has(folder)) return folder;
  }
}

/** Writes an uploaded file at the first free name for its library path. */
async function write(folder: string, path: string, body: IncomingMessage) {
  const target = await freePath(inside(folder, path));
  await mkdir(dirname(target), { recursive: true });
  const partial = `${target}.part`;
  let bytes = 0;
  body.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_FILE_BYTES) body.destroy(new DiskError('File exceeds 2 GB', 413));
  });
  try {
    await pipeline(body, createWriteStream(partial));
    await rename(partial, target);
  } catch (error) {
    await unlink(partial).catch(() => {});
    throw error;
  }
  return { path: relative(resolve(folder), target).split(sep).join('/'), size: bytes };
}

/** The path itself when free, otherwise the first "name (2).ext" that is. */
async function freePath(path: string) {
  const extension = extname(path),
    stem = path.slice(0, path.length - extension.length);
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? path : `${stem} (${n})${extension}`;
    if (!(await stat(candidate).catch(() => null))) return candidate;
  }
}

/** Streams a file, or the byte range a player asks for. */
async function read(folder: string, path: string, req: IncomingMessage, res: ServerResponse) {
  const target = inside(folder, path);
  const info = await stat(target).catch(() => null);
  if (!info?.isFile()) throw new DiskError('The file is no longer in the project folder', 404);
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
async function move(folder: string, from: string, to: string) {
  const source = inside(folder, from),
    destination = await freePath(inside(folder, to));
  await mkdir(dirname(destination), { recursive: true });
  await rename(source, destination);
  await pruneEmpty(folder, source);
  return { path: relative(resolve(folder), destination).split(sep).join('/') };
}

async function remove(folder: string, path: string) {
  const target = inside(folder, path);
  await unlink(target).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
  });
  // macOS writes attribute files beside each real file on exFAT; they go with it.
  await unlink(join(dirname(target), `._${target.split('/').pop()}`)).catch(() => {});
  await pruneEmpty(folder, target);
  return { ok: true };
}

const query = z.object({
  folder: z.string().min(1).max(1024),
  path: z.string().max(1024),
});

/** The companion's /disk routes, used by the library through the loopback. */
export async function diskRoute(
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
  dataDir: string,
) {
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const readBody = async () => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    return JSON.parse(Buffer.concat(parts).toString() || '{}');
  };
  try {
    if (url.pathname === '/disk/project-folder' && req.method === 'POST') {
      const input = z
        .object({
          id: z.string().min(1).max(100),
          name: z.string().min(1).max(240),
          used: z.array(z.string().min(1).max(1024)).max(1000),
        })
        .parse(await readBody());
      const folder = newProjectFolder(dataDir, input.name, input.used);
      await mkdir(folder, { recursive: true });
      return send({ folder }, 201);
    }
    if (url.pathname === '/disk/file') {
      const { folder, path } = query.parse({
        folder: url.searchParams.get('folder'),
        path: url.searchParams.get('path') ?? '',
      });
      if (req.method === 'PUT') return send(await write(folder, path, req), 201);
      if (req.method === 'GET' || req.method === 'HEAD') return await read(folder, path, req, res);
      if (req.method === 'DELETE') return send(await remove(folder, path));
    }
    if (url.pathname === '/disk/move' && req.method === 'POST') {
      const input = z
        .object({
          folder: z.string().min(1),
          from: z.string().min(1).max(1024),
          to: z.string().min(1).max(1024),
        })
        .parse(await readBody());
      return send(await move(input.folder, input.from, input.to));
    }
    send({ error: 'Not found' }, 404);
  } catch (error) {
    if (res.headersSent) return void res.destroy();
    send(
      { error: error instanceof Error ? error.message : 'Disk operation failed' },
      error instanceof DiskError ? error.status : error instanceof z.ZodError ? 400 : 500,
    );
  }
}
