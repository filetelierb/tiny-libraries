import { useEffect, useRef } from 'react';
import type { T } from '../i18n';

export const studyTools = [
  'chapters',
  'notes',
  'bookmarks',
  'glossary',
  'practice',
  'review',
  'assistant',
  'miniapp',
] as const;
export type StudyTab = (typeof studyTools)[number];

export function StudyTabs({
  value,
  change,
  t,
  bookmarkCount = 0,
}: {
  value: StudyTab;
  change: (value: StudyTab) => void;
  t: T;
  bookmarkCount?: number;
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
      {studyTools.map((tool, index) => (
        <button
          key={tool}
          id={`study-tab-${tool}`}
          role="tab"
          aria-selected={value === tool}
          aria-controls="study-content"
          tabIndex={value === tool ? 0 : -1}
          className={value === tool ? 'active' : ''}
          onClick={() => change(tool)}
          onKeyDown={(event) => {
            let next = index;
            if (event.key === 'ArrowRight') next = (index + 1) % studyTools.length;
            else if (event.key === 'ArrowLeft')
              next = (index + studyTools.length - 1) % studyTools.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = studyTools.length - 1;
            else return;
            event.preventDefault();
            focusAfterChange.current = true;
            change(studyTools[next]);
          }}
        >
          {t[tool]}
          {tool === 'bookmarks' && <span className="bookmark-tab-count">{bookmarkCount}</span>}
        </button>
      ))}
    </div>
  );
}
