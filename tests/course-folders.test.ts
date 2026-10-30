import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertCourse,
  commitPack,
  inside,
  listCourses,
  PACK_FOLDER,
  scan,
} from '../server/courses';

test('paths stay inside the course folder', () => {
  assert.equal(inside('/data/course', 'Lectures/a.mp4'), '/data/course/Lectures/a.mp4');
  assert.throws(() => inside('/data/course', '../other/a.mp4'), /outside/);
  assert.throws(() => inside('/data/course', '/etc/passwd'), /outside/);
  assert.throws(() => inside('/data/course', 'Lectures/../../x'), /outside/);
  assert.throws(() => inside('relative', 'a'), /absolute/);
  assert.doesNotThrow(() => assertCourse('/disk/courses', '/disk/courses/see/EE261'));
  assert.throws(() => assertCourse('/disk/courses', '/disk/courses'), /courses folder/);
  assert.throws(() => assertCourse('/disk/courses', '/disk/courses-other/x'), /courses folder/);
  assert.throws(() => assertCourse('/disk/courses', '/disk/courses/../x'), /courses folder/);
});

test('a scan lists readable files in lecture order and leaves hidden and unknown ones out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tl-course-'));
  await mkdir(join(root, 'Lectures', 'Lecture 10'), { recursive: true });
  await mkdir(join(root, 'Lectures', 'Lecture 2'), { recursive: true });
  await writeFile(join(root, 'Lectures', 'Lecture 10', 'b.md'), '# B');
  await writeFile(join(root, 'Lectures', 'Lecture 2', 'a.md'), '# A');
  await writeFile(join(root, 'Lectures', 'Lecture 2', '._a.md'), 'attributes');
  await writeFile(join(root, 'tool.zip'), 'zip');
  await writeFile(join(root, 'empty.txt'), '');
  assert.deepEqual((await scan(root)).files, [
    { path: 'Lectures/Lecture 2/a.md', size: 3 },
    { path: 'Lectures/Lecture 10/b.md', size: 3 },
  ]);
});

test('courses are listed per course, inside site folders too, without the library', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tl-courses-'));
  await mkdir(join(root, 'see', 'EE261'), { recursive: true });
  await writeFile(join(root, 'see', 'EE261', 'course.json'), '{"code":"EE261","title":"Fourier"}');
  await writeFile(join(root, 'see', 'EE261', 'notes.md'), '# Notes');
  await mkdir(join(root, 'Robotics', 'Handouts'), { recursive: true });
  await writeFile(join(root, 'Robotics', 'Handouts', 'a.pdf'), '%PDF');
  await mkdir(join(root, 'library'));
  await writeFile(join(root, 'library', 'tailored-library.json'), '{}');
  await writeFile(join(root, 'library', 'x.md'), '# X');
  const { courses } = await listCourses(root);
  assert.deepEqual(
    courses.map((course) => [course.title, course.files, course.documents]),
    [
      ['EE261 – Fourier', 1, 1],
      ['Robotics', 1, 1],
    ],
  );
});

test('a committed pack keeps only the export its manifest names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tl-course-'));
  await mkdir(join(root, PACK_FOLDER, 'files-old', '1'), { recursive: true });
  await mkdir(join(root, PACK_FOLDER, 'files-new', '1'), { recursive: true });
  await assert.rejects(commitPack(root, { dir: '../x' }), /Unknown export/);
  await assert.rejects(commitPack(root, { dir: 'files-gone' }), /no files/);
  await commitPack(root, { dir: 'files-new' });
  assert.deepEqual((await readdir(join(root, PACK_FOLDER))).sort(), ['files-new', 'manifest.json']);
  assert.equal(
    JSON.parse(await readFile(join(root, PACK_FOLDER, 'manifest.json'), 'utf8')).dir,
    'files-new',
  );
  assert.deepEqual((await scan(root)).files, []);
});
