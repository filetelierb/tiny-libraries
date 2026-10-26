import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedTime,
  chapterRanges,
  chapterLanes,
  formatTime,
  playbackSpeeds,
} from '../shared/media-controls';
import type { PublicLearning } from '../shared/domain';

test('media bounds reject nonfinite timing and expose every supported quarter speed', () => {
  assert.equal(boundedTime(14, 12), 12);
  assert.equal(boundedTime(-3, 12), 0);
  assert.equal(boundedTime(NaN, 12), 0);
  assert.equal(boundedTime(3, Infinity), 0);
  assert.equal(formatTime(3661.9), '1:01:01');
  assert.equal(formatTime(-1), '0:00');
  assert.equal(playbackSpeeds.length, 16);
  assert.ok(playbackSpeeds.includes(2.25) && playbackSpeeds.includes(3.75));
});

test('overlapping chapter ranges occupy separate pointer-accessible lanes', () => {
  const lanes = chapterLanes([
    { id: 'first', title: 'First', start: 0, end: 5 },
    { id: 'overlap', title: 'Overlap', start: 0, end: 5 },
    { id: 'next', title: 'Next', start: 5, end: 10 },
  ]);
  assert.deepEqual(
    lanes.map((chapter) => chapter.lane),
    [0, 1, 0],
  );
});
test('chapter timeline uses actual source intervals and excludes document-only evidence', () => {
  const learning: PublicLearning = {
    sourceId: 'file',
    sourceVersion: 1,
    locale: 'en',
    model: 'test',
    createdAt: 'today',
    segments: [
      { id: 'start', text: 'first', start: 3, end: 7 },
      { id: 'end', text: 'next', start: 7, end: 15 },
      { id: 'pdf', text: 'page', page: 1 },
      { id: 'beyond', text: 'outside', start: 30, end: 40 },
    ],
    synthesis: {
      title: 'Test',
      glossary: [],
      artifact: null,
      chapters: [
        {
          id: 'chapter',
          title: 'A chapter',
          segmentIds: ['start', 'end'],
          summary: '',
          questions: [],
        },
        { id: 'document', title: 'A page', segmentIds: ['pdf'], summary: '', questions: [] },
        {
          id: 'outside',
          title: 'Invalid interval',
          segmentIds: ['beyond'],
          summary: '',
          questions: [],
        },
      ],
    },
  };
  assert.deepEqual(chapterRanges(learning, 12), [
    { id: 'chapter', title: 'A chapter', start: 3, end: 12 },
  ]);
  assert.deepEqual(chapterRanges(learning, 0), []);
  assert.deepEqual(chapterRanges(null, 12), []);
});
