import { useEffect, useRef, useState } from 'react';
import type { PublicLearning } from '../../shared/domain';
import type { DeckView } from '../../shared/flashcards';
import { api } from '../api';

export function useFlashcards(learning: PublicLearning | null, tick = 0) {
  const [decks, setDecks] = useState<DeckView[]>([]),
    [error, setError] = useState(''),
    [starting, setStarting] = useState(false);
  const current = useRef(learning);
  current.current = learning;
  useEffect(() => {
    let live = true,
      timer: ReturnType<typeof setTimeout>;
    setError('');
    if (!learning) return;
    const load = async () => {
      try {
        const values = await api<DeckView[]>(`/flashcards/${learning.sourceId}`);
        if (live) {
          setDecks(values.filter((d) => d.learningVersion === learning.createdAt));
          setError('');
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
      if (live) timer = setTimeout(load, 3000);
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [learning?.sourceId, learning?.createdAt, tick]);
  async function create(chapterIds: string[]) {
    if (!learning || starting) return;
    setStarting(true);
    setError('');
    try {
      const values = await api<DeckView[]>(`/flashcards/${learning.sourceId}`, 'POST', {
        sourceVersion: learning.sourceVersion,
        learningVersion: learning.createdAt,
        chapterIds,
      });
      if (
        current.current?.sourceId === learning.sourceId &&
        current.current?.createdAt === learning.createdAt
      )
        setDecks(values);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }
  return { decks, error, starting, create };
}
