import { useState } from 'react';
import type { Artifact, Segment } from '../shared/domain';
import type { T } from './i18n';
import { SignalExplorer } from './SignalExplorer';
import { Button } from './design/components';

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
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <section className="generated-artifact">
      <div className="section-label">{t.explanation}</div>
      <h2>{artifact.title}</h2>
      <p className="muted">{artifact.explanation}</p>
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
        <div className="comparison">
          <div className="comparison-head">
            <span>{artifact.leftTitle}</span>
            <span>{artifact.rightTitle}</span>
          </div>
          {artifact.rows.map((row, i) => (
            <section className={selected === i ? 'selected' : ''} key={i}>
              <button
                onClick={() => setSelected(selected === i ? null : i)}
                aria-expanded={selected === i}
              >
                {row.label}
              </button>
              {selected === i && (
                <div>
                  <p>{row.left}</p>
                  <p>{row.right}</p>
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
