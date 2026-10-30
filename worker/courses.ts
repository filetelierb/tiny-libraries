/**
 * Downloaded courses stay in their own folders on this computer. The Worker cannot reach the
 * disk, so the companion lists them, reads their files and keeps their prepared material.
 */
export class CourseError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}
type Bridge = { MEDIA_BRIDGE_URL: string; MEDIA_BRIDGE_TOKEN: string };

async function companion(env: Bridge, path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(`${env.MEDIA_BRIDGE_URL}/courses${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${env.MEDIA_BRIDGE_TOKEN}` },
    });
  } catch {
    throw new CourseError('The companion that reads courses is not running');
  }
  if (!response.ok) {
    const body = await response.json<{ error?: string }>().catch(() => null);
    throw new CourseError(body?.error || 'Course operation failed', response.status);
  }
  return response;
}
const at = (root: string, path = '') =>
  `?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;

export type CourseFolder = {
  path: string;
  title: string;
  files: number;
  videos: number;
  documents: number;
  bytes: number;
  pack: { files: number; locale: string; exportedAt: string } | null;
};
export const listCourses = async (env: Bridge) =>
  (await companion(env, '/list')).json<{ root: string; courses: CourseFolder[] }>();
/** The course's readable files, by their path inside it, in the order they are listed. */
export const scanCourse = async (env: Bridge, root: string) =>
  (await companion(env, `/scan${at(root)}`)).json<{
    files: Array<{ path: string; size: number }>;
  }>();
export const readCourseFile = (env: Bridge, root: string, path: string) =>
  companion(env, `/file${at(root, path)}`);

/** A course's prepared material, kept beside its files in `.tailored-library/`. */
export const writePack = async (
  env: Bridge,
  root: string,
  path: string,
  body: ReadableStream | string,
) => void (await companion(env, `/pack${at(root, path)}`, { method: 'PUT', body }));
/** A file of the pack, or null when the pack does not have it. */
export const readPack = async (env: Bridge, root: string, path: string) => {
  try {
    return await companion(env, `/pack${at(root, path)}`);
  } catch (error) {
    if (error instanceof CourseError && error.status === 404) return null;
    throw error;
  }
};
export const commitPack = async (env: Bridge, root: string, manifest: { dir: string }) =>
  void (await companion(env, `/pack/commit${at(root)}`, {
    method: 'POST',
    body: JSON.stringify(manifest),
    headers: { 'Content-Type': 'application/json' },
  }));
