import { memo, type RefObject } from 'react';
import type { TutorCitation } from '../../shared/tutor-context';
import { StudyMarkdown } from '../study/StudyMarkdown';
import { defaultUrlTransform } from 'react-markdown';
import {
  citationFromHref,
  isTemporaryFileHref,
  remarkTutorCitations,
  temporaryFileHref,
} from './citations';
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
        urlTransform={(url) =>
          isTemporaryFileHref(url) ? temporaryFileHref : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children }) => {
            if (href === temporaryFileHref)
              return (
                <span className="temporary-file-link">
                  <span>{children}</span> <span className="muted">{t.temporaryFileNotice}</span>
                </span>
              );
            const reference = citationFromHref(href, byId);
            if (reference?.kind === 'web')
              return (
                <a
                  className="evidence-link web-evidence-link"
                  href={reference.url}
                  title={`${t.webSource}: ${reference.title}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {children}
                </a>
              );
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
