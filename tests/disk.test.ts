import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inside, move, remove, scan } from '../server/disk';

test('paths stay inside the project folder', () => {
  assert.equal(inside('/data/course', 'Lectures/a.mp4'), '/data/course/Lectures/a.mp4');
  assert.throws(() => inside('/data/course', '../other/a.mp4'), /outside/);
  assert.throws(() => inside('/data/course', '/etc/passwd'), /outside/);
  assert.throws(() => inside('/data/course', 'Lectures/../../x'), /outside/);
  assert.throws(() => inside('relative', 'a'), /absolute/);
});

test('a scan lists readable files and leaves hidden and unknown ones out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tl-disk-'));
  await mkdir(join(root, 'Notes'));
  await writeFile(join(root, 'Notes', 'a.md'), '# A');
  await writeFile(join(root, 'Notes', '._a.md'), 'attributes');
  await writeFile(join(root, 'Notes', 'tool.zip'), 'zip');
  await writeFile(join(root, 'empty.txt'), '');
  assert.deepEqual((await scan(root)).files, [{ path: 'Notes/a.md', size: 3 }]);
});

test('a move keeps a file already there and removes the folder it emptied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tl-disk-'));
  await mkdir(join(root, 'Old'));
  await mkdir(join(root, 'New'));
  await writeFile(join(root, 'Old', 'a.md'), 'moved');
  await writeFile(join(root, 'Old', '.DS_Store'), '');
  await writeFile(join(root, 'New', 'a.md'), 'kept');
  assert.deepEqual(await move(root, 'Old/a.md', 'New/a.md'), { path: 'New/a (2).md' });
  assert.deepEqual((await readdir(root)).sort(), ['New']);
  await remove(root, 'New/a (2).md');
  assert.deepEqual(await readdir(join(root, 'New')), ['a.md']);
});
