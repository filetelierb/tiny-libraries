import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Artifact, Segment } from '../shared/domain';
import type { T } from './i18n';
import { SignalExplorer } from './SignalExplorer';
import { Button } from './design/components';
import { StudyMarkdown } from './study/StudyMarkdown';

type Parameters = { frequency: number; sampling: number; amplitude: number };
type OutlineEntry = { id: string; level: 2 | 3; label: string };
export function GeneratedArtifact({
  artifact,
  t,
  segments,
  onCite,
  saved,
  persist,
  storageKey = 'tl:generated-signal',
  sourceName,
}: {
  artifact: Artifact;
  t: T;
  segments: Segment[];
  onCite: (s: Segment) => void;
  saved?: Parameters;
  persist: (p: Parameters) => void;
  storageKey?: string;
  sourceName?: string;
}) {
  // Citations are numbered by first appearance and listed again under References.
  const cited = [...new Set(artifact.segmentIds)]
    .map((id) => segments.find((segment) => segment.id === id))
    .filter((segment): segment is Segment => !!segment);
  const label = (segment: Segment) =>
    [sourceName, segment.page ? `${t.page} ${segment.page}` : segment.id]
      .filter(Boolean)
      .join(' · ');
  const root = useRef<HTMLElement>(null),
    [outline, setOutline] = useState<OutlineEntry[]>([]),
    [current, setCurrent] = useState(''),
    [outlineOpen, setOutlineOpen] = useState(true);
  // Headings come from rendered markdown, so the outline is read back from the DOM.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    let h2 = 0,
      h3 = 0;
    const entries: OutlineEntry[] = [
      ...element.querySelectorAll<HTMLElement>('.study-markdown h2, .study-markdown h3'),
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
      };
    });
    const references = element.querySelector<HTMLElement>('.artifact-references');
    if (references) {
      references.id ||= 'artifact-references';
      entries.push({ id: references.id, level: 2, label: t.artifactReferences });
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
    spy();
    scroller.addEventListener('scroll', spy, { passive: true });
    return () => scroller.removeEventListener('scroll', spy);
  }, [artifact, segments, t]);
  return (
    <section className="generated-artifact" ref={root}>
      <div className="section-label">{t.explanation}</div>
      <h2>{artifact.title}</h2>
      {outline.length >= 2 && (
        <nav className="artifact-outline" aria-label={t.chapterIndex}>
          <button
            type="button"
            aria-expanded={outlineOpen}
            onClick={() => setOutlineOpen((value) => !value)}
          >
            {outlineOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {t.chapterIndex}
          </button>
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
                </li>
              ))}
            </ol>
          )}
        </nav>
      )}
      <StudyMarkdown t={t}>{artifact.explanation}</StudyMarkdown>
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
                  <th scope="row">{row.label}</th>
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
      {cited.length > 0 && (
        <section className="artifact-references" aria-label={t.artifactReferences}>
          <h3>{t.artifactReferences}</h3>
          <ol>
            {cited.map((segment) => (
              <li key={segment.id}>
                <button type="button" onClick={() => onCite(segment)}>
                  {label(segment)}
                </button>
                <span>
                  {segment.text.slice(0, 160)}
                  {segment.text.length > 160 ? '…' : ''}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </section>
  );
}
