import { z } from 'zod';

export const tutorModelSchema = z.enum(['muse-spark-1.3', 'muse-wonder-1.0']);
export const reasoningEffortSchema = z.enum([
  'auto',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export const tutorGenerationSchema = z.object({
  model: tutorModelSchema,
  reasoningEffort: reasoningEffortSchema,
});
export type TutorGeneration = z.infer<typeof tutorGenerationSchema>;
export const tutorPreferenceSchema = tutorGenerationSchema.extend({
  model: z.union([z.literal('default'), tutorModelSchema]),
});
export type TutorPreference = z.infer<typeof tutorPreferenceSchema>;
export const defaultTutorPreference: TutorPreference = {
  model: 'default',
  reasoningEffort: 'auto',
};
export function resolveTutorGeneration(
  preference: TutorPreference | undefined,
  defaultModel: string,
): TutorGeneration {
  return tutorGenerationSchema.parse({
    model: preference?.model && preference.model !== 'default' ? preference.model : defaultModel,
    reasoningEffort: preference?.reasoningEffort || 'auto',
  });
}
export function tutorModelName(model: string) {
  return model === 'muse-wonder-1.0'
    ? 'Muse Wonder 1.0'
    : model === 'muse-spark-1.3'
      ? 'Muse Spark 1.3'
      : model;
}
export function reasoningParameter(effort: TutorGeneration['reasoningEffort']) {
  return effort === 'auto' ? {} : { reasoning_effort: effort };
}
