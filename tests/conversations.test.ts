import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionSchema, type Learning } from '../shared/domain';
import { conversationSchema, migrateConversations, sessionPreview } from '../shared/conversations';
import { runAssistant } from '../worker/meta';

const session = sessionSchema.parse({
  id: '9cc6dafd-deec-4781-8355-e3aba930257d',
  name: 'Reading',
  tabs: [],
  active: null,
  split: null,
  positions: {},
  notes: [],
  bookmarks: [],
  createdAt: '2026-10-26',
  conversations: {
    '56b051b5-fd75-474e-9e38-acfca62e1929': [
      { role: 'user', content: 'Original question' },
      { role: 'assistant', content: 'Original answer', tools: ['read_segments'] },
    ],
  },
});

test('migration preserves prior source histories with stable conversation identities', () => {
  const [conversation] = migrateConversations(session);
  assert.deepEqual(migrateConversations(session), [conversation]);
  assert.deepEqual(conversation.messages, Object.values(session.conversations)[0]);
  assert.equal(conversation.sessionId, session.id);
  const second = conversationSchema.parse({
    ...conversation,
    id: 'another',
    name: 'Different',
    messages: [],
  });
  assert.equal(sessionPreview(session, [], [conversation, second]).count, 2);
  assert.equal(sessionPreview(session, [], []).count, 2);
  assert.equal(sessionPreview(session, [], [conversation, second]).source, null);
});

test('conversation context rejects duplicate references and oversized histories', () => {
  const [conversation] = migrateConversations(session);
  assert.equal(
    conversationSchema.safeParse({
      ...conversation,
      sourceIds: [...conversation.sourceIds, ...conversation.sourceIds],
    }).success,
    false,
  );
  assert.equal(
    conversationSchema.safeParse({
      ...conversation,
      messages: Array(101).fill({ role: 'user', content: 'x' }),
    }).success,
    false,
  );
});

test('multi-source tutor scopes identical segment IDs to their selected source', async () => {
  const materials: Learning[] = ['first', 'second'].map((sourceId, i) => ({
    sourceId,
    sourceVersion: 1,
    locale: 'en',
    model: 'test',
    createdAt: 'today',
    segments: [{ id: 'section-1', text: `Evidence ${i}` }],
    synthesis: { title: 'Title', chapters: [], glossary: [], artifact: null },
  }));
  let calls = 0;
  const result = await runAssistant(
    'test-placeholder',
    'test-model',
    'Compare',
    [],
    materials,
    { count: 0, correct: 0, percent: 0, needsPractice: [], evidence: 'Recorded attempts only' },
    async (_input, options) => {
      const body = JSON.parse(options?.body as string);
      if (++calls === 1) {
        assert.match(body.messages[0].content, /first:section-1/);
        assert.match(body.messages[0].content, /second:section-1/);
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'call',
                    type: 'function',
                    function: {
                      name: 'read_segments',
                      arguments: JSON.stringify({
                        ids: ['second:section-1', 'unselected:section-1'],
                      }),
                    },
                  },
                ],
              },
            },
          ],
        });
      }
      const evidence = JSON.parse(
        body.messages.find((message: { role: string }) => message.role === 'tool').content,
      );
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].sourceId, 'second');
      return Response.json({ choices: [{ message: { content: 'Answer [second:section-1]' } }] });
    },
  );
  assert.equal(result.text, 'Answer [second:section-1]');
});

test('source-free tutor has no access to library segments', async () => {
  const result = await runAssistant(
    'test-placeholder',
    'test-model',
    'Help me plan',
    [],
    [],
    { count: 0, correct: 0, percent: 0, needsPractice: [], evidence: 'Recorded attempts only' },
    async (_input, options) => {
      const body = JSON.parse(options?.body as string);
      assert.match(body.messages[0].content, /cannot see library files/);
      assert.match(body.messages[0].content, /Available segment index: \[\]/);
      return Response.json({ choices: [{ message: { content: 'General study help' } }] });
    },
  );
  assert.equal(result.text, 'General study help');
});
