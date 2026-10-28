import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownedTurns, parseTranscript, transcriptSegments } from '../shared/transcript';
import { kindFor } from '../shared/domain';

const vtt = `WEBVTT

intro
00:00:01.000 --> 00:00:04.500
<v Ana>Sampling turns a signal into numbers.

00:00:30.000 --> 00:00:33.000
The rate counts samples per second.

00:01:05.250 --> 00:01:09.000 align:start
Too few samples alias the signal.
`;
const srt = `1\r\n00:00:02,000 --> 00:00:05,000\r\nFirst line\r\nsecond line\r\n\r\n2\r\n00:10:00,5 --> 00:10:03,000\r\nLater\r\n`;

test('WebVTT and SRT cues are read with their times and without markup', () => {
  assert.deepEqual(parseTranscript(vtt), [
    { start: 1, end: 4.5, text: 'Sampling turns a signal into numbers.' },
    { start: 30, end: 33, text: 'The rate counts samples per second.' },
    { start: 65.25, end: 69, text: 'Too few samples alias the signal.' },
  ]);
  assert.deepEqual(parseTranscript(srt), [
    { start: 2, end: 5, text: 'First line\nsecond line' },
    { start: 600.5, end: 603, text: 'Later' },
  ]);
  assert.deepEqual(parseTranscript('Plain notes.\n\nNo cues here.'), []);
});

test('cues group into timed passages of about a minute', () => {
  const segments = transcriptSegments(parseTranscript(vtt));
  assert.deepEqual(
    segments.map((segment) => [
      segment.id,
      segment.start,
      segment.end,
      segment.text.split('\n').length,
    ]),
    [
      ['cue-1', 1, 33, 2],
      ['cue-2', 65.25, 69, 1],
    ],
  );
  assert.equal(kindFor('lecture.vtt'), 'text');
  assert.equal(kindFor('lecture.srt'), 'text');
});

test('overlapping chunks keep each turn once, by the chunk that owns its midpoint', () => {
  const turn = (id: string, start: number, end: number) => ({ id, text: id, start, end });
  // Chunk 0 owns 0–300 and hears up to 320; chunk 1 owns 300–611 and hears from 280.
  const first = ownedTurns(
    [turn('a', 10, 20), turn('b', 290, 305), turn('c', 302, 315)],
    { from: 0, to: 300 },
    false,
  );
  const second = ownedTurns(
    [turn('b', 290, 305), turn('c', 302, 315), turn('d', 600, 611)],
    { from: 300, to: 611 },
    true,
  );
  assert.deepEqual(
    [...first, ...second].map((t) => t.id),
    ['a', 'b', 'c', 'd'],
  );
  assert.equal(ownedTurns([turn('x', 0, 1)], {}, false).length, 1);
});
