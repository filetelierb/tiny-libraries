import type { Artifact, Segment } from '../shared/domain';
import type { T } from './i18n';
import { SignalExplorer } from './SignalExplorer';
import { Button } from './design/components';
import { StudyMarkdown } from './study/StudyMarkdown';

type Parameters = { frequency: number; sampling: number; amplitude: number };
export function GeneratedArtifact({
  artifact,
  t,
  segments,
  onCite,
  saved,
  persist,
  storageKey = 'tl:generated-signal',
}: {
  artifact: Artifact;
  t: T;
  segments: Segment[];
  onCite: (s: Segment) => void;
  saved?: Parameters;
  persist: (p: Parameters) => void;
  storageKey?: string;
}) {
  return (
    <section className="generated-artifact">
      <div className="section-label">{t.explanation}</div>
      <h2>{artifact.title}</h2>
      <StudyMarkdown t={t}>{artifact.explanation}</StudyMarkdown>
      <div className="citations">
        {artifact.segmentIds.map((id) => {
          const source = segments.find((s) => s.id === id);
          return source ? (
            <button key={id} title={source.text} onClick={() => onCite(source)}>
              {source.page ? `${t.page} ${source.page}` : id}
            </button>
          ) : null;
        })}
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
    </section>
  );
}
