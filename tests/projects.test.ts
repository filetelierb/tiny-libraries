import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKS,
  activityLevel,
  activityStreaks,
  activityWeights,
  classifyActivity,
  scoreActivity,
  withoutProject,
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

test('each interaction on the list is recognised with the record it concerns', () => {
  const kinds = (method: string, path: string, body: unknown = {}) =>
    classifyActivity(method, path, body);
  assert.deepEqual(kinds('PATCH', '/api/files/f1', { reviewed: true }), [
    { kind: 'progress', key: 'f1' },
  ]);
  assert.deepEqual(kinds('PATCH', '/api/files/f1', { name: 'Renamed' }), []);
  // Quiz answers and card reviews are reported by the library, which knows their size.
  assert.deepEqual(kinds('POST', '/api/attempts', { sourceId: 's', questionId: 'q' }), []);
  assert.deepEqual(kinds('POST', '/api/flashcards/d1/review', { cardId: 'c' }), []);
  assert.deepEqual(kinds('POST', '/api/assessments/t1/answers', { questionId: 'b1:q3' }), [
    { kind: 'test', key: 't1:b1:q3' },
  ]);
  assert.deepEqual(kinds('PUT', '/api/annotations/0a1b'), [{ kind: 'note', key: 'note:0a1b' }]);
  assert.deepEqual(kinds('PUT', '/api/glossary/0c2d'), [{ kind: 'note', key: 'concept:0c2d' }]);
  assert.deepEqual(kinds('POST', '/api/glossary/merge', { targetId: 'x' }), [
    { kind: 'note', key: 'concept:x' },
  ]);
  assert.deepEqual(kinds('POST', '/api/conversations/c/messages', { requestId: 'r1' }), [
    { kind: 'tutor', key: 'r1' },
  ]);
  assert.deepEqual(kinds('DELETE', '/api/annotations/0a1b'), []);
  assert.deepEqual(kinds('POST', '/api/annotations/query'), []);
  assert.deepEqual(kinds('PUT', '/api/sessions/s1', { positions: { f: 3 } }), []);
  assert.deepEqual(kinds('POST', '/api/directories'), []);
});

test('an interaction counts once a day per record, weighted by its kind', () => {
  let day = scoreActivity({ day: '2026-10-30', total: 0, projects: {} }, 'default', [
    { kind: 'progress', key: 'f1' },
    { kind: 'progress', key: 'f1' },
    { kind: 'test', key: 't:q1' },
  ]);
  assert.equal(day.total, activityWeights.progress + activityWeights.test);
  day = scoreActivity(day, 'default', [
    { kind: 'progress', key: 'f1' },
    { kind: 'test', key: 't:q2' },
    { kind: 'tutor', key: 'r1' },
    { kind: 'tutor', key: 'r2' },
  ]);
  assert.equal(
    day.total,
    activityWeights.progress + 2 * activityWeights.test + 2 * activityWeights.tutor,
  );
  assert.deepEqual(day.kinds, { progress: 1, test: 2, tutor: 2 });
  const other = crypto.randomUUID();
  day = scoreActivity(day, other, [{ kind: 'progress', key: 'f1' }]);
  assert.equal(day.projects[other], activityWeights.progress);
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

test('a mini quiz or a deck counts once, when all of it is done that day', () => {
  const quiz = (part: string) => ({ kind: 'quiz' as const, key: 's:c1', part, parts: 3 });
  let day = scoreActivity({ day: '2026-10-30', total: 0, projects: {} }, 'default', [
    quiz('q1'),
    quiz('q2'),
    quiz('q2'),
  ]);
  assert.equal(day.total, 0);
  day = scoreActivity(day, 'default', [quiz('q3')]);
  assert.equal(day.total, activityWeights.quiz);
  day = scoreActivity(day, 'default', [quiz('q1'), quiz('q2'), quiz('q3')]);
  assert.equal(day.total, activityWeights.quiz);
  const card = (part: string) => ({ kind: 'deck' as const, key: 'd1', part, parts: 2 });
  day = scoreActivity(day, 'default', [card('a'), card('a')]);
  assert.equal(day.total, activityWeights.quiz);
  day = scoreActivity(day, 'default', [card('b')]);
  assert.equal(day.total, activityWeights.quiz + activityWeights.deck);
  assert.deepEqual(day.kinds, { quiz: 1, deck: 1 });
  const next = scoreActivity({ day: '2026-10-31', total: 0, projects: {} }, 'default', [card('a')]);
  assert.equal(next.total, 0);
});

test("a deleted project's points leave the days it shared, and its own days go", () => {
  const other = crypto.randomUUID();
  let day = scoreActivity({ day: '2026-10-30', total: 0, projects: {} }, 'default', [
    { kind: 'progress', key: 'f1' },
  ]);
  day = scoreActivity(day, other, [
    { kind: 'progress', key: 'f2' },
    { kind: 'test', key: 't:q1' },
  ]);
  const kept = withoutProject(day, other)!;
  assert.equal(kept.total, activityWeights.progress);
  assert.deepEqual(kept.projects, { default: activityWeights.progress });
  assert.deepEqual(kept.kinds, { progress: 1 });
  assert.equal(
    kept.seen!.some((identity) => identity.startsWith(`${other}:`)),
    false,
  );
  const alone = scoreActivity({ day: '2026-10-29', total: 0, projects: {} }, other, [
    { kind: 'note', key: 'note:n1' },
  ]);
  assert.equal(withoutProject(alone, other), null);
  assert.equal(withoutProject(kept, other), kept);
});
