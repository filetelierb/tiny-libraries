import { z } from 'zod';
import {
  artifactSchema,
  fold,
  questionSchema,
  validateSynthesis,
  type Attempt,
  type Catalog,
  type Locale,
  type PublicQuestion,
  type Segment,
  type StudySession,
} from './domain';
import { sourceState } from './directories';

export type ReviewScope = 'source' | 'session' | 'library';
export function reviewSources(
  catalog: Catalog,
  session: StudySession,
  scope: ReviewScope,
  activeId?: string,
) {
  const ids = new Set(
    scope === 'source'
      ? activeId
        ? [activeId]
        : []
      : scope === 'library'
        ? catalog.files.map((f) => f.id)
        : [
            ...(session.resourceTabs?.flatMap((t) => t.sources) || session.tabs),
            ...session.notes.map((n) => n.sourceId),
            ...session.bookmarks.map((b) => b.sourceId),
            ...catalog.conversations
              .filter((c) => c.sessionId === session.id)
              .flatMap((c) => c.sourceIds),
          ],
  );
  return catalog.files.filter(
    (f) => ids.has(f.id) && sourceState(f, catalog.directories) !== 'trash',
  );
}
export function reviewGroups(attempts: Attempt[]) {
  const groups = new Map<string, { sourceId: string; concept: string; attempts: Attempt[] }>();
  for (const attempt of attempts) {
    const key = `${attempt.sourceId}:${fold(attempt.concept)}`;
    if (!groups.has(key))
      groups.set(key, { sourceId: attempt.sourceId, concept: attempt.concept, attempts: [] });
    groups.get(key)!.attempts.push(attempt);
  }
  return [...groups.values()];
}
const text = z.string().trim().min(1).max(4000);
export const reinforcementPlanSchema = z.object({
  title: text,
  introduction: text,
  objectives: z.array(text).min(1).max(5),
  findings: z
    .array(
      z.object({
        attemptIds: z.array(z.string().uuid()).min(1).max(20),
        explanation: text,
        segmentIds: z.array(z.string()).min(1).max(8),
      }),
    )
    .min(1)
    .max(8),
  lessons: z
    .array(
      z.object({
        title: text,
        body: text,
        evidence: z
          .array(z.object({ segmentId: z.string(), quote: z.string().trim().min(1).max(2000) }))
          .min(1)
          .max(6),
      }),
    )
    .min(1)
    .max(3),
  questions: z
    .array(
      questionSchema.extend({
        id: z.string().min(1).max(80),
        prompt: text,
        choices: z.array(z.string().min(1).max(1000)).max(5),
        explanation: text,
        concept: z.string().min(1).max(240),
        segmentIds: z.array(z.string()).min(1).max(8),
      }),
    )
    .min(2)
    .max(4),
  artifact: artifactSchema.nullable(),
});
export type ReinforcementPlan = z.infer<typeof reinforcementPlanSchema>;
export type ReinforcementContext = {
  sourceId: string;
  sourceVersion: number;
  sourceName: string;
  learningVersion: string;
  concept: string;
  attempts: Attempt[];
  segments: Segment[];
};
export type Reinforcement = ReinforcementContext & {
  id: string;
  groupId: string;
  version: number;
  sessionId: string;
  createdAt: string;
  status: 'running' | 'ready' | 'failed' | 'interrupted';
  locale: Locale;
  model: string;
  plan: ReinforcementPlan | null;
  error?: string;
};
export type PublicReinforcement = Omit<Reinforcement, 'plan'> & {
  plan: (Omit<ReinforcementPlan, 'questions'> & { questions: PublicQuestion[] }) | null;
};
export function publicReinforcement(record: Reinforcement): PublicReinforcement {
  return {
    ...record,
    plan: record.plan
      ? {
          ...record.plan,
          questions: record.plan.questions.map(
            ({ correctIndex: _c, explanation: _e, expectedAnswer: _a, rubric: _r, ...question }) =>
              question,
          ),
        }
      : null,
  };
}
export function validateReinforcement(
  raw: unknown,
  context: ReinforcementContext,
): ReinforcementPlan {
  const value = reinforcementPlanSchema.parse(raw),
    attempts = new Set(context.attempts.map((a) => a.id)),
    segments = new Set(context.segments.map((s) => s.id)),
    covered = new Set<string>();
  for (const finding of value.findings) {
    if (
      finding.attemptIds.some((id) => !attempts.has(id)) ||
      finding.segmentIds.some((id) => !segments.has(id))
    )
      throw new Error('A reinforcement finding cites unavailable evidence.');
    finding.attemptIds.forEach((id) => covered.add(id));
  }
  if (context.attempts.some((a) => !covered.has(a.id)))
    throw new Error('The reinforcement does not explain every selected attempt.');
  for (const lesson of value.lessons)
    for (const evidence of lesson.evidence) {
      if (!context.segments.find((s) => s.id === evidence.segmentId)?.text.includes(evidence.quote))
        throw new Error('A reinforcement lesson cites an unavailable source quote.');
    }
  if (
    value.questions.some((q) =>
      context.attempts.some((a) => a.question && fold(a.question.prompt) === fold(q.prompt)),
    )
  )
    throw new Error(
      'Reinforcement questions must be new questions, distinct from the selected attempts.',
    );
  const validated = validateSynthesis(
    {
      title: value.title,
      chapters: [
        {
          id: 'practice',
          title: value.title,
          summary: value.introduction,
          segmentIds: [...segments],
          questions: value.questions,
        },
      ],
      glossary: [],
      artifact: value.artifact,
    },
    context.segments,
  );
  return { ...value, questions: validated.chapters[0].questions, artifact: validated.artifact };
}
export function reinforcementLearning(
  record: PublicReinforcement,
): import('./domain').PublicLearning | null {
  if (!record.plan) return null;
  return {
    sourceId: record.sourceId,
    sourceVersion: record.sourceVersion,
    createdAt: record.learningVersion,
    locale: record.locale,
    model: record.model,
    segments: record.segments,
    synthesis: {
      title: record.plan.title,
      glossary: [],
      artifact: record.plan.artifact,
      chapters: [
        {
          id: record.id,
          title: record.plan.title,
          summary: record.plan.introduction,
          segmentIds: record.segments.map((s) => s.id),
          questions: record.plan.questions,
        },
      ],
    },
  };
}
