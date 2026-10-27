import { useRef, useState, type ComponentProps } from 'react';
import type { Attempt, Segment } from '../../shared/domain';
import {
  chapterLocations,
  completedChapter,
  crossedChapter,
  crossedChapterEnds,
  type ReadingProgress,
  type StudyChapter,
} from '../../shared/chapters';
import { Viewer } from '../Viewer';
import { ChapterIndex } from './ChapterIndex';
import { useFlashcards } from './useFlashcards';
import { cardDue } from '../../shared/flashcards';

export function StudyReader({
  attempts,
  navigate,
  quiz,
  openCards,
  cardTick,
  ...props
}: ComponentProps<typeof Viewer> & {
  attempts: Attempt[];
  navigate: (segment: Segment, heading?: string) => void;
  quiz: (chapter: StudyChapter, wasPlaying: boolean) => void;
  openCards: (chapterId: string | undefined, dueOnly: boolean) => void;
  cardTick: number;
}) {
  const { source, learning, position = 0, sessionId, t } = props;
  const preferenceKey = `tl:checkpoints:${source.id}:v${source.version}`;
  const [enabled, setEnabled] = useState(() => {
    try {
      return localStorage.getItem(preferenceKey) !== 'disabled';
    } catch {
      return true;
    }
  });
  const [location, setLocation] = useState(position);
  const previous = useRef(position),
    prompted = useRef(new Set<string>()),
    promptedCards = useRef(new Set<string>()),
    playing = useRef(false);
  const material = learning?.sourceVersion === source.version ? learning : null;
  const cards = useFlashcards(material, cardTick);
  const progress = (event: ReadingProgress) => {
    const before = previous.current;
    previous.current = event.value;
    setLocation(event.value);
    if (!material || !enabled || props.suspended) return;
    const complete = new Set(
      material.synthesis.chapters
        .filter((c) => completedChapter(attempts, material, c))
        .map((c) => c.id),
    );
    const ranges = chapterLocations(material, source.kind);
    const next = crossedChapter(ranges, before, event, prompted.current, complete);
    if (next) {
      prompted.current.add(next.chapter.id);
      quiz(next.chapter, event.playing ?? playing.current);
      return;
    }
    // Without a quiz to take, a finished chapter with due cards opens its review deck once.
    const due = crossedChapterEnds(ranges, before, event).find(
      (range) =>
        !promptedCards.current.has(range.chapter.id) &&
        cards.decks.some(
          (deck) =>
            deck.chapterId === range.chapter.id &&
            deck.status === 'ready' &&
            deck.cards.some((card) => cardDue(card)),
        ),
    );
    if (due) {
      promptedCards.current.add(due.chapter.id);
      openCards(due.chapter.id, true);
    }
  };
  return (
    <div className="reader-study">
      <div className="reader-study-layout">
        {material && material.synthesis.chapters.length > 0 && (
          <ChapterIndex
            source={source}
            learning={material}
            sessionId={sessionId}
            attempts={attempts}
            position={location}
            enabled={enabled}
            setEnabled={(value) => {
              setEnabled(value);
              try {
                localStorage.setItem(preferenceKey, value ? 'enabled' : 'disabled');
              } catch {}
            }}
            navigate={navigate}
            quiz={(chapter) => quiz(chapter, playing.current)}
            cards={cards}
            openCards={openCards}
            t={t}
          />
        )}
        <div className="reader-body">
          <Viewer
            {...props}
            onReadingProgress={progress}
            onPlaying={(value) => {
              playing.current = value;
              props.onPlaying?.(value);
            }}
          />
        </div>
      </div>
    </div>
  );
}
