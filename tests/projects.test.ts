import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKS,
  activityLevel,
  activityStreaks,
  countsAsActivity,
  heatmapStart,
  libraryObjectName,
  localDay,
  projectIdSchema,
} from '../shared/projects';

test('the first library keeps its object, and other projects get their own', () => {
  assert.equal(libraryObjectName('default'), 'local-user');
  const id = crypto.randomUUID();
  assert.equal(libraryObjectName(id), `project:${id}`);
  assert.equal(projectIdSchema.safeParse('../local-user').success, false);
});

test('only changes the student makes count as activity', () => {
  assert.equal(countsAsActivity('POST', '/api/sessions/abc/conversations'), true);
  assert.equal(countsAsActivity('PUT', '/api/annotations/abc'), true);
  assert.equal(countsAsActivity('DELETE', '/api/files/abc'), true);
  assert.equal(countsAsActivity('GET', '/api/catalog'), false);
  assert.equal(countsAsActivity('POST', '/api/annotations/query'), false);
  assert.equal(countsAsActivity('POST', '/api/assessments/options'), false);
  assert.equal(countsAsActivity('PUT', '/api/sessions/abc'), false);
  assert.equal(countsAsActivity('POST', '/api/settings'), false);
  assert.equal(countsAsActivity('POST', '/api/projects'), false);
});

test('the graph covers a year of whole weeks ending with today', () => {
  const today = new Date(2026, 9, 30); // a Friday
  const sunday = heatmapStart(today, 0),
    monday = heatmapStart(today, 1);
  assert.equal(sunday.getDay(), 0);
  assert.equal(monday.getDay(), 1);
  const days = Math.round((today.getTime() - sunday.getTime()) / 86400000) + 1;
  assert.ok(days > (WEEKS - 1) * 7 && days <= WEEKS * 7);
  assert.equal(localDay(today), '2026-10-30');
});

test('levels are relative to the busiest day and streaks tolerate an idle today', () => {
  assert.equal(activityLevel(0, 10), 0);
  assert.equal(activityLevel(1, 10), 1);
  assert.equal(activityLevel(10, 10), 4);
  const days = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'];
  const counts = new Map([
    ['2026-10-25', 2],
    ['2026-10-27', 1],
    ['2026-10-28', 3],
    ['2026-10-29', 1],
  ]);
  assert.deepEqual(activityStreaks(days, counts), { current: 3, longest: 3 });
  counts.delete('2026-10-29');
  assert.deepEqual(activityStreaks(days, counts), { current: 0, longest: 2 });
});
