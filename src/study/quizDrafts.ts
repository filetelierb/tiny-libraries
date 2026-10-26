import { z } from 'zod';
import type { PublicLearning } from '../../shared/domain';
import type { StudyChapter } from '../../shared/chapters';
const draftSchema = z.object({
  id: z.string().uuid(),
  index: z.number().int().nonnegative(),
  locked: z.boolean(),
  answers: z.record(z.string(), z.union([z.number().int().min(0).max(4), z.string().max(4000)])),
  requests: z.record(z.string(), z.string().uuid()),
  completed: z.boolean(),
});
export type QuizDraft = z.infer<typeof draftSchema>;
export const quizDraftKey = (sessionId: string, learning: PublicLearning, chapter: StudyChapter) =>
  `tl:quiz:${sessionId}:${learning.sourceId}:v${learning.sourceVersion}:${learning.createdAt}:${chapter.id}`;
export function readQuizDraft(key: string): QuizDraft | null {
  try {
    const value = draftSchema.safeParse(JSON.parse(localStorage.getItem(key) || 'null'));
    return value.success ? value.data : null;
  } catch {
    return null;
  }
}
export function saveQuizDraft(key: string, draft: QuizDraft) {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {}
}
export function newQuizDraft(chapter: StudyChapter): QuizDraft {
  return {
    id: crypto.randomUUID(),
    index: 0,
    locked: false,
    completed: false,
    answers: {},
    requests: Object.fromEntries(chapter.questions.map((q) => [q.id, crypto.randomUUID()])),
  };
}
