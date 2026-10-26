import { z } from 'zod';
import type { Attempt, Directory, Learning, Question, Segment, Source } from '../shared/domain';
import { sourceState } from '../shared/directories';
import type { GlossaryStorage, GlossaryStore as Store } from './glossary';

export class PracticeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export const attemptInputSchema = z
  .object({
    sourceId: z.string().uuid(),
    sourceVersion: z.number().int().positive().optional(),
    learningVersion: z.string().min(1).max(100).optional(),
    chapterId: z.string().min(1).max(240).optional(),
    runId: z.string().uuid().optional(),
    questionId: z.string().min(1).max(240),
    selected: z.number().int().min(0).max(4).optional(),
    answer: z.string().trim().min(1).max(4000).optional(),
    requestId: z.string().uuid(),
  })
  .refine((v) => (v.selected != null) !== !!v.answer, 'Choose one answer type');
type Input = z.infer<typeof attemptInputSchema>;
function sameAnswer(existing: Attempt, input: Input) {
  return (
    existing.sourceId === input.sourceId &&
    existing.questionId === input.questionId &&
    existing.selected === (input.selected ?? -1) &&
    existing.answer === input.answer &&
    (!input.sourceVersion || existing.sourceVersion === input.sourceVersion) &&
    (!input.learningVersion || existing.learningVersion === input.learningVersion) &&
    existing.runId === input.runId &&
    (!input.chapterId || existing.chapterId === input.chapterId)
  );
}
async function sourceQuestion(tx: Store, input: Input) {
  const source = await tx.get<Source>(`file:${input.sourceId}`),
    learning = await tx.get<Learning>(`learning:${input.sourceId}`);
  const directories = [...(await tx.list<Directory>({ prefix: 'directory:' })).values()];
  if (!source || sourceState(source, directories) === 'trash')
    throw new PracticeError('Restore the source before checking an answer.', 409);
  if (
    !learning ||
    learning.sourceVersion !== source.version ||
    (input.sourceVersion && source.version !== input.sourceVersion) ||
    (input.learningVersion && learning.createdAt !== input.learningVersion)
  )
    throw new PracticeError(
      'This study material changed. Reopen the chapter quiz before answering.',
      409,
    );
  const chapter = learning.synthesis.chapters.find(
    (c) =>
      (!input.chapterId || c.id === input.chapterId) &&
      c.questions.some((q) => q.id === input.questionId),
  );
  const question = chapter?.questions.find((q) => q.id === input.questionId);
  if (!question || !chapter) throw new PracticeError('Question not found in this chapter.', 404);
  return { learning, question, chapter };
}
export async function recordAttempt(
  storage: GlossaryStorage,
  raw: unknown,
  owner: string,
  grade: (
    question: Question,
    answer: string,
    segments: Segment[],
  ) => Promise<{ status: 'correct' | 'incorrect' | 'review'; explanation: string }>,
) {
  const input = attemptInputSchema.parse(raw),
    key = `attempt:${input.requestId}`,
    claimKey = `attempt-claim:${input.requestId}`;
  const fingerprint = JSON.stringify(input);
  const reservation = await storage.transaction(async (tx) => {
    const existing = await tx.get<Attempt>(key);
    if (existing) {
      if (!sameAnswer(existing, input))
        throw new PracticeError('This answer operation already contains a different answer.', 409);
      return { existing };
    }
    const pending = await tx.get<{ owner: string; fingerprint: string; until: number }>(claimKey);
    if (pending && pending.owner === owner && pending.until > Date.now())
      throw new PracticeError(
        'This answer is still being checked. Retry shortly to retrieve its saved result.',
        409,
      );
    const context = await sourceQuestion(tx, input);
    await tx.put(claimKey, { owner, fingerprint, until: Date.now() + 600000 });
    return { context };
  });
  if (reservation.existing) return reservation.existing;
  try {
    const { question, learning, chapter } = reservation.context!;
    let correct = false,
      pendingReview = false,
      explanation = question.explanation;
    if (question.kind === 'short') {
      if (!input.answer || input.selected != null) throw new PracticeError('Enter a short answer.');
      const result = await grade(question, input.answer, learning.segments);
      correct = result.status === 'correct';
      pendingReview = result.status === 'review';
      explanation = result.explanation;
    } else {
      if (input.selected == null || input.selected >= question.choices.length || input.answer)
        throw new PracticeError('Choose an available answer.');
      correct = input.selected === question.correctIndex;
    }
    const {
      correctIndex: _index,
      expectedAnswer: _answer,
      rubric: _rubric,
      explanation: _explanation,
      ...snapshot
    } = question;
    const attempt: Attempt = {
      id: input.requestId,
      sourceId: input.sourceId,
      sourceVersion: learning.sourceVersion,
      learningVersion: learning.createdAt,
      questionId: question.id,
      chapterId: chapter.id,
      ...(input.runId ? { runId: input.runId } : {}),
      question: snapshot,
      concept: question.concept,
      selected: input.selected ?? -1,
      ...(input.answer ? { answer: input.answer } : {}),
      correct,
      pendingReview,
      explanation,
      segmentIds: question.segmentIds,
      createdAt: new Date().toISOString(),
    };
    if (new TextEncoder().encode(JSON.stringify(attempt)).length > 120000)
      throw new PracticeError(
        'This answer result is too large to save. Existing attempts are unchanged.',
        409,
      );
    return await storage.transaction(async (tx) => {
      const current = await sourceQuestion(tx, {
        ...input,
        sourceVersion: learning.sourceVersion,
        learningVersion: learning.createdAt,
      });
      if (current.question.id !== question.id)
        throw new PracticeError('The question changed.', 409);
      const claim = await tx.get<{ owner: string; fingerprint: string }>(claimKey);
      if (claim?.owner !== owner || claim.fingerprint !== fingerprint)
        throw new PracticeError('This answer check was interrupted. Retry to recover it.', 409);
      await tx.put(key, attempt);
      return attempt;
    });
  } finally {
    await storage.transaction(async (tx) => {
      const claim = await tx.get<{ owner: string; fingerprint: string }>(claimKey);
      if (claim?.owner === owner && claim.fingerprint === fingerprint) await tx.delete(claimKey);
    });
  }
}
