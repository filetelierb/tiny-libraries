import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changeDirectory,
  containsPath,
  directoryState,
  ensureDirectories,
  normalizePath,
  purgeTargets,
  sourceState,
} from '../shared/directories';
import type { Source } from '../shared/domain';

const file = (folder: string, archived = false): Source => ({
  id: crypto.randomUUID(),
  version: 1,
  folder,
  archived,
  reviewed: true,
  name: 'reading.md',
  kind: 'markdown',
  mime: 'text/markdown',
  size: 100,
  createdAt: '2026-10-26',
});
test('directory records retain empty folders and infer three levels of ancestors', () => {
  let state = changeDirectory([], [], { action: 'create', parentPath: '', name: 'Course' });
  state = changeDirectory(state.directories, state.files, {
    action: 'create',
    parentPath: 'Course',
    name: 'Week 1',
  });
  state = changeDirectory(state.directories, state.files, {
    action: 'create',
    parentPath: 'Course/Week 1',
    name: 'Readings',
  });
  assert.equal(state.files.length, 0);
  assert.deepEqual(
    state.directories.map((directory) => directory.path),
    ['Course', 'Course/Week 1', 'Course/Week 1/Readings'],
  );
  assert.deepEqual(
    ensureDirectories(state.directories, ['Course/Week 1/Readings']),
    state.directories,
  );
});
test('renaming a parent updates descendants atomically while keeping file identities and versions', () => {
  const files = [file('Course/Week 1'), file('Coursework')];
  const directories = ensureDirectories(
    [],
    files.map((source) => source.folder),
  );
  const original = structuredClone({ directories, files });
  const course = directories.find((directory) => directory.path === 'Course')!;
  const next = changeDirectory(directories, files, {
    action: 'rename',
    id: course.id,
    name: 'Module',
  });
  assert.equal(next.files[0].folder, 'Module/Week 1');
  assert.equal(next.files[0].id, files[0].id);
  assert.equal(next.files[0].version, 1);
  assert.equal(next.files[1].folder, 'Coursework');
  assert.equal(next.directories.find((directory) => directory.path === 'Module')?.id, course.id);
  assert.deepEqual({ directories, files }, original);
});
test('archive and trash inherit without replacing individual archive choices or bytes', () => {
  const files = [file('Course/Week 1'), file('Course/Week 1', true)];
  let directories = ensureDirectories(
    [],
    files.map((source) => source.folder),
  );
  const course = directories.find((directory) => directory.path === 'Course')!;
  directories = changeDirectory(directories, files, {
    action: 'archive',
    id: course.id,
  }).directories;
  assert.equal(sourceState(files[0], directories), 'archived');
  assert.equal(sourceState(files[1], directories), 'archived');
  directories = changeDirectory(directories, files, {
    action: 'unarchive',
    id: course.id,
  }).directories;
  assert.equal(sourceState(files[0], directories), 'files');
  assert.equal(sourceState(files[1], directories), 'archived');
  directories = changeDirectory(directories, files, { action: 'trash', id: course.id }).directories;
  assert.equal(sourceState(files[0], directories), 'trash');
  const child = directories.find((directory) => directory.path === 'Course/Week 1')!;
  assert.equal(directoryState(child.path, directories), 'trash');
  assert.throws(
    () => changeDirectory(directories, files, { action: 'restore', id: child.id }),
    /parent/,
  );
  directories = changeDirectory(directories, files, {
    action: 'restore',
    id: course.id,
  }).directories;
  assert.equal(sourceState(files[0], directories), 'files');
  assert.equal(sourceState(files[1], directories), 'archived');
});
test('directory conflicts and invalid paths cannot partially rewrite a tree', () => {
  const directories = ensureDirectories([], ['Course/Week 1', 'Module']);
  const original = structuredClone(directories);
  const course = directories.find((directory) => directory.path === 'Course')!;
  assert.throws(
    () => changeDirectory(directories, [], { action: 'rename', id: course.id, name: 'module' }),
    /already/,
  );
  assert.throws(
    () => changeDirectory(directories, [], { action: 'create', parentPath: '', name: 'course' }),
    /already/,
  );
  assert.deepEqual(directories, original);
  for (const path of [
    'Course/../Escape',
    'Course//Week',
    'Course/./Week',
    'Course\\Week',
    'Course/\u0000',
  ])
    assert.throws(() => normalizePath(path));
  assert.equal(normalizePath('/ Course / Week 1 /'), 'Course/Week 1');
  assert.equal(containsPath('Course', 'Coursework'), false);
});
test('archived and trashed directories reject creation and restore retains stable identities', () => {
  let directories = ensureDirectories([], ['Course']);
  const root = directories[0];
  directories = changeDirectory(directories, [], { action: 'archive', id: root.id }).directories;
  assert.throws(
    () =>
      changeDirectory(directories, [], { action: 'create', parentPath: 'Course', name: 'Week' }),
    /Restore/,
  );
  directories = changeDirectory(directories, [], { action: 'trash', id: root.id }).directories;
  assert.throws(
    () =>
      changeDirectory(directories, [], { action: 'create', parentPath: 'Course', name: 'Week' }),
    /Restore/,
  );
  directories = changeDirectory(directories, [], { action: 'restore', id: root.id }).directories;
  assert.equal(directories[0].id, root.id);
  assert.equal(directories[0].archived, true);
});
test('moving a directory carries descendants and refuses moves into itself', () => {
  const files = [file('Course/Week 1'), file('Archive')];
  const directories = ensureDirectories(
    [],
    files.map((source) => source.folder),
  );
  const week = directories.find((directory) => directory.path === 'Course/Week 1')!;
  const course = directories.find((directory) => directory.path === 'Course')!;
  const next = changeDirectory(directories, files, {
    action: 'move',
    id: week.id,
    parentPath: 'Archive',
  });
  assert.equal(
    next.directories.find((directory) => directory.id === week.id)?.path,
    'Archive/Week 1',
  );
  assert.equal(next.files[0].folder, 'Archive/Week 1');
  assert.equal(next.files[0].id, files[0].id);
  const root = changeDirectory(directories, files, { action: 'move', id: week.id, parentPath: '' });
  assert.equal(root.directories.find((directory) => directory.id === week.id)?.path, 'Week 1');
  assert.throws(
    () =>
      changeDirectory(directories, files, {
        action: 'move',
        id: course.id,
        parentPath: 'Course/Week 1',
      }),
    /cannot move into itself/,
  );
  assert.throws(
    () =>
      changeDirectory(directories, files, { action: 'move', id: week.id, parentPath: 'Missing' }),
    /not found/,
  );
});

