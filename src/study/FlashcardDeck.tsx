import { useEffect, useRef, useState } from 'react';
import { Layers, LoaderCircle } from 'lucide-react';
import type { PublicLearning, Source, Segment } from '../../shared/domain';
import {
  cardDue,
  cardGrades,
  type CardGrade,
  type CardReview,
  type DeckView,
} from '../../shared/flashcards';
import { api, ApiResponseError } from '../api';
import { Button, Modal } from '../design/components';
import type { T } from '../i18n';
import { completeCardDraft, readCardDraft, saveCardDraft, type CardDraft } from './cardDrafts';

export type DeckRequest = {
  source: Source;
  learning: PublicLearning;
  chapterId?: string;
  dueOnly: boolean;
};
export function FlashcardDeck({
  request,
  t,
  close,
  changed,
  cite,
}: {
  request: DeckRequest;
  t: T;
  close: () => void;
  changed: () => void;
  cite: (segment: Segment) => void;
}) {
  const { source, learning, chapterId, dueOnly } = request;
  const key = `tl:cards:${source.id}:v${source.version}:${learning.createdAt}:${chapterId || 'all'}:${dueOnly ? 'due' : 'chapter'}`;
  const [draft, setDraft] = useState<CardDraft | null>(() => readCardDraft(key)),
    [decks, setDecks] = useState<DeckView[]>([]),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const draftRef = useRef(draft),
    mounted = useRef(true);
  const commit = (next: CardDraft) => {
    draftRef.current = next;
    saveCardDraft(key, next);
    if (mounted.current) setDraft(next);
  };
  const refresh = async () => {
    const values = await api<DeckView[]>(`/flashcards/${source.id}`);
    const current = values.filter(
      (d) =>
        d.status === 'ready' &&
        d.learningVersion === learning.createdAt &&
        (!chapterId || d.chapterId === chapterId),
    );
    if (!current.length) throw new Error(t.cardMaterialUnavailable);
    if (mounted.current) setDecks(current);
    return current;
  };
  useEffect(() => {
    mounted.current = true;
    void refresh()
      .then((values) => {
        if (!mounted.current) return;
        const all = values.flatMap((d) => d.cards),
          ids = new Set(all.map((c) => c.id));
        const old = draftRef.current;
        if (!old || (!old.queue.length && !old.operation))
          commit({
            queue: all.filter((c) => !dueOnly || cardDue(c)).map((c) => c.id),
            done: 0,
            revealed: false,
            operation: null,
            conflict: false,
          });
        else if (old.queue.some((id) => !ids.has(id))) throw new Error(t.cardMaterialUnavailable);
        setLoaded(true);
      })
      .catch((e) => {
        if (mounted.current) setError((e as Error).message);
      });
    return () => {
      mounted.current = false;
    };
  }, []);
  const card = decks.flatMap((d) => d.cards).find((c) => c.id === draft?.queue[0]),
    deck = decks.find((d) => d.cards.some((c) => c.id === card?.id));
  async function rate(grade: CardGrade) {
    const current = draftRef.current;
    if (!current || !card || !deck || busy || current.conflict) return;
    const operation = current.operation || {
      requestId: crypto.randomUUID(),
      cardId: card.id,
      deckId: deck.id,
      grade,
      expectedRevision: card.schedule?.revision || 0,
    };
    commit({ ...current, operation });
    setBusy(true);
    setError('');
    try {
      const result = await api<CardReview>(
        `/flashcards/${operation.deckId}/review`,
        'POST',
        operation,
      );
      setDecks((values) =>
        values.map((d) => ({
          ...d,
          cards: d.cards.map((c) =>
            c.id === result.cardId ? { ...c, schedule: result.schedule } : c,
          ),
        })),
      );
      // A response from a closed dialog may arrive after a reopened dialog recovered it.
      const before = readCardDraft(key) || draftRef.current!;
      commit(completeCardDraft(before, result));
      changed();
    } catch (e) {
      if (e instanceof ApiResponseError && e.status === 409)
        commit({ ...draftRef.current!, conflict: true });
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  const title = chapterId
    ? learning.synthesis.chapters.find((c) => c.id === chapterId)?.title || source.name
    : source.name;
  return (
    <Modal title={t.flashcards} close={close} closeLabel={t.closeCards}>
      <div className="card-deck">
        <div className="section-label">
          <Layers size={16} />
          {title}
        </div>
        <p className="muted">{t.cardSelfAssessment}</p>
        {error && (
          <p className="notice" role="alert">
            {error}
          </p>
        )}
        {!loaded ? (
          <Button
            disabled={busy}
            onClick={() => {
              setError('');
              void refresh()
                .then((values) => {
                  const old = draftRef.current;
                  if (!old)
                    commit({
                      queue: values
                        .flatMap((d) => d.cards)
                        .filter((c) => !dueOnly || cardDue(c))
                        .map((c) => c.id),
                      done: 0,
                      revealed: false,
                      operation: null,
                      conflict: false,
                    });
                  setLoaded(true);
                })
                .catch((e) => setError((e as Error).message));
            }}
          >
            {t.retry}
          </Button>
        ) : card && draft ? (
          <>
            <p className="card-counter" aria-live="polite">
              {draft.done} {t.cardsReviewed} · {draft.queue.length} {t.cardsRemaining}
            </p>
            <button
              type="button"
              className="flashcard"
              aria-label={draft.revealed ? undefined : t.revealAnswer}
              onClick={() => !draft.revealed && commit({ ...draft, revealed: true })}
            >
              <span className="flashcard-chapter">{deck?.title}</span>
              <span className="flashcard-front">{card.front}</span>
              {draft.revealed ? (
                <span className="flashcard-back">{card.back}</span>
              ) : (
                <span className="flashcard-hint">{t.recallBeforeReveal}</span>
              )}
            </button>
            {!draft.revealed ? (
              <Button
                variant="primary"
                className="card-reveal"
                onClick={() => commit({ ...draft, revealed: true })}
              >
                {t.revealAnswer}
              </Button>
            ) : (
              <>
                {draft.operation ? (
                  <div className="card-retry">
                    <p className="muted">
                      {draft.conflict ? t.cardScheduleChanged : t.cardRatingRetained}
                    </p>
                    {draft.conflict ? (
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          void refresh()
                            .then(() => {
                              commit({ ...draftRef.current!, operation: null, conflict: false });
                              setError('');
                            })
                            .catch((e) => setError((e as Error).message))
                            .finally(() => setBusy(false));
                        }}
                      >
                        {t.refreshCardSchedule}
                      </Button>
                    ) : (
                      <Button disabled={busy} onClick={() => void rate(draft.operation!.grade)}>
                        {busy && <LoaderCircle size={14} className="spin" />}
                        {busy ? t.saving : t.retryRating}
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="card-grades">
                    {cardGrades.map((grade) => (
                      <Button
                        key={grade}
                        variant={
                          grade === 'good' ? 'primary' : grade === 'easy' ? 'secondary' : 'default'
                        }
                        disabled={busy}
                        onClick={() => void rate(grade)}
                      >
                        {t[`cardGrade_${grade}`]}
                      </Button>
                    ))}
                  </div>
                )}
                <details className="card-evidence">
                  <summary>{t.sourceEvidence}</summary>
                  {card.evidence.map((e, i) => {
                    const segment = learning.segments.find((s) => s.id === e.segmentId);
                    return (
                      <div key={i}>
                        <blockquote>{e.quote}</blockquote>
                        {segment && (
                          <Button variant="ghost" onClick={() => cite(segment)}>
                            {t.openSource} · {segment.id}
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </details>
                {card.schedule && (
                  <p className="muted">
                    {t.nextCardReview}: {new Date(card.schedule.dueAt).toLocaleString()}
                  </p>
                )}
              </>
            )}
          </>
        ) : (
          <div className="card-complete">
            <p className="card-complete-title">{t.cardReviewComplete}</p>
            <p className="muted">
              {draft?.done || 0} {t.cardsReviewed} · {t.cardReviewCompleteHint}
            </p>
            <Button variant="primary" onClick={close}>
              {t.close}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
