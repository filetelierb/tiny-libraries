import { z } from 'zod';
import type { Directory, Learning, Settings, Source } from '../shared/domain';
import { sourceState } from '../shared/directories';
import { PARALLEL_CALLS, runAtOnce } from '../shared/parallel';
import {
  cardReviewInput,
  scheduleCard,
  validateCardPlan,
  type CardDeck,
  type CardPlan,
  type CardReview,
  type CardSchedule,
  type DeckView,
} from '../shared/flashcards';
import type { GlossaryStorage, GlossaryStore } from './glossary';

export class CardError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export type StoredDeck = CardDeck & { owner: string; operation: string; until: number };
const deckKey = (id: string) => `card-deck:${id}`;
const indexKey = (learning: Learning, chapterId: string) =>
  `card-index:${learning.sourceId}:${learning.sourceVersion}:${learning.createdAt}:${chapterId}`;
async function requireMaterial(
  tx: GlossaryStore,
  id: string,
  version?: number,
  learningVersion?: string,
) {
  const source = await tx.get<Source>(`file:${id}`);
  const directories = [...(await tx.list<Directory>({ prefix: 'directory:' })).values()];
  if (!source || sourceState(source, directories) === 'trash')
    throw new CardError('Restore the source before studying its cards.', 409);
  const learning = await tx.get<Learning>(`learning:${id}`);
  if (
    !learning ||
    learning.sourceVersion !== source.version ||
    (version && version !== source.version) ||
    (learningVersion && learning.createdAt !== learningVersion)
  )
    throw new CardError('This study material changed. Reopen it before studying cards.', 409);
  return learning;
}
export async function cardSnapshot(
  storage: GlossaryStorage,
  sourceId: string,
  owner: string,
): Promise<DeckView[]> {
  return storage.transaction(async (tx) => {
    const learning = await requireMaterial(tx, sourceId);
    const decks: DeckView[] = [];
    for (const chapter of learning.synthesis.chapters) {
      const id = await tx.get<string>(indexKey(learning, chapter.id));
      let deck = id ? await tx.get<StoredDeck>(deckKey(id)) : undefined;
      if (!deck) continue;
      if (
        ['queued', 'running'].includes(deck.status) &&
        (deck.owner !== owner || deck.until < Date.now())
      ) {
        deck = {
          ...deck,
          status: 'interrupted',
          error: 'Card creation was interrupted. Retry to continue.',
        };
        await tx.put(deckKey(deck.id), deck);
      }
      const { owner: _owner, operation: _operation, until: _until, ...publicDeck } = deck;
      const cards = await Promise.all(
        deck.cards.map(async (card) => ({
          ...card,
          schedule: (await tx.get<CardSchedule>(`card-schedule:${card.id}`)) || null,
        })),
      );
      decks.push({ ...publicDeck, cards });
    }
    return decks;
  });
}
export async function startCardDecks(
  storage: GlossaryStorage,
  sourceId: string,
  raw: unknown,
  options: {
    owner: string;
    settings: Settings;
    start: (task: Promise<void>) => void;
    generate: (learning: Learning, chapterId: string) => Promise<CardPlan>;
  },
) {
  const input = z
    .object({
      sourceVersion: z.number().int().positive(),
      learningVersion: z.string().min(1).max(100),
      chapterIds: z.array(z.string().min(1).max(240)).min(1).max(12),
    })
    .parse(raw);
  if (!options.settings.configured)
    throw new CardError('Add a Meta API key in Settings to create cards.', 409);
  const tasks = await storage.transaction(async (tx) => {
    const learning = await requireMaterial(
      tx,
      sourceId,
      input.sourceVersion,
      input.learningVersion,
    );
    const tasks: Array<{ deck: StoredDeck; learning: Learning }> = [];
    for (const chapterId of new Set(input.chapterIds)) {
      const chapter = learning.synthesis.chapters.find((c) => c.id === chapterId);
      if (!chapter) throw new CardError('Chapter not found.', 404);
      const index = indexKey(learning, chapterId),
        id = await tx.get<string>(index);
      const old = id ? await tx.get<StoredDeck>(deckKey(id)) : undefined;
      if (
        old?.status === 'ready' ||
        (old &&
          ['queued', 'running'].includes(old.status) &&
          old.owner === options.owner &&
          old.until > Date.now())
      )
        continue;
      const deck: StoredDeck = {
        id: old?.id || crypto.randomUUID(),
        sourceId,
        sourceVersion: learning.sourceVersion,
        learningVersion: learning.createdAt,
        chapterId,
        title: chapter.title,
        locale: learning.locale,
        model: options.settings.model,
        createdAt: old?.createdAt || new Date().toISOString(),
        status: 'queued',
        cards: [],
        owner: options.owner,
        operation: crypto.randomUUID(),
        until: Date.now() + 3600000,
      };
      await tx.put(index, deck.id);
      await tx.put(deckKey(deck.id), deck);
      tasks.push({ deck, learning });
    }
    return tasks;
  });
  if (tasks.length)
    options.start(
      (async () => {
        await runAtOnce(tasks, PARALLEL_CALLS, async ({ deck, learning }) => {
          try {
            const reserved = await storage.transaction(async (tx) => {
              const current = await tx.get<StoredDeck>(deckKey(deck.id));
              if (current?.operation !== deck.operation || current.status !== 'queued')
                return false;
              await requireMaterial(tx, sourceId, deck.sourceVersion, deck.learningVersion);
              await tx.put(deckKey(deck.id), {
                ...current,
                status: 'running',
                until: Date.now() + 600000,
              });
              return true;
            });
            if (!reserved) return;
            const plan = validateCardPlan(
              await options.generate(learning, deck.chapterId),
              learning,
              deck.chapterId,
            );
            const ready: StoredDeck = {
              ...deck,
              status: 'ready',
              cards: plan.cards.map((card) => ({ ...card, id: crypto.randomUUID() })),
            };
            if (new TextEncoder().encode(JSON.stringify(ready)).length > 120000)
              throw new CardError('This deck exceeds the saved-card limit. Try a shorter chapter.');
            await storage.transaction(async (tx) => {
              await requireMaterial(tx, sourceId, deck.sourceVersion, deck.learningVersion);
              const current = await tx.get<StoredDeck>(deckKey(deck.id));
              if (current?.operation === deck.operation && current.status === 'running')
                await tx.put(deckKey(deck.id), ready);
            });
          } catch (error) {
            await storage.transaction(async (tx) => {
              const current = await tx.get<StoredDeck>(deckKey(deck.id));
              if (
                current?.operation === deck.operation &&
                ['queued', 'running'].includes(current.status)
              )
                await tx.put(deckKey(deck.id), {
                  ...current,
                  status: 'failed',
                  error:
                    error instanceof Error
                      ? error.message.slice(0, 500)
                      : 'Card creation failed. Retry to continue.',
                });
            });
          }
        });
      })(),
    );
  return cardSnapshot(storage, sourceId, options.owner);
}
export async function rateCard(
  storage: GlossaryStorage,
  deckId: string,
  raw: unknown,
): Promise<CardReview> {
  const input = cardReviewInput.parse(raw);
  return storage.transaction(async (tx) => {
    const receipt = await tx.get<CardReview>(`card-review:${input.requestId}`);
    if (receipt) {
      if (
        receipt.deckId !== deckId ||
        receipt.cardId !== input.cardId ||
        receipt.grade !== input.grade ||
        receipt.expectedRevision !== input.expectedRevision
      )
        throw new CardError('This rating operation already contains a different rating.', 409);
      return receipt;
    }
    const deck = await tx.get<StoredDeck>(deckKey(deckId));
    if (!deck || deck.status !== 'ready' || !deck.cards.some((c) => c.id === input.cardId))
      throw new CardError('Card not found.', 404);
    await requireMaterial(tx, deck.sourceId, deck.sourceVersion, deck.learningVersion);
    const previous = (await tx.get<CardSchedule>(`card-schedule:${input.cardId}`)) || null;
    if ((previous?.revision || 0) !== input.expectedRevision)
      throw new CardError(
        'This card was rated in another window. Refresh its schedule before rating again.',
        409,
      );
    const now = new Date(),
      schedule = scheduleCard(previous, input.grade, now);
    const review: CardReview = {
      id: input.requestId,
      deckId,
      cardId: input.cardId,
      grade: input.grade,
      expectedRevision: input.expectedRevision,
      schedule,
      createdAt: now.toISOString(),
    };
    await tx.put(`card-schedule:${input.cardId}`, schedule);
    await tx.put(`card-review:${input.requestId}`, review);
    return review;
  });
}

/** How many cards a deck has, for counting a complete pass through it. */
export async function deckSize(storage: GlossaryStorage, deckId: string) {
  return (await storage.get<StoredDeck>(deckKey(deckId)))?.cards.length || 0;
}
