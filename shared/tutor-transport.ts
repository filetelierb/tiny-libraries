import { z } from 'zod';
import { reasoningEffortSchema, tutorModelSchema } from './tutor-generation';
import { webCitationSchema } from './tutor-web';

export const completionCallSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1).max(160),
    arguments: z.string().max(65536),
  }),
});
export const completionMessageSchema = z
  .object({
    content: z.string().max(16000).nullable().optional(),
    tool_calls: z.array(completionCallSchema).max(8).optional(),
    webSources: z.array(webCitationSchema).max(40).optional(),
    webSearched: z.boolean().optional(),
  })
  .refine(
    (message) =>
      !message.tool_calls ||
      new Set(message.tool_calls.map((call) => call.id)).size === message.tool_calls.length,
    'Tool-call identities must be unique',
  );
export type CompletionMessage = z.infer<typeof completionMessageSchema>;
export const tutorCompletionSchema = z
  .object({
    model: tutorModelSchema,
    messages: z.array(z.unknown()).min(1).max(400),
    tools: z.array(z.unknown()).max(40).optional(),
    reasoning_effort: reasoningEffortSchema.exclude(['auto']).optional(),
    webSearch: z.literal(true).optional(),
    /** The agent may search the web when the library does not cover the question. */
    webAuto: z.literal(true).optional(),
    /** The Worker's tool endpoint for this reply, when the tutor may run as a Muse Code agent. */
    muse: z
      .object({
        url: z.string().url().max(500),
        token: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TutorCompletion = z.infer<typeof tutorCompletionSchema>;
export const transportStatusSchema = z.enum([
  'accepted',
  'running',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
]);
export const transportSnapshotSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  status: transportStatusSchema,
  sequence: z.number().int().nonnegative(),
  text: z.string().max(16000),
  toolNames: z.array(z.string().max(160)).max(8),
  result: completionMessageSchema.optional(),
  error: z.string().max(500).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TransportSnapshot = z.infer<typeof transportSnapshotSchema>;
export const transportTerminal = (status: TransportSnapshot['status']) =>
  !['accepted', 'running'].includes(status);
