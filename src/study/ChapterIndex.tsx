import { useState } from 'react';
import { Check, GraduationCap, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import type { Attempt, PublicLearning, Source, Segment } from '../../shared/domain';
import {
  chapterLocations,
  completedChapter,
  currentChapter,
  type StudyChapter,
} from '../../shared/chapters';
import { formatTime } from '../../shared/media-controls';
import { IconButton, Button } from '../design/components';
import type { T } from '../i18n';
import { quizDraftKey, readQuizDraft } from './quizDrafts';

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
  const locations = chapterLocations(learning, source.kind),
    active = currentChapter(locations, position);
  return (
    <nav
      aria-label={`${t.chapterIndex}: ${source.name}`}
      className={`chapter-index ${expanded ? 'expanded' : 'collapsed'}`}
    >
      <div className="chapter-index-heading">
        <IconButton
          label={expanded ? t.collapseChapters : t.expandChapters}
          aria-expanded={expanded}
          onClick={() => {
            setExpanded(!expanded);
            try {
              localStorage.setItem(key, expanded ? 'collapsed' : 'expanded');
            } catch {}
          }}
        >
          {expanded ? <PanelLeftClose /> : <PanelLeftOpen />}
        </IconButton>
        {expanded && (
          <strong>
            {t.chapters} <span>{learning.synthesis.chapters.length}</span>
          </strong>
        )}
      </div>
      {expanded && (
        <div className="chapter-index-content">
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
            const complete = completedChapter(attempts, learning, range.chapter),
              draft = readQuizDraft(quizDraftKey(sessionId, learning, range.chapter));
            const label =
              range.kind === 'time'
                ? `${formatTime(range.start)}–${formatTime(range.end)}`
                : range.kind === 'page'
                  ? `${t.page} ${range.start}${range.end !== range.start ? `–${range.end}` : ''}`
                  : `${t.source} ${range.segment.id}`;
            return (
              <section key={range.chapter.id} className="chapter-index-item">
                <button
                  className="chapter-index-link"
                  aria-current={active?.chapter.id === range.chapter.id ? 'location' : undefined}
                  onClick={() => navigate(range.segment, range.chapter.title)}
                  title={range.chapter.summary}
                >
                  <span>{range.ordinal}.</span>
                  <div>
                    <strong>{range.chapter.title}</strong>
                    <small>{label}</small>
                  </div>
                </button>
                <Button
                  variant="ghost"
                  onClick={() => quiz(range.chapter)}
                  disabled={!range.chapter.questions.length}
                >
                  {complete ? <Check size={13} /> : <GraduationCap size={13} />}
                  {draft && !draft.completed ? t.continueQuiz : complete ? t.repeatQuiz : t.quiz}
                </Button>
              </section>
            );
          })}
        </div>
      )}
    </nav>
  );
}
