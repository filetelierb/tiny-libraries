import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPTION_CHARS, captionCues } from '../shared/caption-cues';
import { captions } from '../shared/domain';

const turn =
  "for everyone uh I sort of feel like I have to issue I don't know if I call this a warning or just sort of a statement of principle. This is a very mathematical class, one of the holy trinity of classes in the information systems lab and electrical engineering. The department is split up into a number of laboratories along research lines.";

test('a long transcribed turn becomes short consecutive cues covering its whole time', () => {
  const cues = captionCues(turn, 60, 90);
  assert.ok(cues.length >= 4);
  assert.ok(cues.every((cue) => cue.text.length <= CAPTION_CHARS));
  assert.equal(cues[0].start, 60);
  assert.equal(cues.at(-1)!.end, 90);
  for (let i = 1; i < cues.length; i++) assert.equal(cues[i].start, cues[i - 1].end);
  assert.equal(cues.map((cue) => cue.text).join(' '), turn);
  // A sentence end closes a cue once it is half full.
  assert.ok(cues.some((cue) => cue.text.endsWith('statement of principle.')));
});

test('short passages stay one cue, and empty text gives none', () => {
  assert.deepEqual(captionCues('  Hello   there. ', 1, 2), [
    { start: 1, end: 2, text: 'Hello there.' },
  ]);
  assert.deepEqual(captionCues('   ', 1, 2), []);
});

test('generated captions number split cues in order and keep their timing', () => {
  const vtt = captions([{ id: 'turn-1', text: turn, start: 60, end: 90 }]),
    srt = captions([{ id: 'turn-1', text: turn, start: 60, end: 90 }], true);
  assert.match(vtt, /^WEBVTT\n\nturn-1-1\n00:01:00\.000 --> /);
  assert.match(vtt, / --> 00:01:30\.000\n[^\n]+\n$/);
  assert.match(srt, /^1\n00:01:00,000 --> /);
  assert.ok((vtt.match(/ --> /g) || []).length >= 4);
});
