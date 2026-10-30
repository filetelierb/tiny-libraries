import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSeeCatalog, parseSeeCourse } from '../scripts/courses/see';
import { lectureSelection, safeName, text } from '../scripts/courses/source';

// An authored page with the same structure as a course page: one panel per section.
const panel = (title: string, body: string) =>
  `<div class="panel panel-collapsable"><div class="panel-heading"><h2>${title}</h2></div><div class="panel-content">${body}</div></div>`;
const coursePage = [
  panel('Course Description', '<p>Signals &amp; systems.</p>'),
  panel(
    'Instructor',
    '<div class="media"><img alt="" src="/i.jpg"/><p>Doe, Ada</p></div><p>Bio.</p>',
  ),
  panel(
    'Handouts',
    '<table><tr><td><a href="/materials/x/Syllabus.pdf">Syllabus</a></td></tr><tr><td><a href="/materials/x/notes.pdf">notes.pdf</a></td></tr></table>',
  ),
  panel(
    'Assignments',
    '<table><tr><th>Assignment</th></tr><tr><td>Problem Set 1</td><td><a href="/materials/x/ps1.pdf">Questions</a></td><td><a href="/materials/x/ps1-sol.pdf">Solutions</a></td><td><a href="https://elsewhere.example/tool.zip">Tool</a></td></tr></table>',
  ),
  '<div class="collapsables"><h2 class="pull-left">Course Sessions <span>(2):</span></h2>',
  panel(
    'Lecture 2',
    '<table><tr><td><a href="/Course/X1/12" rel="player">Watch</a></td><td><a download="" href="/videos/X1-lecture02.mp4">Download</a></td><td> 1 hr 5 min </td></tr><tr><td colspan="4"><strong>Topics:</strong> Sampling, Aliasing</td></tr></table><ul><li><a href="/materials/x/t/L02.html">HTML</a></li><li><a href="/materials/x/t/L02.pdf">PDF</a></li></ul>',
  ),
  panel(
    'Lecture 1',
    '<table><tr><td><a download="" href="/videos/X1-lecture01.mp4">Download</a></td><td> 52 min </td></tr></table>',
  ),
].join('\n');

test('the catalog keeps each course once, with the name from its named link', () => {
  const courses = parseSeeCatalog(
    '<a href="/Course/X1"><img src="/a.png"/></a><a href="/Course/X1">Signals</a><a href="/Course/Y2">Optics &amp; Light</a>',
  );
  assert.deepEqual(
    courses.map((c) => [c.code, c.title]),
    [
      ['X1', 'Signals'],
      ['Y2', 'Optics & Light'],
    ],
  );
});

test('a course page becomes lectures with their video and transcript, and material folders', () => {
  const course = parseSeeCourse(coursePage, 'X1');
  assert.equal(course.instructor, 'Doe, Ada');
  assert.equal(course.description, 'Signals & systems.');
  assert.deepEqual(course.lectures, [
    { number: 1, duration: '52 min' },
    { number: 2, duration: '1 hr 5 min', topics: 'Sampling, Aliasing' },
  ]);
  assert.deepEqual(
    course.files.map((file) => `${file.role} ${file.folder}/${file.name}`),
    [
      'material Handouts/Syllabus.pdf',
      'material Handouts/notes.pdf',
      'material Assignments/Problem Set 1 – Questions.pdf',
      'material Assignments/Problem Set 1 – Solutions.pdf',
      'video Lectures/Lecture 02/Lecture 02.mp4',
      'transcript Lectures/Lecture 02/Lecture 02 transcript.pdf',
      'video Lectures/Lecture 01/Lecture 01.mp4',
    ],
  );
  // Links to other sites keep their own terms and are not downloaded.
  assert.ok(course.files.every((file) => file.url.startsWith('https://see.stanford.edu/')));
  assert.equal(course.license.name, 'CC BY-NC-SA 4.0');
});

test('lecture selections, names and page text', () => {
  assert.deepEqual([...lectureSelection('1-3,7', [1, 2, 3, 4, 7])], [1, 2, 3, 7]);
  assert.deepEqual([...lectureSelection('all', [1, 2])], [1, 2]);
  assert.equal(lectureSelection(undefined, [1]).size, 0);
  assert.equal(lectureSelection('none', [1]).size, 0);
  assert.throws(() => lectureSelection('3-1', [1, 2, 3]));
  assert.equal(safeName('Chapter 8: a/b?'), 'Chapter 8- a-b-');
  assert.equal(safeName('...'), 'file');
  assert.equal(text('<p>A&nbsp;&#39;B&#x27;</p>'), "A 'B'");
});
