import { z } from 'zod';
import { questionContextSchema, type ChatMessage, type Conversation } from './conversations';
import { conceptReferencesSchema } from './tutor-context';
import { attachmentIdsSchema } from './tutor-attachments';
import { tutorGenerationSchema, type TutorGeneration } from './tutor-generation';

const referencesSchema = z
  .array(z.string().uuid())
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length);
export const tutorTurnInputSchema = z.object({
  requestId: z.string().uuid(),
  prompt: z.string().trim().min(1).max(8000),
  context: questionContextSchema.optional(),
  concepts: conceptReferencesSchema.default([]),
  attachments: attachmentIdsSchema.default([]),
  generation: tutorGenerationSchema.optional(),
  references: referencesSchema.optional(),
});
export type TutorTurnInput = z.infer<typeof tutorTurnInputSchema>;
export const turnStatusSchema = z.enum([
  'queued',
  'editing',
  'running',
  'completed',
  'stopped',
  'failed',
  'interrupted',
  'cancelled',
  'steering',
  'steered',
]);
export type TutorTurnStatus = z.infer<typeof turnStatusSchema>;
export type TurnScope = {
  references: Array<{ id: string; version: number; prepared: string }>;
  context?: TutorTurnInput['context'];
  concepts: TutorTurnInput['concepts'];
  attachments: string[];
};
export type TurnIntent = {
  input: TutorTurnInput;
  userMessage: ChatMessage;
  generation: TutorGeneration;
  contextObject: string;
  scope: TurnScope;
};
export type TurnRecord = {
  id: string;
  conversationId: string;
  ordinal: number;
  revision: number;
  intentRevision: number;
  acceptanceFingerprint: string;
  intentObject: string;
  generation: TutorGeneration;
  status: TutorTurnStatus;
  queueOrdinal?: number;
  attempt: number;
  phase?: 'initialize' | 'model' | 'tools';
  workVersion: number;
  initialObject?: string;
  checkpointObject?: string;
  providerId?: string;
  providerSequence?: number;
  providerStart?: 'unsubmitted' | 'submitting' | 'accepted';
  retiredProviders?: string[];
  modelCalls: number;
  partial: string;
  toolNames: string[];
  stopRequested: boolean;
  steering: string[];
  parentId?: string;
  effectiveGeneration?: TutorGeneration;
  blocking: boolean;
  error?: string;
  startedAt?: string;
  deadline?: number;
  createdAt: string;
  updatedAt: string;
};
export const turnActionSchema = z.object({
  operationId: z.string().uuid(),
  revision: z.number().int().positive(),
  action: z.enum(['edit', 'save', 'resume', 'cancel', 'retry', 'stop', 'steer']),
  prompt: z.string().trim().min(1).max(8000).optional(),
  generation: tutorGenerationSchema.optional(),
});
export type TurnAction = z.infer<typeof turnActionSchema>;
export type TurnView = {
  id: string;
  status: TutorTurnStatus;
  revision: number;
  prompt: string;
  generation: TutorGeneration;
  effectiveGeneration?: TutorGeneration;
  attachments: ChatMessage['attachments'];
  context?: ChatMessage['context'];
  attempt: number;
  partial: string;
  toolNames: string[];
  stopRequested: boolean;
  canSteer: boolean;
  canEdit: boolean;
  canRetry: boolean;
  error?: string;
};
export type ConversationRunState = {
  sequence: number;
  active: TurnView | null;
  outbox: TurnView[];
  outboxCursor?: string | null;
};
export type ConversationDetail = Conversation & {
  pending: boolean;
  pendingGeneration?: TutorGeneration;
  runState?: ConversationRunState;
  acceptedRequestId?: string;
};

export async function tutorFingerprint(value: unknown) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
/** Preserve the original request format when optional newer controls are absent. */
export function turnInputFingerprint(input: TutorTurnInput) {
  return tutorFingerprint({
    prompt: input.prompt,
    context: input.context,
    concepts: input.concepts,
    attachments: input.attachments,
    ...(input.generation ? { generation: input.generation } : {}),
    ...(input.references ? { references: input.references } : {}),
  });
}
export function turnSteeringCompatible(queued: TurnScope, active: TurnScope) {
  if (queued.attachments.length) return false;
  const sorted = (scope: TurnScope) =>
    [...scope.references].sort((a, b) => a.id.localeCompare(b.id));
  return (
    JSON.stringify(sorted(queued)) === JSON.stringify(sorted(active)) &&
    (!queued.context || JSON.stringify(queued.context) === JSON.stringify(active.context)) &&
    queued.concepts.every((concept) =>
      active.concepts.some((value) => value.id === concept.id && value.version === concept.version),
    )
  );
}
