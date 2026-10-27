import { z } from 'zod';
import { assessmentAnswerSchema, type AssessmentAnswer } from '../../shared/assessments';
export const assessmentOperationSchema = z.object({
  requestId: z.string().uuid(),
  questionId: z.string().min(1).max(200),
  expectedRevision: z.number().int().nonnegative(),
  ...assessmentAnswerSchema.shape,
});
const schema = z.object({
  step: z.number().int().min(0).max(59),
  responses: z
    .record(z.string().max(200), z.string().max(10000))
    .refine((v) => Object.keys(v).length <= 60),
  operation: assessmentOperationSchema.nullable(),
  conflict: z.boolean(),
});
export type AssessmentDraft = z.infer<typeof schema>;
export function readAssessmentDraft(key: string): AssessmentDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw || raw.length > 1000000) return null;
    const value = schema.safeParse(JSON.parse(raw));
    return value.success ? value.data : null;
  } catch {
    return null;
  }
}
export function saveAssessmentDraft(key: string, value: AssessmentDraft) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
export function acknowledgeAssessmentAnswer(
  draft: AssessmentDraft,
  requestId: string,
  answer: AssessmentAnswer,
  nextStep: number,
): AssessmentDraft {
  if (draft.operation?.requestId !== requestId || draft.operation.questionId !== answer.questionId)
    return draft;
  const responses = { ...draft.responses };
  delete responses[answer.questionId];
  return { ...draft, responses, operation: null, conflict: false, step: nextStep };
}
