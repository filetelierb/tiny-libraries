import { connect } from 'node:net';
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertVolumeMounted,
  assertWritable,
  DataFolderError,
  markDataFolder,
  resolveDataLocation,
  saveDataFolder,
} from './data-dir';

/**
 * Copies the library to another data folder, such as an external disk, and makes the next
 * start use it. The current copy stays where it is until you delete it yourself.
 *
 *   npm run move-data -- /Volumes/Disk/tailored-library
 */
const root = process.cwd(),
  target = process.argv[2] && resolve(process.argv[2]);
const inUse = (port: number) =>
  new Promise<boolean>((done) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
async function measure(folder: string): Promise<{ files: number; bytes: number }> {
  let files = 0,
    bytes = 0;
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      const inner = await measure(path);
      files += inner.files;
      bytes += inner.bytes;
    } else if (entry.isFile()) {
      files++;
      bytes += (await stat(path)).size;
    }
  }
  return { files, bytes };
}
const size = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

try {
  if (!target) throw new DataFolderError('Usage: npm run move-data -- <absolute folder>');
  if ((await inUse(9876)) || (await inUse(9877)))
    throw new DataFolderError('Stop the app (Ctrl+C) before moving its data.');
  const current = await resolveDataLocation(root);
  if (current.folder === target) throw new DataFolderError(`The library already uses ${target}.`);
  await assertVolumeMounted(target);
  await mkdir(target, { recursive: true });
  await assertWritable(target);
  const pairs = [
    [current.state, join(target, 'state')],
    [current.processing, join(target, 'processing')],
  ] as const;
  for (const [, to] of pairs)
    if ((await readdir(to).catch(() => [])).length)
      throw new DataFolderError(`${to} is not empty; choose another folder.`);
  for (const [from, to] of pairs) {
    const before = await measure(from);
    console.log(`Copying ${from} (${before.files} files, ${size(before.bytes)})…`);
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
    const after = await measure(to);
    if (after.files !== before.files || after.bytes !== before.bytes)
      throw new DataFolderError(
        `The copy in ${to} does not match its source; nothing was switched.`,
      );
  }
  await markDataFolder(target);
  await saveDataFolder(root, target);
  console.log(`The next start uses ${target}.`);
  console.log(`The previous copy is still in ${current.state} and ${current.processing};`);
  console.log('delete it once the library opens from the new folder.');
} catch (error) {
  if (!(error instanceof DataFolderError)) throw error;
  console.error(error.message);
  process.exit(1);
}
