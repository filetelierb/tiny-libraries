import { z } from 'zod';

export const locationSchema = z.object({
  page: z.number().int().positive().max(100000).optional(),
  seconds: z.number().nonnegative().max(86400).optional(),
  quote: z.string().max(8000).optional(),
});
export type SourceLocation = z.infer<typeof locationSchema>;
