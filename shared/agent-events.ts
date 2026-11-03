import { z } from 'zod';
import { projectIdSchema } from './projects';

/**
 * A step the library's AI tools or the Librarian agent are taking. The home library keeps a
 * ring buffer of the latest ones so the Agent activity panel can show them in real time.
 */
export const agentToolSchema = z.enum(['preparation', 'tutor', 'glossary', 'flashcards']);
export type AgentTool = z.infer<typeof agentToolSchema>;

export const agentEventSchema = z.object({
  id: z.string().min(1).max(80),
  at: z.string(),
  project: projectIdSchema,
  tool: agentToolSchema,
  /** `tool.action`, dotted. Known actions have labels in `src/i18n.ts`. */
  action: z.string().min(1).max(120),
  fileId: z.string().uuid().optional(),
  fileName: z.string().max(240).optional(),
  summary: z.string().max(400),
  detail: z.string().max(2000).optional(),
  progress: z
    .object({ current: z.number().int().nonnegative(), total: z.number().int().positive() })
    .optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;

/** The newest events the panel keeps on screen. */
export const AGENT_EVENT_LIMIT = 500;
