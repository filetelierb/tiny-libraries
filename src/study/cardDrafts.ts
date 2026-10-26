import { z } from 'zod';
import { cardReviewInput, type CardReview } from '../../shared/flashcards';

const draftSchema = z.object({
  queue: z.array(z.string().uuid()).max(1000),
  done: z.number().int().nonnegative(),
  revealed: z.boolean(),
  operation: cardReviewInput.extend({ deckId: z.string().uuid() }).nullable(),
  conflict: z.boolean(),
});
export type CardDraft = z.infer<typeof draftSchema>;
export function completeCardDraft(draft: CardDraft, review: CardReview): CardDraft {
  if (draft.operation?.requestId !== review.id || draft.queue[0] !== review.cardId) return draft;
  return {
    queue:
      review.grade === 'again' ? [...draft.queue.slice(1), review.cardId] : draft.queue.slice(1),
    done: draft.done + (review.grade === 'again' ? 0 : 1),
    revealed: false,
    operation: null,
    conflict: false,
  };
}
export function readCardDraft(key: string): CardDraft | null {
  try {
    const value = draftSchema.safeParse(JSON.parse(localStorage.getItem(key) || 'null'));
    return value.success ? value.data : null;
  } catch {
    return null;
  }
}
export function saveCardDraft(key: string, value: CardDraft) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
