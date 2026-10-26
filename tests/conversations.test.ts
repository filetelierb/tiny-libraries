import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionSchema, type Learning } from '../shared/domain';
import {
  conversationSchema,
  migrateConversations,
  sessionPreview,
  questionContextSchema,
} from '../shared/conversations';
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

test('selected passage context retains its source identity and bounds without changing persistent references', () => {
  const [conversation] = migrateConversations(session);
  const context = questionContextSchema.parse({
    sourceId: '31c90f6e-93ee-4018-87ab-03964476cb22',
    sourceVersion: 2,
    sourceName: 'Reading.pdf',
    location: { page: 7, quote: 'Selected passage' },
  });
  const value = conversationSchema.parse({
    ...conversation,
    messages: [...conversation.messages, { role: 'user', content: 'Explain this', context }],
  });
  assert.deepEqual(value.sourceIds, conversation.sourceIds);
  assert.deepEqual(value.messages.at(-1)?.context, context);
  assert.equal(
    questionContextSchema.safeParse({ ...context, location: { quote: 'x'.repeat(8001) } }).success,
    false,
  );
  assert.equal(questionContextSchema.safeParse({ ...context, sourceVersion: 0 }).success, false);
});

test('one-question passage is readable through a scoped tool while other file evidence remains unavailable', async () => {
  const context = questionContextSchema.parse({
    sourceId: '31c90f6e-93ee-4018-87ab-03964476cb22',
    sourceVersion: 1,
    sourceName: 'Reading.pdf',
    location: { page: 2, quote: 'An 8 Hz signal requires more than 16 samples per second.' },
  });
  let calls = 0;
  const result = await runAssistant(
    'placeholder',
    'model',
    'Explain the limit',
    [{ role: 'user', content: 'Earlier question', context }],
    [],
    { count: 0, correct: 0, percent: 0, needsPractice: [], evidence: 'Recorded attempts only' },
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      if (++calls === 1) {
        assert.match(
          body.messages[0].content,
          /31c90f6e-93ee-4018-87ab-03964476cb22:selected-passage/,
        );
        assert.match(body.messages.at(-1).content, /Reading.pdf/);
        assert.match(body.messages[1].content, /Earlier question/);
        assert.deepEqual(Object.keys(body.messages[1]).sort(), ['content', 'role']);
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
                        ids: [`${context.sourceId}:selected-passage`, 'another-file:section-1'],
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
        body.messages.find((item: { role: string }) => item.role === 'tool').content,
      );
      assert.equal(evidence.length, 1);
      assert.equal(evidence[0].text, context.location.quote);
      assert.equal(evidence[0].page, 2);
      return Response.json({
        choices: [
          {
            message: { content: `The limit is above 16 Hz [${context.sourceId}:selected-passage]` },
          },
        ],
      });
    },
    context,
  );
  assert.match(result.text, /above 16 Hz/);
  assert.deepEqual(result.tools, ['read_segments']);
});

test('bookmark writes require an enabled action and evidence from the selected source', async () => {
  const material: Learning = {
    sourceId: 'selected',
    sourceVersion: 2,
    locale: 'en',
    model: 'test',
    createdAt: 'today',
    segments: [{ id: 'part', text: 'Evidence', start: 5, end: 9 }],
    synthesis: { title: 'Title', chapters: [], glossary: [], artifact: null },
  };
  const saved: unknown[] = [];
  let calls = 0;
  await runAssistant(
    'placeholder',
    'model',
    'Bookmark this section',
    [],
    [material],
    { count: 0, correct: 0, percent: 0, needsPractice: [], evidence: 'Recorded attempts only' },
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      if (++calls === 1) {
        assert.ok(
          body.tools.some(
            (tool: { function: { name: string } }) => tool.function.name === 'create_bookmark',
          ),
        );
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: ['unselected:part', 'selected:part'].map((segmentId, index) => ({
                  id: `call-${index}`,
                  type: 'function',
                  function: {
                    name: 'create_bookmark',
                    arguments: JSON.stringify({ segmentId, label: 'Saved point' }),
                  },
                })),
              },
            },
          ],
        });
      }
      const outputs = body.messages
        .filter((message: { role: string }) => message.role === 'tool')
        .map((message: { content: string }) => JSON.parse(message.content));
      assert.match(outputs[0].error, /not available/);
      assert.equal(outputs[1].id, 'saved');
      return Response.json({ choices: [{ message: { content: 'Saved the bookmark.' } }] });
    },
    undefined,
    {
      createBookmark: async (value) => {
        saved.push(value);
        return { id: 'saved' };
      },
    },
  );
  assert.equal(saved.length, 1);
  assert.deepEqual(saved[0], {
    sourceId: 'selected',
    sourceVersion: 2,
    segment: { id: 'selected:part', sourceId: 'selected', text: 'Evidence', start: 5, end: 9 },
    label: 'Saved point',
  });
  await runAssistant(
    'placeholder',
    'model',
    'Help',
    [],
    [material],
    { count: 0, correct: 0, percent: 0, needsPractice: [], evidence: 'Recorded attempts only' },
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      assert.ok(
        !body.tools.some(
          (tool: { function: { name: string } }) => tool.function.name === 'create_bookmark',
        ),
      );
      return Response.json({ choices: [{ message: { content: 'Help' } }] });
    },
  );
});

test('a tutor reply cannot create more than three distinct bookmark locations', async () => {
  const material: Learning = {
    sourceId: 'source',
    sourceVersion: 1,
    locale: 'en',
    model: 'test',
    createdAt: 'today',
    segments: Array.from({ length: 4 }, (_, i) => ({
      id: `part-${i}`,
      text: `Evidence ${i}`,
      start: i,
      end: i + 1,
    })),
    synthesis: { title: 'Title', chapters: [], glossary: [], artifact: null },
  };
  let calls = 0,
    writes = 0;
  await runAssistant(
    'placeholder',
    'model',
    'Save study locations',
    [],
    [material],
    { count: 0, correct: 0, percent: 0, needsPractice: [], evidence: 'Recorded attempts only' },
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      if (++calls === 1)
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: material.segments.map((segment, index) => ({
                  id: `call-${index}`,
                  type: 'function',
                  function: {
                    name: 'create_bookmark',
                    arguments: JSON.stringify({
                      segmentId: `source:${segment.id}`,
                      label: segment.text,
                    }),
                  },
                })),
              },
            },
          ],
        });
      const outputs = body.messages
        .filter((message: { role: string }) => message.role === 'tool')
        .map((message: { content: string }) => JSON.parse(message.content));
      assert.equal(outputs.length, 4);
      assert.match(outputs[3].error, /three/);
      return Response.json({ choices: [{ message: { content: 'Saved three locations.' } }] });
    },
    undefined,
    { createBookmark: async () => ({ id: `saved-${++writes}` }) },
  );
  assert.equal(writes, 3);
});
