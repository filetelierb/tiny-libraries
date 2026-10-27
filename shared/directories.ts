import { fold, type Directory, type Source } from './domain';

export type CatalogView = 'files' | 'archived' | 'trash';
export class DirectoryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
export const directoryName = (path: string) => path.split('/').at(-1) || '';
export const containsPath = (parent: string, path: string) =>
  path === parent || path.startsWith(`${parent}/`);
export function normalizePath(input: string): string {
  const path = input
    .normalize('NFC')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (path.length > 240) throw new DirectoryError('Directory path exceeds 240 characters');
  if (!path) return '';
  const parts = path.split('/').map((part) => part.trim());
  if (
    parts.some(
      (part) => !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f]/.test(part),
    )
  )
    throw new DirectoryError(
      'Use valid directory names without dot segments or control characters',
    );
  return parts.join('/');
}
export function directoryState(path: string, directories: Directory[]): CatalogView {
  const ancestors = directories.filter((directory) => containsPath(directory.path, path));
  if (ancestors.some((directory) => directory.trashed)) return 'trash';
  return ancestors.some((directory) => directory.archived) ? 'archived' : 'files';
}
export function sourceState(source: Source, directories: Directory[]): CatalogView {
  const inherited = directoryState(source.folder, directories);
  if (source.trashed || inherited === 'trash') return 'trash';
  return source.archived || inherited === 'archived' ? 'archived' : 'files';
}
/** Records removed by a permanent delete; only items already in Trash can be purged. */
export function purgeTargets(
  directories: Directory[],
  files: Source[],
  target: { kind: 'file' | 'directory'; id: string },
) {
  if (target.kind === 'file') {
    const file = files.find((entry) => entry.id === target.id);
    if (!file) throw new DirectoryError('File not found', 404);
    if (sourceState(file, directories) !== 'trash')
      throw new DirectoryError('Move the file to Trash before deleting it permanently', 409);
    return { directories: [] as Directory[], files: [file] };
  }
  const directory = directories.find((entry) => entry.id === target.id);
  if (!directory) throw new DirectoryError('Directory not found', 404);
  if (directoryState(directory.path, directories) !== 'trash')
    throw new DirectoryError('Move the folder to Trash before deleting it permanently', 409);
  return {
    directories: directories.filter((entry) => containsPath(directory.path, entry.path)),
    files: files.filter((entry) => containsPath(directory.path, entry.folder)),
  };
}
export function assertWritableDirectory(path: string, directories: Directory[]) {
  if (directoryState(path, directories) !== 'files')
    throw new DirectoryError('Restore the parent directory before adding or moving files', 409);
}

/** Keep empty directories durable and infer ancestors for older path-based imports. */
export function ensureDirectories(existing: Directory[], paths: string[]): Directory[] {
  const result = [...existing];
  for (const input of paths) {
    const parts = normalizePath(input).split('/').filter(Boolean);
    for (let index = 1; index <= parts.length; index++) {
      const path = parts.slice(0, index).join('/');
      const same = result.find((directory) => directory.path === path);
      if (!same)
        result.push({
          id: crypto.randomUUID(),
          path,
          archived: false,
          trashed: false,
          createdAt: new Date().toISOString(),
        });
    }
  }
  return result;
}

export type DirectoryOperation =
  | { action: 'create'; parentPath: string; name: string }
  | { action: 'rename'; id: string; name: string }
  | { action: 'move'; id: string; parentPath: string }
  | { action: 'archive' | 'unarchive' | 'trash' | 'restore'; id: string };

export function changeDirectory(
  directories: Directory[],
  files: Source[],
  operation: DirectoryOperation,
) {
  if (operation.action === 'create') {
    const parent = normalizePath(operation.parentPath);
    if (parent && !directories.some((directory) => directory.path === parent))
      throw new DirectoryError('Parent directory not found', 404);
    assertWritableDirectory(parent, directories);
    const name = normalizePath(operation.name);
    if (!name || name.includes('/')) throw new DirectoryError('Enter one directory name');
    const path = normalizePath(parent ? `${parent}/${name}` : name);
    if (directories.some((directory) => fold(directory.path) === fold(path)))
      throw new DirectoryError(
        'A directory with this name already exists, including in Trash',
        409,
      );
    return { directories: ensureDirectories(directories, [path]), files };
  }
  const directory = directories.find((entry) => entry.id === operation.id);
  if (!directory) throw new DirectoryError('Directory not found', 404);
  if (operation.action === 'rename' || operation.action === 'move') {
    if (directoryState(directory.path, directories) === 'trash')
      throw new DirectoryError('Restore this directory before renaming it', 409);
    let path: string;
    if (operation.action === 'move') {
      const parent = normalizePath(operation.parentPath);
      if (parent && !directories.some((entry) => entry.path === parent))
        throw new DirectoryError('Parent directory not found', 404);
      if (containsPath(directory.path, parent))
        throw new DirectoryError('A directory cannot move into itself', 409);
      assertWritableDirectory(parent, directories);
      const name = directoryName(directory.path);
      path = normalizePath(parent ? `${parent}/${name}` : name);
    } else {
      const name = normalizePath(operation.name);
      if (!name || name.includes('/')) throw new DirectoryError('Enter one directory name');
      const parent = parentPath(directory.path);
      path = normalizePath(parent ? `${parent}/${name}` : name);
    }
    const rewritten = directories.map((entry) =>
      containsPath(directory.path, entry.path)
        ? { ...entry, path: normalizePath(path + entry.path.slice(directory.path.length)) }
        : entry,
    );
    if (new Set(rewritten.map((entry) => fold(entry.path))).size !== rewritten.length)
      throw new DirectoryError('A directory with this name already exists', 409);
    return {
      directories: rewritten,
      files: files.map((file) =>
        containsPath(directory.path, file.folder)
          ? { ...file, folder: normalizePath(path + file.folder.slice(directory.path.length)) }
          : file,
      ),
    };
  }
  if (
    operation.action === 'restore' &&
    directoryState(parentPath(directory.path), directories) === 'trash'
  )
    throw new DirectoryError('Restore the parent directory first', 409);
  if (
    operation.action === 'unarchive' &&
    directoryState(parentPath(directory.path), directories) !== 'files'
  )
    throw new DirectoryError('Restore the parent directory first', 409);
  return {
    directories: directories.map((entry) =>
      entry.id === directory.id
        ? {
            ...entry,
            ...(operation.action === 'archive' ? { archived: true } : {}),
            ...(operation.action === 'unarchive' ? { archived: false } : {}),
            ...(operation.action === 'trash' ? { trashed: true } : {}),
            ...(operation.action === 'restore' ? { trashed: false } : {}),
          }
        : entry,
    ),
    files,
  };
}
