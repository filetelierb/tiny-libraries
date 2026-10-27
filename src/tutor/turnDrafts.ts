import { z } from 'zod';
import { tutorTurnInputSchema, type ConversationDetail } from '../../shared/tutor-turns';
import type { WebDraft } from '../../shared/tutor-web';

export const tutorDraftSchema = z.object({ text: z.string().max(8000), stamp: z.string().uuid() });
export type TutorDraft = z.infer<typeof tutorDraftSchema>;
export const tutorSubmissionSchema = z.object({
  format: z.literal(2),
  payload: tutorTurnInputSchema,
  draftStamp: z.string().uuid().optional(),
  emptyStamp: z.string().uuid().optional(),
  restoredStamp: z.string().uuid().optional(),
  webStamp: z.string().uuid().optional(),
  emptyWebStamp: z.string().uuid().optional(),
  restoredWebStamp: z.string().uuid().optional(),
  conceptStamp: z.string().optional(),
  contextStamp: z.string().optional(),
  attachmentStamps: z.record(z.string(), z.string()).optional(),
  error: z.string().max(500).optional(),
  rejected: z.boolean().optional(),
});
export type TutorSubmission = z.infer<typeof tutorSubmissionSchema>;
export function acknowledgeWebDraft(current: WebDraft, sent: TutorSubmission): WebDraft {
  return [sent.webStamp, sent.emptyWebStamp, sent.restoredWebStamp].includes(current.stamp)
    ? { enabled: false, stamp: crypto.randomUUID() }
    : current;
}
export function restoreWebDraft(current: WebDraft, sent: TutorSubmission, restoredText: boolean) {
  if (!restoredText || current.stamp !== sent.emptyWebStamp)
    return { draft: current, submission: sent };
  const draft = { enabled: sent.payload.webSearch === true, stamp: crypto.randomUUID() };
  return { draft, submission: { ...sent, restoredWebStamp: draft.stamp } };
}
export function readTutorDraft(serialized: string, previousText: string): TutorDraft {
  try {
    const parsed = tutorDraftSchema.safeParse(JSON.parse(serialized));
    if (parsed.success) return parsed.data;
  } catch {}
  return { text: previousText.slice(0, 8000), stamp: crypto.randomUUID() };
}
export function readTutorSubmission(serialized: string): TutorSubmission | null {
  try {
    const value = JSON.parse(serialized),
      parsed = tutorSubmissionSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    // Previously stored requests retain their exact body shape and have no provable draft stamp.
    const payload = tutorTurnInputSchema.safeParse(value);
    if (payload.success)
      return {
        format: 2,
        payload: payload.data,
        conceptStamp: typeof value.conceptStamp === 'string' ? value.conceptStamp : undefined,
        contextStamp: typeof value.contextStamp === 'string' ? value.contextStamp : undefined,
      };
  } catch {}
  return null;
}
export function acknowledgeTutorDraft(current: TutorDraft, sent: TutorSubmission): TutorDraft {
  if (![sent.draftStamp, sent.emptyStamp, sent.restoredStamp].includes(current.stamp))
    return current;
  return { text: '', stamp: crypto.randomUUID() };
}
export function acknowledgeTutorAttachments<T extends { id: string }>(
  current: T[],
  stamps: Record<string, string>,
  sent: TutorSubmission,
) {
  return current.filter(
    (item) =>
      !sent.payload.attachments.includes(item.id) ||
      !sent.attachmentStamps?.[item.id] ||
      stamps[item.id] !== sent.attachmentStamps[item.id],
  );
}
export function restoreTutorDraft(
  current: TutorDraft,
  sent: TutorSubmission,
  unchangedContext: boolean,
) {
  if (current.stamp !== sent.emptyStamp || current.text || !unchangedContext)
    return { draft: current, submission: sent };
  const draft = { text: sent.payload.prompt, stamp: crypto.randomUUID() };
  return { draft, submission: { ...sent, restoredStamp: draft.stamp } };
}
export function newerConversation(
  current: ConversationDetail | undefined,
  incoming: ConversationDetail,
) {
  if (!current) return incoming;
  const before = current.runState?.sequence || 0,
    after = incoming.runState?.sequence || 0;
  if (after < before || (after === before && incoming.updatedAt < current.updatedAt))
    return current;
  return incoming;
}
export function conversationHasWork(value: Partial<ConversationDetail>) {
  return (
    value.pending === true ||
    !!value.runState?.outbox.some((turn) => turn.status === 'queued' || turn.status === 'steering')
  );
}
