import { useEffect, useRef } from 'react';
import type { T } from '../i18n';
import { BookOpen, MessageSquare, StickyNote, Bookmark } from 'lucide-react';

export const primaryStudyTools = ['assistant', 'notes', 'bookmarks', 'glossary'] as const;
export const auxiliaryStudyTools = ['chapters', 'practice', 'review', 'artifacts'] as const;
export const studyTools = [...primaryStudyTools, ...auxiliaryStudyTools] as const;
export type StudyTab = (typeof studyTools)[number];
export function isPrimaryStudyTool(value: StudyTab) {
  return (primaryStudyTools as readonly StudyTab[]).includes(value);
}
const icons = {
  assistant: MessageSquare,
  notes: StickyNote,
  bookmarks: Bookmark,
  glossary: BookOpen,
};

export function StudyTabs({
  value,
  change,
  t,
}: {
  value: StudyTab;
  change: (value: StudyTab) => void;
  t: T;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const focusAfterChange = useRef(false);
  useEffect(() => {
    const selected = strip.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    selected?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    if (focusAfterChange.current) {
      selected?.focus();
      focusAfterChange.current = false;
    }
  }, [value]);
  return (
    <div className="study-tabs" role="tablist" aria-label={t.study} ref={strip}>
      {primaryStudyTools.map((tool, index) => {
        const Icon = icons[tool];
        return (
          <button
            key={tool}
            id={`study-tab-${tool}`}
            role="tab"
            aria-selected={value === tool}
            aria-controls="study-content"
            tabIndex={value === tool || (!isPrimaryStudyTool(value) && index === 0) ? 0 : -1}
            title={t[tool]}
            className={value === tool ? 'active' : ''}
            onClick={() => change(tool)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === 'ArrowRight') next = (index + 1) % primaryStudyTools.length;
              else if (event.key === 'ArrowLeft')
                next = (index + primaryStudyTools.length - 1) % primaryStudyTools.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = primaryStudyTools.length - 1;
              else return;
              event.preventDefault();
              focusAfterChange.current = true;
              change(primaryStudyTools[next]);
            }}
          >
            <Icon size={14} aria-hidden="true" />
            <span className="study-tab-label">{t[tool]}</span>
          </button>
        );
      })}
    </div>
  );
}
