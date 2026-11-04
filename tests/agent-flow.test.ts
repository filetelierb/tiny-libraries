import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentFlow } from '../src/AgentFlow';
import { dictionaries } from '../src/i18n';
import type { AgentEvent } from '../shared/agent-events';

const fileA = '00000000-0000-4000-8000-00000000000a',
  fileB = '00000000-0000-4000-8000-00000000000b';
const at = (minute: number) => `2026-11-04T10:${String(minute).padStart(2, '0')}:00.000Z`;
const event = (id: string, minute: number, rest: Partial<AgentEvent>): AgentEvent => ({
  id,
  at: at(minute),
  project: 'default' as AgentEvent['project'],
  tool: 'preparation',
  action: 'library.upload',
  summary: id,
  ...rest,
});
const lanes = (events: AgentEvent[]) =>
  [
    ...renderToStaticMarkup(
      createElement(AgentFlow, { events, locale: 'en', t: dictionaries.en }),
    ).matchAll(/<section[^>]*aria-label="([^"]*)"/g),
  ].map((match) => match[1]);

const started = [
  event('assessment', 3, { tool: 'assessment', action: 'assessment.plan.start' }),
  event('b', 2, { fileId: fileB, fileName: 'b.pdf' }),
  event('tutor', 1, {
    tool: 'tutor',
    action: 'tutor.turn.start',
    conversationId: 'chat',
    conversationName: 'Chat',
    detail: 'turn 1234abcd',
  }),
  event('a', 0, { fileId: fileA, fileName: 'a.mp4' }),
];

test('lanes of every kind run from the most recently started to the oldest', () => {
  assert.deepEqual(lanes(started), ['Review test', 'b.pdf', 'Chat', 'a.mp4']);
});

test('progress on an older lane does not move it', () => {
  const progress = event('a-progress', 9, {
    fileId: fileA,
    fileName: 'a.mp4',
    action: 'transcribe.chunk',
    progress: { current: 1, total: 4 },
  });
  assert.deepEqual(lanes([progress, ...started]), lanes(started));
});
