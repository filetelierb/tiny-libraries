/**
 * A project can keep its files as ordinary files in a folder of its own. The Worker cannot
 * reach the disk, so the companion reads and writes them there; these calls go to it.
 */
export class DiskError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
type Bridge = { MEDIA_BRIDGE_URL: string; MEDIA_BRIDGE_TOKEN: string };

async function disk(env: Bridge, path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(`${env.MEDIA_BRIDGE_URL}/disk${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${env.MEDIA_BRIDGE_TOKEN}` },
    });
  } catch {
    throw new DiskError('The companion that reads project folders is not running');
  }
  if (!response.ok && response.status !== 206) {
    const body = await response.json<{ error?: string }>().catch(() => null);
    throw new DiskError(body?.error || 'Project folder operation failed', response.status);
  }
  return response;
}
const at = (root: string, path = '') =>
  `?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

/** Creates the folder if needed and checks it can be written. */
export const checkFolder = async (env: Bridge, root: string) =>
  (await disk(env, '/check', post({ root }))).json<{ folder: string }>();
export type CourseFolder = {
  path: string;
  title: string;
  files: number;
  videos: number;
  documents: number;
  bytes: number;
  pack: { files: number; locale: string; exportedAt: string } | null;
};
export const listCourses = async (env: Bridge, root: string) =>
  (await disk(env, `/courses${at(root)}`)).json<{ root: string; courses: CourseFolder[] }>();
export const browseFolders = async (env: Bridge, path?: string) =>
  (await disk(env, `/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`)).json<{
    path: string | null;
    parent: string | null;
    folders: string[];
  }>();
export const scanFolder = async (env: Bridge, root: string) =>
  (await disk(env, `/scan${at(root)}`)).json<{ files: Array<{ path: string; size: number }> }>();
/** Stores an upload at the first free path for its name and says which path it took. */
export const writeOriginal = async (
  env: Bridge,
  root: string,
  path: string,
  body: ReadableStream,
) =>
  (await disk(env, `/file${at(root, path)}`, { method: 'PUT', body })).json<{
    path: string;
    size: number;
  }>();
/** The file, or the range the request asks for, as the companion streams it. */
export const readOriginal = (env: Bridge, root: string, path: string, request?: Request) =>
  disk(env, `/file${at(root, path)}`, {
    method: request?.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: request?.headers.get('Range') ? { Range: request.headers.get('Range')! } : {},
  });
export const moveOriginal = async (env: Bridge, root: string, from: string, to: string) =>
  (await disk(env, '/move', post({ root, from, to }))).json<{ path: string }>();
export const makeFolder = async (env: Bridge, root: string, path: string) =>
  void (await disk(env, '/folder', post({ root, path })));
export const deleteOriginal = async (env: Bridge, root: string, path: string) =>
  void (await disk(env, `/file${at(root, path)}`, { method: 'DELETE' }));
/** Where a file belongs in its project's folder: its library folder, then its name. */
export const diskPath = (file: { folder: string; name: string }) =>
  file.folder ? `${file.folder}/${file.name}` : file.name;

/**
 * The library's object storage, except that originals of files kept in a project folder are
 * read from there. Code that reads an original by its key works the same for both.
 */
export function withFolderOriginals(
  files: R2Bucket,
  env: Bridge,
  locate: (fileId: string) => Promise<{ root: string; path: string } | null>,
): Pick<R2Bucket, 'get' | 'put' | 'delete'> {
  return {
    put: files.put.bind(files),
    delete: files.delete.bind(files),
    get: (async (key: string, options?: R2GetOptions) => {
      const id = key.match(/^original\/([a-f0-9-]+)\/\d+$/)?.[1];
      const place = id ? await locate(id) : null;
      if (!place) return files.get(key, options);
      const response = await readOriginal(env, place.root, place.path);
      return {
        size: Number(response.headers.get('X-File-Size')),
        body: response.body,
        arrayBuffer: () => response.arrayBuffer(),
        text: () => response.text(),
        json: () => response.json(),
      } as unknown as R2ObjectBody;
    }) as R2Bucket['get'],
  };
}

/** A course's prepared material, kept beside its files in `.tailored-library/`. */
export const writePack = async (
  env: Bridge,
  root: string,
  path: string,
  body: ReadableStream | string,
) => void (await disk(env, `/pack${at(root, path)}`, { method: 'PUT', body }));
/** A file of the pack, or null when the pack does not have it. */
export const readPack = async (env: Bridge, root: string, path: string) => {
  try {
    return await disk(env, `/pack${at(root, path)}`);
  } catch (error) {
    if (error instanceof DiskError && error.status === 404) return null;
    throw error;
  }
};
export const commitPack = async (env: Bridge, root: string, manifest: { dir: string }) =>
  void (await disk(env, '/pack/commit', post({ root, manifest })));
