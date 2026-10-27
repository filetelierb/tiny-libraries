import { useEffect, useState } from 'react';
import { Check, Layers, ListChecks, RefreshCw } from 'lucide-react';
import type { Attempt } from '../../shared/domain';
import type { ArtifactStudySnapshot, PublicArtifactStudy } from '../../shared/artifact-study';
import { api } from '../api';
import { Button, Modal, Spinner } from '../design/components';
import type { T } from '../i18n';

export type ArtifactStudyChapterView = PublicArtifactStudy['chapters'][number];
/** What the artifact's chapter index needs to offer quizzes and cards per chapter. */
export type ArtifactStudyHost = {
  sourceId: string;
  attempts: Attempt[];
  quiz: (chapter: ArtifactStudyChapterView, version: string) => void;
};

/** Loads the latest artifact version's chapter study material, polling while it generates. */
export function useArtifactStudy(sourceId: string | undefined, artifactKey: string) {
  const [snapshot, setSnapshot] = useState<ArtifactStudySnapshot | null>(null),
    [tick, setTick] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    if (!sourceId) return;
    let live = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const value = await api<ArtifactStudySnapshot>(`/artifacts/${sourceId}/study`);
        if (!live) return;
        setSnapshot(value);
        if (value.status === 'generating') timer = setTimeout(() => void load(), 2500);
      } catch (cause) {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [sourceId, artifactKey, tick]);
  const generate = async () => {
    if (!sourceId) return;
    setError('');
    try {
      setSnapshot(await api<ArtifactStudySnapshot>(`/artifacts/${sourceId}/study`, 'POST', {}));
      setTick((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return { snapshot, error, generate };
}

/** Explains why chapter tools are missing and offers to generate them. */
export function ArtifactStudyStatus({
  snapshot,
  error,
  generate,
  t,
}: {
  snapshot: ArtifactStudySnapshot | null;
  error: string;
  generate: () => void;
  t: T;
}) {
  if (!snapshot || snapshot.status === 'ready' || snapshot.status === 'unavailable') return null;
  const failed = snapshot.status === 'failed' || !!error;
  return (
    <div className="artifact-study-status" role="status">
      <p className={failed ? 'failed' : ''}>
        {failed
          ? error || ('error' in snapshot && snapshot.error) || t.artifactStudyFailed
          : snapshot.status === 'generating'
            ? t.artifactStudyGenerating
            : t.artifactStudyPending}
      </p>
      {snapshot.status === 'generating' ? (
        <Spinner />
      ) : (
        <Button size="sm" onClick={generate}>
          <RefreshCw />
          {t.generateOrRetry}
        </Button>
      )}
    </div>
  );
}

export function ArtifactChapterActions({
  chapter,
  attempted,
  quiz,
  cards,
  t,
}: {
  chapter: ArtifactStudyChapterView;
  attempted: boolean;
  quiz: () => void;
  cards: () => void;
  t: T;
}) {
  return (
    <div className="chapter-actions">
      {chapter.questions.length > 0 && (
        <Button variant="ghost" size="sm" onClick={quiz} aria-label={`${t.quiz}: ${chapter.title}`}>
          {attempted ? <Check /> : <ListChecks />}
          {attempted ? t.repeatQuizShort : t.quizShort}
        </Button>
      )}
      {chapter.cards.length > 0 && (
        <Button
          variant="ghost"
          size="sm"
          onClick={cards}
          aria-label={`${t.flashcards}: ${chapter.title}`}
        >
          <Layers />
          {chapter.cards.length} {t.cardsCount}
        </Button>
      )}
    </div>
  );
}

/** Flips through a chapter's recall cards; answers stay hidden until asked for. */
export function ArtifactCards({
  chapter,
  t,
  close,
}: {
  chapter: ArtifactStudyChapterView;
  t: T;
  close: () => void;
}) {
  const [index, setIndex] = useState(0),
    [shown, setShown] = useState(false);
  const card = chapter.cards[index];
  const go = (next: number) => {
    setIndex(next);
    setShown(false);
  };
  return (
    <Modal title={`${t.flashcards} · ${chapter.title}`} close={close} closeLabel={t.close}>
      <div className="artifact-cards">
        <p className="artifact-cards-progress">
          {index + 1} / {chapter.cards.length}
        </p>
        <div className="artifact-card-face">
          <p className="artifact-card-front">{card.front}</p>
          {shown && <p className="artifact-card-back">{card.back}</p>}
        </div>
        <div className="artifact-cards-nav">
          <Button size="sm" variant="ghost" disabled={index === 0} onClick={() => go(index - 1)}>
            {t.previousStep}
          </Button>
          {shown ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => (index < chapter.cards.length - 1 ? go(index + 1) : close())}
            >
              {index < chapter.cards.length - 1 ? t.nextStep : t.done}
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => setShown(true)}>
              {t.revealAnswer}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
