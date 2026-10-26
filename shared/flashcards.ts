import { z } from 'zod';
import type { Learning, Locale } from './domain';

export const cardPlanSchema = z.object({
  cards: z
    .array(
      z.object({
        front: z.string().trim().min(3).max(300),
        back: z.string().trim().min(1).max(1200),
        evidence: z
          .array(
            z.object({ segmentId: z.string().min(1), quote: z.string().trim().min(1).max(2000) }),
          )
          .min(1)
          .max(6),
      }),
    )
    .min(3)
    .max(8),
});
export type CardPlan = z.infer<typeof cardPlanSchema>;
export const cardGrades = ['again', 'hard', 'good', 'easy'] as const;
export type CardGrade = (typeof cardGrades)[number];
export type CardSchedule = {
  revision: number;
  intervalDays: number;
  ease: number;
  reps: number;
  lapses: number;
  dueAt: string;
  updatedAt: string;
};
export type Flashcard = CardPlan['cards'][number] & { id: string };
export type CardDeck = {
  id: string;
  sourceId: string;
  sourceVersion: number;
  learningVersion: string;
  chapterId: string;
  title: string;
  locale: Locale;
  model: string;
  createdAt: string;
  status: 'queued' | 'running' | 'ready' | 'failed' | 'interrupted';
  cards: Flashcard[];
  error?: string;
};
export type CardView = Flashcard & { schedule: CardSchedule | null };
export type DeckView = Omit<CardDeck, 'cards'> & { cards: CardView[] };
export type CardReview = {
  id: string;
  deckId: string;
  cardId: string;
  grade: CardGrade;
  expectedRevision: number;
  schedule: CardSchedule;
  createdAt: string;
};
export const cardReviewInput = z.object({
  requestId: z.string().uuid(),
  cardId: z.string().uuid(),
  grade: z.enum(cardGrades),
  expectedRevision: z.number().int().nonnegative(),
});
export function scheduleCard(
  previous: CardSchedule | null,
  grade: CardGrade,
  now = new Date(),
): CardSchedule {
  const old = previous || { revision: 0, intervalDays: 0, ease: 2.5, reps: 0, lapses: 0 };
  const ease = Math.min(
    3,
    Math.max(1.3, old.ease + { again: -0.2, hard: -0.15, good: 0, easy: 0.15 }[grade]),
  );
  const reps = grade === 'again' ? 0 : old.reps + 1;
  const base = reps === 1 ? 1 : reps === 2 ? 3 : old.intervalDays * ease;
  const intervalDays =
    grade === 'again'
      ? 0
      : Math.max(
          grade === 'hard' ? 0.5 : 1,
          Math.round(
            Math.min(365, base * (grade === 'hard' ? 0.6 : grade === 'easy' ? 1.4 : 1)) * 10,
          ) / 10,
        );
  return {
    revision: old.revision + 1,
    intervalDays,
    ease,
    reps,
    lapses: old.lapses + (grade === 'again' ? 1 : 0),
    updatedAt: now.toISOString(),
    dueAt: new Date(
      now.getTime() + (grade === 'again' ? 600000 : intervalDays * 86400000),
    ).toISOString(),
  };
}
export const cardDue = (card: CardView, now = Date.now()) =>
  !card.schedule || Date.parse(card.schedule.dueAt) <= now;
export function validateCardPlan(raw: unknown, learning: Learning, chapterId: string): CardPlan {
  const value = cardPlanSchema.parse(raw),
    chapter = learning.synthesis.chapters.find((c) => c.id === chapterId);
  if (!chapter) throw new Error('Chapter not found.');
  const segments = learning.segments.filter((s) => chapter.segmentIds.includes(s.id));
  const fronts = new Set<string>();
  for (const card of value.cards) {
    const front = card.front.toLocaleLowerCase();
    if (fronts.has(front))
      throw new Error('The generated deck contains duplicate cards. Retry creation.');
    fronts.add(front);
    for (const evidence of card.evidence) {
      const segment = segments.find((s) => s.id === evidence.segmentId);
      if (!segment?.text.includes(evidence.quote))
        throw new Error('A generated card cites unavailable evidence. Retry creation.');
    }
  }
  return value;
}
