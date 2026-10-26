import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { BookOpen, FileText } from 'lucide-react';
import type { Catalog, Source } from '../../shared/domain';
import { sourceState } from '../../shared/directories';
import {
  matchConcept,
  normalizeConcept,
  summarizeConcept,
  type GlossaryEntry,
} from '../../shared/glossary';
import { DirectoryTree, type TreeActions } from '../workspace/DirectoryTree';
import type { T } from '../i18n';
export type MentionPickerHandle = { key: (key: string) => boolean };
export const TutorMentionPicker = forwardRef<
  MentionPickerHandle,
  {
    query: string;
    catalog: Catalog;
    t: T;
    actions: TreeActions;
    pickFile: (file: Source) => void;
    pickConcept: (entry: GlossaryEntry) => void;
    focusComposer: () => void;
  }
>(function TutorMentionPicker(
  { query, catalog, t, actions, pickFile, pickConcept, focusComposer },
  ref,
) {
  const [tab, setTab] = useState<'files' | 'glossary'>('files'),
    [fileId, setFileId] = useState(''),
    [index, setIndex] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const entries = catalog.concepts
      .filter((c) => !c.archived && !c.mergedInto)
      .map(normalizeConcept),
    summaries = entries.map(summarizeConcept);
  const concepts = entries
    .filter((e) => matchConcept(summarizeConcept(e), query, summaries))
    .sort((a, b) => a.term.localeCompare(b.term));
  useEffect(() => {
    setFileId('');
    setIndex(0);
  }, [query, tab]);
  useImperativeHandle(ref, () => ({
    key: (key) => {
      const buttons = Array.from(
          panel.current?.querySelectorAll<HTMLButtonElement>('[data-file-choice]') || [],
        ),
        ids = buttons
          .filter((button) => button.getClientRects().length)
          .map((button) => button.dataset.fileChoice!);
      const count = tab === 'files' ? ids.length : concepts.length;
      if (!count || !['ArrowDown', 'ArrowUp', 'Enter'].includes(key)) return false;
      if (tab === 'files') {
        const current = ids.indexOf(fileId),
          next =
            current < 0
              ? 0
              : (current + (key === 'ArrowUp' ? count - 1 : key === 'ArrowDown' ? 1 : 0)) % count;
        if (key === 'Enter') {
          const file = catalog.files.find((f) => f.id === ids[next]);
          if (file) pickFile(file);
        } else {
          setFileId(ids[next]);
          buttons
            .find((button) => button.dataset.fileChoice === ids[next])
            ?.scrollIntoView({ block: 'nearest' });
        }
      } else if (key === 'Enter') pickConcept(concepts[Math.min(index, count - 1)]);
      else setIndex((value) => (value + (key === 'ArrowUp' ? count - 1 : 1)) % count);
      return true;
    },
  }));
  return (
    <div className="tutor-mention-picker" ref={panel} aria-label={t.mentionOptions}>
      <div role="tablist" aria-label={t.mentionType}>
        {(['files', 'glossary'] as const).map((value, i) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`mention-tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`mention-panel-${value}`}
            onClick={() => {
              setTab(value);
              focusComposer();
            }}
            onKeyDown={(event) => {
              if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                setTab(
                  event.key === 'Home'
                    ? 'files'
                    : event.key === 'End'
                      ? 'glossary'
                      : value === 'files'
                        ? 'glossary'
                        : 'files',
                );
                focusComposer();
              }
            }}
          >
            {i === 0 ? <FileText size={14} /> : <BookOpen size={14} />} {t[value]}
          </button>
        ))}
      </div>
      <p className="muted">{query.trim() ? query : t.mentionFilterHint}</p>
      <div id={`mention-panel-${tab}`} role="tabpanel" aria-labelledby={`mention-tab-${tab}`}>
        {tab === 'files' ? (
          <DirectoryTree
            directories={catalog.directories}
            files={catalog.files.filter((f) => sourceState(f, catalog.directories) === 'files')}
            t={t}
            actions={actions}
            mode="file"
            query={query}
            storageKey="tl:tree:mentions"
            active={fileId}
            chooseFile={pickFile}
          />
        ) : (
          <div className="mention-concepts" role="listbox" aria-label={t.mentionGlossary}>
            {concepts.length ? (
              concepts.map((entry, i) => (
                <button
                  type="button"
                  key={entry.id}
                  role="option"
                  aria-selected={index === i}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pickConcept(entry)}
                  title={entry.definition}
                >
                  <strong>
                    <BookOpen size={14} />
                    {entry.term}
                  </strong>
                  <p>{entry.definition.slice(0, 260)}</p>
                  <small>
                    {t.revision} {entry.version} · {entry.reviewed ? t.reviewed : t.notReviewed}
                  </small>
                </button>
              ))
            ) : (
              <p className="small-empty">{t.noMatchingConcepts}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
});