test('permanent delete only purges trashed files and whole trashed folders', () => {
  let state = changeDirectory([], [], { action: 'create', parentPath: '', name: 'Course' });
  state = changeDirectory(state.directories, state.files, {
    action: 'create',
    parentPath: 'Course',
    name: 'Week 1',
  });
  const inside = file('Course/Week 1'),
    outside = file('Other');
  const course = state.directories.find((directory) => directory.path === 'Course')!;
  assert.throws(() => purgeTargets(state.directories, [inside], { kind: 'file', id: inside.id }));
  assert.throws(() =>
    purgeTargets(state.directories, [inside], { kind: 'directory', id: course.id }),
  );
  const trashed = changeDirectory(state.directories, [inside, outside], {
    action: 'trash',
    id: course.id,
  });
  const purge = purgeTargets(trashed.directories, trashed.files, {
    kind: 'directory',
    id: course.id,
  });
  assert.deepEqual(purge.directories.map((directory) => directory.path).sort(), [
    'Course',
    'Course/Week 1',
  ]);
  assert.deepEqual(
    purge.files.map((entry) => entry.id),
    [inside.id],
  );
  assert.equal(
    purgeTargets(trashed.directories, trashed.files, { kind: 'file', id: inside.id }).files[0].id,
    inside.id,
  );
  const loose = { ...outside, trashed: true };
  assert.equal(purgeTargets([], [loose], { kind: 'file', id: loose.id }).files.length, 1);
});
