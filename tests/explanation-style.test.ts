import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactExplanationStyle,
  definitionStyle,
  explanationStyle,
} from '../shared/explanation-style';
import { createTutorAgent } from '../worker/tutor-agent';
import { planTutorArtifact, writeTutorArtifactChapter } from '../worker/meta';

const system = (messages: Array<{ role: string; content?: unknown }>) =>
  messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n');

test('the tutor explains and defines concepts with the comparison method', async () => {
  const agent = await createTutorAgent({
    model: 'muse-spark-1.3',
    prompt: 'What is the difference between energy and power spectral density?',
    history: [],
    learning: null,
    review: { count: 0, correct: 0, percent: null, needsPractice: [], evidence: '' },
    canSaveConcept: true,
  });
  const prompt = system(agent.request().messages as Array<{ role: string; content?: unknown }>);
  assert.ok(prompt.includes(explanationStyle));
  assert.ok(prompt.includes(definitionStyle));
});

test('artifact plans and chapters are written with the comparison method', async () => {
  const prompts: string[] = [];
  const transport = (async (_url: unknown, options?: RequestInit) => {
    prompts.push(system(JSON.parse(String(options?.body)).messages));
    throw new Error('captured');
  }) as typeof fetch;
  const request = {
    request: 'Compare ESD and PSD',
    goal: 'understand' as const,
    length: 'short' as const,
    sourceIds: [crypto.randomUUID()],
  };
  const plan = {
    title: 'ESD and PSD',
    guidingQuestion: 'When do I use each?',
    introduction: 'Intro.',
    chapters: [
      { title: 'A', objective: 'o', keyIdeas: ['k'], widgets: [], segmentIds: [] },
      { title: 'B', objective: 'o', keyIdeas: ['k'], widgets: [], segmentIds: [] },
    ],
  };
  await assert.rejects(planTutorArtifact('key', 'm', 'es', request, [], null, transport));
  await assert.rejects(
    writeTutorArtifactChapter('key', 'm', 'es', request, plan, 0, [], undefined, transport),
  );
  assert.equal(prompts.length, 2);
  for (const prompt of prompts) assert.ok(prompt.includes(artifactExplanationStyle));
});
