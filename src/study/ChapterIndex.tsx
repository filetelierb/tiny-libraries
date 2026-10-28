import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Layers,
  ListChecks,
  ListTree,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import { cardDue } from '../../shared/flashcards';
import type { useFlashcards } from './useFlashcards';
import type { Attempt, PublicLearning, Source, Segment } from '../../shared/domain';
import {
  chapterLocations,
  completedChapter,
  currentChapter,
  type StudyChapter,
} from '../../shared/chapters';
import { formatTime } from '../../shared/media-controls';
import { Button, IconButton } from '../design/components';
import type { T } from '../i18n';
import { quizDraftKey, readQuizDraft } from './quizDrafts';

/** Below this reader width the index leaves the side and opens as a bottom sheet. */
const SHEET_WIDTH = 700;

export function ChapterIndex({
  source,
  learning,
  position,
  sessionId,
  attempts,
  enabled,
  setEnabled,
  navigate,
  quiz,
  cards,
  openCards,
  t,
}: {
  source: Source;
  learning: PublicLearning;
  position: number;
  sessionId: string;
  attempts: Attempt[];
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  navigate: (segment: Segment, heading?: string) => void;
  quiz: (chapter: StudyChapter) => void;
  cards: ReturnType<typeof useFlashcards>;
  openCards: (chapterId: string | undefined, dueOnly: boolean) => void;
  t: T;
}) {
  const key = `tl:chapter-index:${source.id}:v${source.version}`;
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(key) !== 'collapsed';
    } catch {
      return true;
    }
  });
  const [compact, setCompact] = useState(false),
    [sheet, setSheet] = useState(false);
  const nav = useRef<HTMLElement>(null),
    opener = useRef<HTMLButtonElement>(null),
    sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const reader = nav.current?.closest<HTMLElement>('.reader-study');
    if (!reader) return;
    const observer = new ResizeObserver(([entry]) =>
      setCompact(entry.contentRect.width <= SHEET_WIDTH),
    );
    observer.observe(reader);
    return () => observer.disconnect();
  }, []);
  const open = compact && sheet;
  useEffect(() => {
    if (!open) return;
    sheetRef.current?.querySelector<HTMLElement>('.chapter-index-link')?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [open]);
  function close() {
    setSheet(false);
    opener.current?.focus();
  }
  /** In the sheet, choosing anything closes it so the reader comes back into view. */
  const pick =
    <A extends unknown[]>(action: (...args: A) => void) =>
    (...args: A) => {
      if (open) setSheet(false);
      action(...args);
    };
  const locations = chapterLocations(learning, source.kind),
    active = currentChapter(locations, position);
  const count = `${learning.synthesis.chapters.length} ${t.chapters.toLowerCase()}`;
  if (compact)
    return (
      <nav
        ref={nav}
        aria-label={`${t.chapterIndex}: ${source.name}`}
        className="chapter-index compact"
      >
        <button
          ref={opener}
          type="button"
          className="button button-ghost button-sm chapter-sheet-toggle"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setSheet(!sheet)}
        >
          <ListTree size={14} />
          <span>{count}</span>
          {active && (
            <small>
              {active.ordinal}. {active.chapter.title}
            </small>
          )}
        </button>
        {open && (
          <>
            <button
              type="button"
              className="chapter-sheet-mask"
              tabIndex={-1}
              aria-label={t.close}
              onClick={close}
            />
            <div
              ref={sheetRef}
              className="chapter-sheet"
              role="dialog"
              aria-modal="true"
              aria-label={t.chapterIndex}
            >
              <div className="chapter-sheet-head">
                <strong>{t.chapters}</strong>
                <span>{learning.synthesis.chapters.length}</span>
                <IconButton label={t.close} onClick={close}>
                  <X />
                </IconButton>
              </div>
              {content()}
            </div>
          </>
        )}
      </nav>
    );
  return (
    <nav
      ref={nav}
      aria-label={`${t.chapterIndex}: ${source.name}`}
      className={`chapter-index ${expanded ? 'expanded' : 'collapsed'}`}
    >
      <div className="chapter-index-heading">
        <Button
          variant="ghost"
          size="sm"
          title={expanded ? t.collapseChapters : t.expandChapters}
          aria-label={expanded ? t.collapseChapters : t.expandChapters}
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
            try {
              localStorage.setItem(key, expanded ? 'collapsed' : 'expanded');
            } catch {}
          }}
        >
          {expanded ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          {expanded && <span>{count}</span>}
        </Button>
      </div>
      {expanded && content()}
    </nav>
  );
  function content() {
    return (
      <div className="chapter-index-content">
        <div className="chapter-card-tools">
          <Button
            variant="ghost"
            disabled={
              cards.starting ||
              cards.decks.some((d) => ['queued', 'running'].includes(d.status)) ||
              learning.synthesis.chapters.every((c) =>
                cards.decks.some((d) => d.chapterId === c.id && d.status === 'ready'),
              )
            }
            onClick={() =>
              void cards.create(
                learning.synthesis.chapters
                  .filter(
                    (c) => !cards.decks.some((d) => d.chapterId === c.id && d.status === 'ready'),
                  )
                  .map((c) => c.id),
              )
            }
          >
            <Layers size={13} />
            {cards.decks.some((d) => ['queued', 'running'].includes(d.status))
              ? t.creatingCards
              : t.createCards}
          </Button>
          <Button
            variant="ghost"
            disabled={!cards.decks.some((d) => d.cards.some((c) => cardDue(c)))}
            onClick={() => pick(openCards)(undefined, true)}
          >
            {t.reviewDueCards} ·{' '}
            {cards.decks.flatMap((d) => d.cards).filter((c) => cardDue(c)).length} {t.cardsDue}
          </Button>
          {cards.error && (
            <p className="notice" role="alert">
              {cards.error}
            </p>
          )}
        </div>
        {['audio', 'video', 'pdf'].includes(source.kind) && (
          <label className="chapter-checkpoints">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            <span>{t.studyCheckpoints}</span>
          </label>
        )}
        {locations.map((range) => {
          const deck = cards.decks.find((d) => d.chapterId === range.chapter.id),
            pending = !!deck && ['queued', 'running'].includes(deck.status);
          const complete = completedChapter(attempts, learning, range.chapter),
            draft = readQuizDraft(quizDraftKey(sessionId, learning, range.chapter));
          const label =
            range.kind === 'time'
              ? `${formatTime(range.start)}–${formatTime(range.end)}`
              : range.kind === 'page'
                ? `${t.page} ${range.start}${range.end !== range.start ? `–${range.end}` : ''}`
                : range.segment.start != null
                  ? // Transcript passages carry the time they were said.
                    formatTime(range.segment.start)
                  : `${t.source} ${range.segment.id}`;
          return (
            <section key={range.chapter.id} className="chapter-index-item">
              <button
                className="chapter-index-link"
                aria-current={active?.chapter.id === range.chapter.id ? 'location' : undefined}
                onClick={() => pick(navigate)(range.segment, range.chapter.title)}
                title={range.chapter.summary}
              >
                <span>{range.ordinal}.</span>
                <div>
                  <strong>{range.chapter.title}</strong>
                  <small>{label}</small>
                </div>
              </button>
              <div className="chapter-actions">
                <Button
                  variant="ghost"
                  onClick={() => pick(quiz)(range.chapter)}
                  disabled={!range.chapter.questions.length}
                >
                  {complete ? <Check size={14} /> : <ListChecks size={14} />}
                  {draft && !draft.completed
                    ? t.continueQuiz
                    : complete
                      ? t.repeatQuizShort
                      : t.quizShort}
                </Button>
                <Button
                  variant="ghost"
                  disabled={cards.starting || pending}
                  onClick={() =>
                    deck?.status === 'ready'
                      ? pick(openCards)(range.chapter.id, false)
                      : void cards.create([range.chapter.id])
                  }
                >
                  {pending ? <LoaderCircle size={14} className="spin" /> : <Layers size={14} />}
                  {pending
                    ? t.creatingCards
                    : deck?.status === 'ready'
                      ? `${deck.cards.length} ${t.cardsCount}`
                      : t.createCards}
                </Button>
              </div>
              {deck?.error && (
                <p className="chapter-card-error" role="status">
                  {deck.error}
                </p>
              )}
            </section>
          );
        })}
      </div>
    );
  }
}
