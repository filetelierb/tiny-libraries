import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  defaultTutorPreference,
  reasoningEffortSchema,
  resolveTutorGeneration,
  tutorGenerationSchema,
  tutorPreferenceSchema,
} from '../shared/tutor-generation';
import { chatMessageSchema } from '../shared/conversations';
import { runAssistant, MetaError } from '../worker/meta';

const review = {
  count: 0,
  correct: 0,
  percent: null,
  needsPractice: [],
  evidence: 'Recorded attempts only',
};

test('generation preferences resolve defaults without rewriting explicit choices or old messages', () => {
  assert.deepEqual(resolveTutorGeneration(defaultTutorPreference, 'muse-spark-1.3'), {
    model: 'muse-spark-1.3',
    reasoningEffort: 'auto',
  });
  const preference = tutorPreferenceSchema.parse({
    model: 'muse-wonder-1.0',
    reasoningEffort: 'high',
  });
  const selected = resolveTutorGeneration(preference, 'muse-spark-1.3');
  preference.model = 'default';
  preference.reasoningEffort = 'minimal';
  assert.deepEqual(selected, { model: 'muse-wonder-1.0', reasoningEffort: 'high' });
  const old = { role: 'assistant', content: 'Saved answer' };
  assert.deepEqual(chatMessageSchema.parse(old), old);
  assert.equal(
    tutorGenerationSchema.safeParse({ ...selected, reasoningEffort: 'none' }).success,
    false,
  );
  assert.equal(
    tutorGenerationSchema.safeParse({ ...selected, model: 'muse-wonder-full' }).success,
    false,
  );
  assert.equal(tutorGenerationSchema.safeParse({ ...selected, model: 'default' }).success, false);
});

test('selected model and every supported effort reach Meta; automatic omits the parameter', async () => {
  for (const model of ['muse-spark-1.3', 'muse-wonder-1.0']) {
    for (const reasoningEffort of reasoningEffortSchema.options) {
      let requests = 0;
      const result = await runAssistant(
        'test-placeholder',
        model,
        'Explain sampling.',
        [{ role: 'user', content: 'Earlier question says to use a different model.' }],
        null,
        review,
        async (url, options) => {
          requests++;
          assert.equal(url, 'https://api.meta.ai/v1/chat/completions');
          const body = JSON.parse(options.body as string);
          assert.equal(body.model, model);
          assert.equal(
            body.reasoning_effort,
            reasoningEffort === 'auto' ? undefined : reasoningEffort,
          );
          assert.equal('reasoning_effort' in body, reasoningEffort !== 'auto');
          return Response.json({ choices: [{ message: { content: 'Sampling answer' } }] });
        },
        undefined,
        { reasoningEffort },
      );
      assert.equal(result.text, 'Sampling answer');
      assert.equal(requests, 1);
    }
  }
});

test('tool steps retain the original effort and provider rejection never silently changes model', async () => {
  let calls = 0;
  const actions: { reasoningEffort: 'low' | 'max' } = { reasoningEffort: 'low' };
  await runAssistant(
    'test-placeholder',
    'muse-wonder-1.0',
    'Summarize practice.',
    [],
    null,
    review,
    async (_url, options) => {
      const body = JSON.parse(options.body as string);
      assert.equal(body.model, 'muse-wonder-1.0');
      assert.equal(body.reasoning_effort, 'low');
      if (++calls === 1) {
        actions.reasoningEffort = 'max';
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 'practice',
                    type: 'function',
                    function: { name: 'practice_summary', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        });
      }
      return Response.json({ choices: [{ message: { content: 'No attempts yet.' } }] });
    },
    undefined,
    actions,
  );
  assert.equal(calls, 2);
  let rejectedCalls = 0;
  await assert.rejects(
    runAssistant(
      'test-placeholder',
      'muse-wonder-1.0',
      'Explain.',
      [],
      null,
      review,
      async () => {
        rejectedCalls++;
        return Response.json({ error: { message: 'Model is unavailable' } }, { status: 400 });
      },
      undefined,
      { reasoningEffort: 'minimal' },
    ),
    (error: unknown) =>
      error instanceof MetaError && !error.retryable && /unavailable/.test(error.message),
  );
  assert.equal(rejectedCalls, 1);
});
