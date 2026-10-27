import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { BookOpen, ChevronDown, ChevronRight, ListChecks } from 'lucide-react';
import type { Artifact, Segment } from '../shared/domain';
import type { T } from './i18n';
import { SignalExplorer } from './SignalExplorer';
import { Button } from './design/components';
import { StudyMarkdown } from './study/StudyMarkdown';
import {
  CONCEPT_LINK_MAX,
  conceptMatcher,
  remarkConceptLinks,
  type LinkableConcept,
} from './glossary/conceptLinks';
import { WidgetHostContext, type WidgetHost } from './artifacts/Widgets';
import {
  ArtifactCards,
  ArtifactChapterActions,
  ArtifactStudyStatus,
  useArtifactStudy,
  type ArtifactStudyChapterView,
  type ArtifactStudyHost,
} from './artifacts/ArtifactStudy';
import { widgetSegments } from '../shared/artifact-widgets';

type Parameters = { frequency: number; sampling: number; amplitude: number };
type OutlineEntry = { id: string; level: 2 | 3; label: string; chapter: number };
const noConcepts: LinkableConcept[] = [];
const recall = (key: string) => {
  try {
    return key ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembering the position is a convenience only.
  }
};
export function GeneratedArtifact({
  artifact,
  t,
  segments,
  onCite,
  saved,
  persist,
  storageKey = 'tl:generated-signal',
  sourceName,
  sourceUrl,
  pictures,
  concepts = noConcepts,
  openConcept,
  study,
}: {
  artifact: Artifact;
  t: T;
  segments: Segment[];
  onCite: (s: Segment) => void;
  saved?: Parameters;
  persist: (p: Parameters) => void;
  storageKey?: string;
  sourceName?: string;
  /** Original file; references link to it so a modified click opens it in a new tab. */
  sourceUrl?: string;
  /** Base URL of the source's stored pictures, for image widgets. */
  pictures?: string;
  concepts?: LinkableConcept[];
  openConcept?: (id: string) => void;
  /** Chapter quizzes and cards; only the latest version of a source artifact has them. */
  study?: ArtifactStudyHost;
}) {
  // Citations are numbered by first appearance and listed again under References.
  const widgetCites = useMemo(() => widgetSegments(artifact.explanation), [artifact.explanation]);
  const cited = [...new Set([...artifact.segmentIds, ...widgetCites])]
    .map((id) => segments.find((segment) => segment.id === id))
    .filter((segment): segment is Segment => !!segment);
  const label = (segment: Segment) =>
    [sourceName, segment.page ? `${t.page} ${segment.page}` : segment.id]
      .filter(Boolean)
      .join(' · ');
  // Glossary terms in the text open the Glossary focused on that entry.
  const linkable = openConcept ? concepts : noConcepts,
    matcher = useMemo(() => conceptMatcher(linkable), [linkable]),
    conceptPlugins = useMemo(
      () =>
        linkable.length
          ? [[remarkConceptLinks, linkable] as [typeof remarkConceptLinks, LinkableConcept[]]]
          : [],
      [linkable],
    ),
    conceptComponents = useMemo(
      () => ({
        button: ({ node: _node, ...props }: ComponentProps<'button'> & { node?: unknown }) => {
          const id = (props as { 'data-concept'?: string })['data-concept'];
          return id ? (
            <button {...props} title={t.openInGlossary} onClick={() => openConcept?.(id)} />
          ) : (
            <button {...props} />
          );
        },
      }),
      [openConcept, t],
    );
  const conceptLabel = (label: string) => {
    const id = matcher?.idFor(label.trim());
    if (!id || !openConcept) return label;
    return label.length <= CONCEPT_LINK_MAX ? (
      <button
        type="button"
        className="artifact-concept"
        title={t.openInGlossary}
        onClick={() => openConcept(id)}
      >
        {label}
      </button>
    ) : (
      <>
        {label}
        <button
          type="button"
          className="artifact-concept-chip"
          title={t.openInGlossary}
          aria-label={`${t.openInGlossary}: ${label}`}
          onClick={() => openConcept(id)}
        >
          <BookOpen aria-hidden />
        </button>
      </>
    );
  };
  const host = useMemo<WidgetHost>(
    () => ({
      cite: (id) => {
        const segment = segments.find((item) => item.id === id);
        if (segment) onCite(segment);
      },
      citeNumber: (id) => {
        const index = cited.findIndex((segment) => segment.id === id);
        return index < 0 ? undefined : index + 1;
      },
      ...(pictures ? { imageUrl: (id: string) => `${pictures}/${encodeURIComponent(id)}` } : {}),
    }),
    [segments, onCite, cited.map((segment) => segment.id).join('\n'), pictures],
  );
  const positionKey = study ? `tl:artifact-chapter:${study.sourceId}` : '',
    reached = useRef(0),
    prompted = useRef(new Set<string>());
  const root = useRef<HTMLElement>(null),
    [outline, setOutline] = useState<OutlineEntry[]>([]),
    [current, setCurrent] = useState(''),
    [outlineOpen, setOutlineOpen] = useState(true),
    [cardsChapter, setCardsChapter] = useState<ArtifactStudyChapterView | null>(null),
    [miniQuizzes, setMiniQuizzes] = useState(() => {
      try {
        return localStorage.getItem('tl:artifact-mini-quizzes') !== 'off';
      } catch {
        return true;
      }
    });
  const studyState = useArtifactStudy(study?.sourceId, artifact.explanation),
    ready = studyState.snapshot?.status === 'ready' ? studyState.snapshot : null;
  const studyChapter = (chapter: number) =>
    ready?.chapters.find((item) => item.index === chapter - 1);
  const attempted = (chapter: ArtifactStudyChapterView) =>
    !!ready &&
    !!study?.attempts.some(
      (attempt) => attempt.chapterId === chapter.id && attempt.learningVersion === ready.version,
    );
  // Headings come from rendered markdown, so the outline is read back from the DOM.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let h2 = 0,
      h3 = 0;
    // Only the artifact's own headings: nested markdown (e.g. expandable widgets) is not a chapter.
    const entries: OutlineEntry[] = [
      ...element.querySelectorAll<HTMLElement>(':scope > .study-markdown > :is(h2, h3)'),
    ].map((heading, index) => {
      heading.id ||= `artifact-heading-${index}`;
      const level = heading.tagName === 'H2' ? 2 : 3;
      if (level === 2) {
        h2++;
        h3 = 0;
      } else h3++;
      return {
        id: heading.id,
        level,
        label: `${level === 2 ? `${h2}.` : `${h2}.${h3}`} ${heading.textContent || ''}`,
        chapter: h2,
      };
    });
    const references = element.querySelector<HTMLElement>('.artifact-references');
    if (references) {
      references.id ||= 'artifact-references';
      entries.push({ id: references.id, level: 2, label: t.artifactReferences, chapter: h2 + 1 });
    }
    setOutline(entries);
    const scroller = element.closest<HTMLElement>('.artifact-stage');
    if (!scroller || entries.length < 2) return;
    const spy = () => {
      const top = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      const passed = entries.filter(
        (entry) => (document.getElementById(entry.id)?.getBoundingClientRect().top ?? 0) <= top,
      );
      const end = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      setCurrent(end ? entries.at(-1)!.id : passed.at(-1)?.id || entries[0].id);
    };
    // Reopening the artifact returns to the chapter the student was reading.
    const saved = Number(recall(positionKey));
    const target = entries.find((entry) => entry.level === 2 && entry.chapter === saved);
    if (target && saved > 1) {
      reached.current = saved;
      requestAnimationFrame(() =>
        document.getElementById(target.id)?.scrollIntoView({ block: 'start' }),
      );
    }
    spy();
    scroller.addEventListener('scroll', spy, { passive: true });
    return () => scroller.removeEventListener('scroll', spy);
  }, [artifact, segments, t]);
  const chapterNow = outline.find((entry) => entry.id === current)?.chapter || 0;
  // Moving on by exactly one chapter offers the quiz of the chapter just finished, once.
  useEffect(() => {
    if (!chapterNow) return;
    const previous = reached.current;
    reached.current = chapterNow;
    if (positionKey) remember(positionKey, String(chapterNow));
    if (!study || !ready || !miniQuizzes || chapterNow !== previous + 1) return;
    const finished = studyChapter(previous);
    if (finished?.questions.length && !attempted(finished) && !prompted.current.has(finished.id)) {
      prompted.current.add(finished.id);
      study.quiz(finished, ready.version);
    }
  }, [chapterNow]);
  return (
    <section className="generated-artifact" ref={root}>
      <div className="section-label">{t.explanation}</div>
      <h2>{artifact.title}</h2>
      {(outline.length >= 2 || ready) && (
        <nav className="artifact-outline" aria-label={t.chapterIndex}>
          <div className="artifact-outline-head">
            <button
              type="button"
              aria-expanded={outlineOpen}
              onClick={() => setOutlineOpen((value) => !value)}
            >
              {outlineOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              {t.chapterIndex}
            </button>
            {ready && (
              <Button
                size="sm"
                variant={miniQuizzes ? 'secondary' : 'ghost'}
                aria-pressed={miniQuizzes}
                title={t.miniQuizzesHint}
                onClick={() => {
                  setMiniQuizzes(!miniQuizzes);
                  remember('tl:artifact-mini-quizzes', miniQuizzes ? 'off' : 'on');
                }}
              >
                <ListChecks />
                {t.miniQuizzes}
              </Button>
            )}
          </div>
          {outlineOpen && study && (
            <ArtifactStudyStatus
              snapshot={studyState.snapshot}
              error={studyState.error}
              generate={() => void studyState.generate()}
              t={t}
            />
          )}
          {outlineOpen && (
            <ol>
              {outline.map((entry) => (
                <li key={entry.id} className={entry.level === 3 ? 'nested' : ''}>
                  <a
                    href={`#${entry.id}`}
                    aria-current={current === entry.id ? 'location' : undefined}
                    onClick={(event) => {
                      event.preventDefault();
                      document
                        .getElementById(entry.id)
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  >
                    {entry.label}
                  </a>
                  {(() => {
                    const chapter =
                      entry.level === 2 && study && ready && studyChapter(entry.chapter);
                    return chapter ? (
                      <ArtifactChapterActions
                        chapter={chapter}
                        attempted={attempted(chapter)}
                        quiz={() => study.quiz(chapter, ready.version)}
                        cards={() => setCardsChapter(chapter)}
                        t={t}
                      />
                    ) : null;
                  })()}
                </li>
              ))}
            </ol>
          )}
        </nav>
      )}
      {cardsChapter && (
        <ArtifactCards chapter={cardsChapter} t={t} close={() => setCardsChapter(null)} />
      )}
      <WidgetHostContext.Provider value={host}>
        <StudyMarkdown t={t} remarkPlugins={conceptPlugins} components={conceptComponents}>
          {artifact.explanation}
        </StudyMarkdown>
      </WidgetHostContext.Provider>
      <div className="citations">
        {cited.map((segment, index) => (
          <button
            key={segment.id}
            title={label(segment)}
            aria-label={`${t.source} ${index + 1}: ${label(segment)}`}
            onClick={() => onCite(segment)}
          >
            {index + 1}
          </button>
        ))}
      </div>
      {artifact.kind === 'signal' ? (
        <SignalExplorer
          t={t}
          storageKey={storageKey}
          initial={saved || artifact}
          onPersist={persist}
        />
      ) : (
        <figure className="artifact-widget comparison">
          <table className="artifact-table">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col">{artifact.leftTitle}</th>
                <th scope="col">{artifact.rightTitle}</th>
              </tr>
            </thead>
            <tbody>
              {artifact.rows.map((row, i) => (
                <tr key={i}>
                  <th scope="row">{conceptLabel(row.label)}</th>
                  <td>
                    <StudyMarkdown t={t}>{row.left}</StudyMarkdown>
                  </td>
                  <td>
                    <StudyMarkdown t={t}>{row.right}</StudyMarkdown>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      )}
      <footer className="artifact-references" aria-label={t.artifactReferences}>
        <h3>{t.artifactReferences}</h3>
        {cited.length ? (
          <ol>
            {cited.map((segment) => (
              <li key={segment.id}>
                <a
                  href={sourceUrl || '#'}
                  target={sourceUrl ? '_blank' : undefined}
                  rel="noreferrer"
                  onClick={(event) => {
                    if (
                      sourceUrl &&
                      (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                    )
                      return;
                    event.preventDefault();
                    onCite(segment);
                  }}
                >
                  {label(segment)}
                </a>
                <span>
                  {segment.text.slice(0, 160)}
                  {segment.text.length > 160 ? '…' : ''}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted">{t.artifactNoReferences}</p>
        )}
        <p className="muted artifact-edit-hint">{t.artifactTutorHint}</p>
      </footer>
    </section>
  );
}
