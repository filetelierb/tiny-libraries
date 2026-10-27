import { memo, type RefObject } from 'react';
import type { TutorCitation } from '../../shared/tutor-context';
import { StudyMarkdown } from '../study/StudyMarkdown';
import { citationFromHref, remarkTutorCitations } from './citations';
import type { T } from '../i18n';

/** Stored rich content stays mounted while separate live progress changes. */
export const SavedTutorMessage = memo(
  function SavedTutorMessage({
    content,
    references,
    labels,
    t,
    open,
  }: {
    content: string;
    references: TutorCitation[];
    labels: Record<string, string>;
    t: T;
    open: RefObject<((reference: TutorCitation) => void) | null>;
  }) {
    const byId = new Map(references.map((reference) => [reference.id, reference]));
    return (
      <StudyMarkdown
        t={t}
        remarkPlugins={[
          [
            remarkTutorCitations,
            { references, label: (reference: TutorCitation) => labels[reference.id] },
          ],
        ]}
        components={{
          a: ({ href, children }) => {
            const reference = citationFromHref(href, byId);
            if (reference)
              return (
                <button
                  className="evidence-link"
                  title={`${labels[reference.id]}${reference.kind === 'concept' ? ` · ${t.revision} ${reference.version}` : reference.kind === 'source' && reference.recovered ? ` · ${t.recoveredCitationNotice}` : ''}`}
                  onClick={() => open.current?.(reference)}
                >
                  {children}
                </button>
              );
            if (href?.startsWith('#tutor/') || href?.startsWith('#evidence/'))
              return <span>{children}</span>;
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </StudyMarkdown>
    );
  },
  (before, after) =>
    before.content === after.content &&
    before.t === after.t &&
    before.open === after.open &&
    JSON.stringify(before.references) === JSON.stringify(after.references) &&
    JSON.stringify(before.labels) === JSON.stringify(after.labels),
);
