import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSynthesis, type Segment, type Synthesis } from '../shared/domain';
import { mergeParts, ownedPart, synthesisWindows } from '../shared/synthesis-windows';

const pages = (n: number): Segment[] =>
  Array.from({ length: n }, (_, i) => ({ id: `page-${i + 1}`, text: 'x'.repeat(90), page: i + 1 }));

const question = (id: string, segmentId: string) => ({
  id,
  kind: 'boolean' as const,
  prompt: `Claim ${id}`,
  choices: ['True', 'False'],
  correctIndex: 0,
  expectedAnswer: null,
  rubric: null,
  explanation: 'Stated in the source.',
  concept: id,
  segmentIds: [segmentId],
});

const part = (title: string, chapters: Array<[string, string[]]>, terms: string[]): Synthesis => ({
  title,
  chapters: chapters.map(([name, ids], i) => ({
    id: `c${i + 1}`,
    title: name,
    summary: `${name} summary`,
    segmentIds: ids,
    questions: [question(`q${i + 1}`, ids[0])],
  })),
  glossary: terms.map((term) => ({ term, definition: `${term} means`, segmentIds: ['page-1'] })),
  artifact: null,
});

test('short sources are analysed in one window', () => {
  assert.deepEqual(synthesisWindows(pages(5)), [{ start: 0, owned: 0, end: 5 }]);
});

test('long sources split into windows that repeat the previous window end', () => {
  const segments = pages(10),
    windows = synthesisWindows(segments, 450, 2);
  assert.ok(windows.length > 1);
  assert.equal(windows[0].start, 0);
  for (let i = 1; i < windows.length; i++) {
    assert.equal(windows[i].owned, windows[i - 1].end, 'owned ranges are contiguous');
    assert.equal(windows[i].start, windows[i].owned - 2, 'two segments of overlap');
  }
  assert.equal(windows.at(-1)!.end, segments.length);
  // Every segment is owned by exactly one window.
  assert.equal(
    windows.reduce((sum, w) => sum + w.end - w.owned, 0),
    segments.length,
  );
});

test('an oversized segment still forms its own window', () => {
  const segments = [{ id: 'a', text: 'y'.repeat(1000) }, ...pages(2)];
  const windows = synthesisWindows(segments, 300, 1);
  assert.deepEqual(windows[0], { start: 0, owned: 0, end: 1 });
  assert.equal(windows.at(-1)!.end, 3);
});

test('chapters made only from repeated context are dropped', () => {
  const segments = pages(6),
    window = { start: 2, owned: 4, end: 6 };
  const result = ownedPart(
    part(
      'Part',
      [
        ['Context only', ['page-3', 'page-4']],
        ['Crosses boundary', ['page-4', 'page-5']],
      ],
      [],
    ),
    segments,
    window,
  );
  assert.deepEqual(
    result.chapters.map((c) => c.title),
    ['Crosses boundary'],
  );
});

test('the outline regroups every section once, in order, and keeps ids unique', () => {
  const parts = [
    part(
      'One',
      [
        ['Intro', ['page-1']],
        ['Series', ['page-2']],
      ],
      ['Fourier series', 'Period'],
    ),
    part(
      'Two',
      [
        ['Series again', ['page-3']],
        ['Transform', ['page-4']],
      ],
      ['fourier series', 'Transform'],
    ),
  ];
  const merged = mergeParts(parts, {
    title: 'Fourier',
    chapters: [
      { title: 'Introduction', summary: 'Start', sections: ['part-1-1'] },
      // part-2-1 is omitted; it joins the chapter of the section before it.
      { title: 'Series', summary: 'Periodic', sections: ['part-1-2', 'unknown'] },
      { title: 'Transform', summary: 'Aperiodic', sections: ['part-2-2', 'part-1-1'] },
    ],
  });
  assert.deepEqual(
    merged.chapters.map((c) => [c.id, c.title, c.segmentIds]),
    [
      ['chapter-1', 'Introduction', ['page-1']],
      ['chapter-2', 'Series', ['page-2', 'page-3']],
      ['chapter-3', 'Transform', ['page-4']],
    ],
  );
  assert.deepEqual(
    merged.chapters[1].questions.map((q) => q.id),
    ['p1-q2', 'p2-q1'],
  );
  assert.deepEqual(
    merged.glossary.map((t) => t.term),
    ['Fourier series', 'Period', 'Transform'],
  );
  // The merged guide passes the same validation as a single-call guide.
  assert.doesNotThrow(() => validateSynthesis(merged, pages(4)));
});
