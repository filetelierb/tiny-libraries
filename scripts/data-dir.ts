import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import {
  assertVolumeMounted,
  assertWritable,
  DiskFolderError as DataFolderError,
} from '../server/disk';

export { assertVolumeMounted, assertWritable, DataFolderError };

/**
 * Where the library keeps its data: the local Workers state (originals, library records,
 * conversations) and the companion's working copies. By default both live in the project;
 * `--data <folder>` moves them to another folder, such as an external disk, and is remembered.
 */
export type DataLocation = { state: string; processing: string; folder: string | null };

const MARKER = 'tailored-library.json';
const configFile = (root: string) => join(root, '.local', 'config.json');

/** Launch preferences kept in the project, such as the data and courses folders. */
export type LocalConfig = { dataDir?: string; coursesDir?: string };
export async function readConfig(root: string): Promise<LocalConfig> {
  try {
    return JSON.parse(await readFile(configFile(root), 'utf8'));
  } catch {
    return {};
  }
}

export async function saveConfig(root: string, update: LocalConfig) {
  await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
  await writeFile(
    configFile(root),
    `${JSON.stringify({ ...(await readConfig(root)), ...update }, null, 2)}\n`,
    { mode: 0o600 },
  );
}
export const saveDataFolder = (root: string, folder: string) =>
  saveConfig(root, { dataDir: folder });

/** Marks a folder as holding a library, so a later start can tell it from an empty one. */
export async function markDataFolder(folder: string) {
  const marker = join(folder, MARKER);
  try {
    await stat(marker);
  } catch {
    await writeFile(
      marker,
      `${JSON.stringify({ app: 'tailored-library', createdAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
}

export async function isDataFolder(folder: string) {
  return !!(await stat(join(folder, MARKER)).catch(() => null));
}

/**
 * Resolves where this start keeps its data. A folder given with `--data` is created if needed
 * and remembered. A remembered folder must still hold a library; otherwise the start stops
 * rather than begin an empty one somewhere else.
 */
export async function resolveDataLocation(root: string, requested?: string): Promise<DataLocation> {
  const remembered = (await readConfig(root)).dataDir;
  const folder = requested ? resolve(requested) : remembered;
  if (!folder)
    return {
      state: join(root, '.wrangler', 'state'),
      processing: join(root, '.local', 'processing'),
      folder: null,
    };
  if (!isAbsolute(folder)) throw new DataFolderError(`Use an absolute data folder: ${folder}`);
  await assertVolumeMounted(folder);
  if (requested) {
    await mkdir(folder, { recursive: true });
    await assertWritable(folder);
    await markDataFolder(folder);
    await saveDataFolder(root, folder);
  } else {
    if (!(await isDataFolder(folder)))
      throw new DataFolderError(
        `No library was found in ${folder}. Connect the disk that holds it, or start with --data <folder> to use another folder.`,
      );
    await assertWritable(folder);
  }
  return { state: join(folder, 'state'), processing: join(folder, 'processing'), folder };
}
