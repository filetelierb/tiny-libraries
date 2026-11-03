import { z } from 'zod';

/**
 * Chip-inserted mentions carry the resolved id + kind + display label for each chip the
 * student inserted into the composer this turn. The order follows the chip order in the
 * draft (duplicates preserved) so a tool can resolve the N-th `@label` by index instead of
 * substring-matching the candidate catalog.
 */
export const mentionRecordSchema = z.object({
  kind: z.enum(['file', 'concept']),
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(240),
});
export type MentionRecord = z.infer<typeof mentionRecordSchema>;
export const mentionRecordsSchema = z.array(mentionRecordSchema).max(80);
