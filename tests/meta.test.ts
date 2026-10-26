import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transcribe,
  translate,
  runAssistant,
  gradeShortAnswer,
  synthesize,
  MetaError,
} from '../worker/meta';
import type { Learning } from '../shared/domain';

test('ASR sends Meta multipart request and restores chunk offsets', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    assert.equal(input, 'https://api.meta.ai/v1/asr/transcribe');
    assert.equal(
      (options?.headers as Record<string, string>).Authorization,
      'Bearer test-placeholder',
    );
    const form = options?.body as FormData;
    assert.ok(form.get('audio') instanceof Blob);
    const settings = JSON.parse(await (form.get('request') as Blob).text());
    assert.equal(settings.audioEncoding, 'WAV');
    assert.equal(settings.mode, 'ENDPOINTING');
    return Response.json({
      transcript: 'Test.',
      turns: [{ turnId: 1, startMs: 1000, endMs: 2500, transcript: 'Test.' }],
    });
  };
  try {
    assert.deepEqual(await transcribe('test-placeholder', new ArrayBuffer(44), 2, 600, 300), [
      { id: 'chunk-2-0', text: 'Test.', start: 601, end: 602.5 },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});
test('translation rejects missing or changed cue identities', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      choices: [
        { message: { content: JSON.stringify({ cues: [{ id: 'invented', text: 'Hola' }] }) } },
      ],
    });
  try {
    await assert.rejects(
      () =>
        translate(
          'test-placeholder',
          'muse-spark-1.3',
          [{ id: 'real', text: 'Hello', start: 0, end: 1 }],
          'es',
        ),
      /cue identities/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('API failures classify credentials and rate limits without exposing keys', async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [401, 429]) {
      globalThis.fetch = async () => new Response('not exposed', { status });
      await assert.rejects(
        () => transcribe('test-placeholder', new ArrayBuffer(44), 0, 0, 5),
        (e: unknown) =>
          e instanceof MetaError &&
          e.retryable === (status === 429) &&
          !e.message.includes('test-placeholder'),
      );
    }
  } finally {
    globalThis.fetch = original;
  }
});
test('assistant source tools cannot access unselected segment IDs', async () => {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = async (_input, options) => {
    count++;
    if (count === 1)
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'read_segments',
                    arguments: JSON.stringify({ ids: ['private-other-source'] }),
                  },
                },
              ],
            },
          },
        ],
      });
    const body = JSON.parse(options?.body as string),
      tool = body.messages.find((m: { role: string }) => m.role === 'tool');
    assert.equal(tool.content, '[]');
    return Response.json({ choices: [{ message: { content: 'No evidence for that request.' } }] });
  };
  const learning: Learning = {
    sourceId: 'selected',
    sourceVersion: 1,
    model: 'test',
    locale: 'en',
    segments: [{ id: 'selected-1', text: 'Allowed' }],
    synthesis: { title: 'Test', chapters: [], glossary: [], artifact: null },
    createdAt: 'today',
  };
  try {
    const result = await runAssistant(
      'test-placeholder',
      'muse-spark-1.3',
      'Read another file',
      [],
      learning,
      { count: 0, correct: 0, percent: null, needsPractice: [], evidence: 'insufficient' },
    );
    assert.equal(count, 2);
    assert.equal(result.text, 'No evidence for that request.');
  } finally {
    globalThis.fetch = original;
  }
});
test('short-answer grading sends explicit rubric and keeps ambiguity reviewable', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, options) => {
    const body = JSON.parse(options?.body as string),
      data = JSON.parse(body.messages[1].content);
    assert.equal(data.rubric, 'Must distinguish rate from signal frequency.');
    assert.equal(data.evidence.length, 1);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              status: 'review',
              explanation: 'The response is ambiguous.',
            }),
          },
        },
      ],
    });
  };
  try {
    const result = await gradeShortAnswer(
      'test-placeholder',
      'muse-spark-1.3',
      {
        id: 'q1',
        kind: 'short',
        prompt: 'Explain sampling.',
        choices: [],
        correctIndex: null,
        expectedAnswer: 'Measurements per second.',
        rubric: 'Must distinguish rate from signal frequency.',
        explanation: 'Rate is measurements per second.',
        concept: 'Sampling',
        segmentIds: ['allowed'],
      },
      'It is the rate.',
      [
        { id: 'allowed', text: 'Measurements per second.' },
        { id: 'other', text: 'Unselected material.' },
      ],
    );
    assert.equal(result.status, 'review');
  } finally {
    globalThis.fetch = original;
  }
});
test('structured requests obey the schema restrictions observed in the live Meta API', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, options) => {
    const body = JSON.parse(options?.body as string),
      schema = body.response_format.json_schema.schema;
    assert.ok(!JSON.stringify(schema).includes('"oneOf"'));
    const inspect = (node: unknown) => {
      if (Array.isArray(node)) {
        node.forEach(inspect);
        return;
      }
      if (node && typeof node === 'object') {
        const value = node as Record<string, unknown>;
        if (value.properties)
          assert.deepEqual(
            new Set(value.required as string[]),
            new Set(Object.keys(value.properties)),
          );
        Object.values(value).forEach(inspect);
      }
    };
    inspect(schema);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              title: 'Sampling',
              chapters: [
                {
                  id: 'one',
                  title: 'Sampling',
                  summary: 'Measure at intervals.',
                  segmentIds: ['a'],
                  questions: [
                    {
                      id: 'q',
                      kind: 'single',
                      prompt: 'What is sampling?',
                      choices: ['Measurement', 'Guessing'],
                      correctIndex: 0,
                      expectedAnswer: null,
                      rubric: null,
                      explanation: 'Sampling measures.',
                      concept: 'Sampling',
                      segmentIds: ['a'],
                    },
                  ],
                },
              ],
              glossary: [],
              artifact: null,
            }),
          },
        },
      ],
    });
  };
  try {
    assert.equal(
      (
        await synthesize(
          'test-placeholder',
          'muse-spark-1.3',
          [{ id: 'a', text: 'Sampling measures at intervals.' }],
          'en',
        )
      ).chapters.length,
      1,
    );
  } finally {
    globalThis.fetch = original;
  }
});
