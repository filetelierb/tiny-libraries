import { mkdir, readFile, stat, writeFile, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

/**
 * Where the library keeps its data: the local Workers state (originals, library records,
 * conversations) and the companion's working copies. By default both live in the project;
 * `--data <folder>` moves them to another folder, such as an external disk, and is remembered.
 */
export type DataLocation = { state: string; processing: string; folder: string | null };

const MARKER = 'tailored-library.json';
const configFile = (root: string) => join(root, '.local', 'config.json');

export class DataFolderError extends Error {}

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

/**
 * A folder on a volume under /Volumes must be on a mounted disk: with the disk away, macOS
 * would let the folder be created on the internal disk and the library would look empty.
 */
export async function assertVolumeMounted(folder: string) {
  const volume = folder.match(/^\/Volumes\/[^/]+/)?.[0];
  if (!volume) return;
  const [disk, system] = await Promise.all([stat(volume).catch(() => null), stat('/')]);
  if (!disk || disk.dev === system.dev)
    throw new DataFolderError(`${volume} is not mounted. Connect the disk and start again.`);
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
      throw new DataFolderError(
        `macOS denied access to ${folder}. In System Settings › Privacy & Security › Files and Folders, allow your terminal to use removable volumes, then start again.`,
      );
    throw error;
  }
}

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
