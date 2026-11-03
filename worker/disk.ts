/**
 * The Worker cannot reach the disk, so these go through the companion. Each project has its
 * own folder on disk, named after the project, and keeps its files in it as ordinary files.
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
const at = (folder: string, path = '') =>
  `?folder=${encodeURIComponent(folder)}&path=${encodeURIComponent(path)}`;
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json' },
});

/** Makes a new folder for a project under `projects/`, with a unique name. */
export const createProjectFolder = async (
  env: Bridge,
  input: { id: string; name: string; used: string[] },
) => (await disk(env, '/project-folder', post(input))).json<{ folder: string }>();

/** Stores an upload at the first free path for its name and says which path it took. */
export const writeOriginal = async (
  env: Bridge,
  folder: string,
  path: string,
  body: ReadableStream,
) =>
  (await disk(env, `/file${at(folder, path)}`, { method: 'PUT', body })).json<{
    path: string;
    size: number;
  }>();

/** The file, or the range the request asks for, as the companion streams it. */
export const readOriginal = (env: Bridge, folder: string, path: string, request?: Request) =>
  disk(env, `/file${at(folder, path)}`, {
    method: request?.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: request?.headers.get('Range') ? { Range: request.headers.get('Range')! } : {},
  });

export const moveOriginal = async (env: Bridge, folder: string, from: string, to: string) =>
  (await disk(env, '/move', post({ folder, from, to }))).json<{ path: string }>();

export const deleteOriginal = async (env: Bridge, folder: string, path: string) =>
  void (await disk(env, `/file${at(folder, path)}`, { method: 'DELETE' }));

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
  locate: (fileId: string) => Promise<{ folder: string; path: string } | null>,
): Pick<R2Bucket, 'get' | 'put' | 'delete'> {
  return {
    put: files.put.bind(files),
    delete: files.delete.bind(files),
    get: (async (key: string, options?: R2GetOptions) => {
      const id = key.match(/^original\/([a-f0-9-]+)\/\d+$/)?.[1];
      const place = id ? await locate(id) : null;
      if (!place) return files.get(key, options);
      const response = await readOriginal(env, place.folder, place.path);
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
