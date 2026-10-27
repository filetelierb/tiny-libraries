import { useState } from 'react';
import type { T } from './i18n';
import { Button } from './design/components';
import { RotateCcw } from 'lucide-react';

export function aliasFrequency(frequency: number, sampling: number) {
  return Math.abs(((((frequency + sampling / 2) % sampling) + sampling) % sampling) - sampling / 2);
}
export function SignalExplorer({
  t,
  storageKey,
  initial,
  onPersist,
}: {
  t: T;
  storageKey: string;
  initial?: { frequency: number; sampling: number; amplitude: number };
  onPersist?: (value: { frequency: number; sampling: number; amplitude: number }) => void;
}) {
  const [parameters, setParameters] = useState<{
    frequency: number;
    sampling: number;
    amplitude: number;
  }>(() => {
    if (initial) return initial;
    try {
      return (
        JSON.parse(localStorage.getItem(storageKey) || 'null') || {
          frequency: 8,
          sampling: 12,
          amplitude: 0.8,
        }
      );
    } catch {
      return { frequency: 8, sampling: 12, amplitude: 0.8 };
    }
  });
  const { frequency, sampling, amplitude } = parameters;
  const change = (key: keyof typeof parameters, value: number) => {
    const next = { ...parameters, [key]: value };
    setParameters(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
    onPersist?.(next);
  };
  const x = (time: number) => 40 + time * 540,
    y = (value: number) => 130 - value * 85;
  const path = Array.from(
    { length: 601 },
    (_, i) =>
      `${i ? 'L' : 'M'}${x(i / 600)},${y(amplitude * Math.sin((2 * Math.PI * frequency * i) / 600))}`,
  ).join(' ');
  const alias = aliasFrequency(frequency, sampling);
  const aliasing = sampling < 2 * frequency;
  return (
    <figure className="artifact-widget signal-explorer">
      <figcaption>
        <span className="artifact-eyebrow">{t.artifact}</span>
        <span className="artifact-title">{t.example}</span>
      </figcaption>
      <div className="artifact-explorable">
        <div className="artifact-params">
          {(
            [
              ['frequency', t.frequency, 1, 24, 0.5, 'Hz'],
              ['sampling', t.sampling, 2, 60, 1, 'Hz'],
              ['amplitude', t.amplitude, 0.1, 1, 0.1, ''],
            ] as const
          ).map(([key, label, min, max, step, unit]) => (
            <label key={key}>
              <span>
                {label}
                <strong>
                  {parameters[key]} {unit}
                </strong>
              </span>
              <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={parameters[key]}
                onChange={(e) => change(key, Number(e.target.value))}
              />
            </label>
          ))}
        </div>
        <div className="artifact-output">
          <dl>
            <div>
              <dt>{t.alias}</dt>
              <dd>{alias.toFixed(1)} Hz</dd>
            </div>
            <div>
              <dt>{t.nyquistRate}</dt>
              <dd>{(2 * frequency).toFixed(1)} Hz</dd>
            </div>
          </dl>
          <p className="artifact-note">{aliasing ? t.aliasingNote : t.cleanSamplingNote}</p>
        </div>
      </div>
      <svg
        viewBox="0 0 620 270"
        role="img"
        aria-label={`${t.frequency}: ${frequency} Hz; ${t.sampling}: ${sampling} Hz; ${t.alias}: ${alias} Hz`}
      >
        <path d="M40 130H580" stroke="var(--border)" />
        <path d={path} fill="none" stroke="var(--chart-1)" strokeWidth="2.5" />
        {Array.from({ length: Math.floor(sampling) + 1 }, (_, i) => (
          <circle
            key={i}
            cx={x(i / sampling)}
            cy={y(amplitude * Math.sin((2 * Math.PI * frequency * i) / sampling))}
            r="5"
            fill="var(--chart-2)"
          />
        ))}
        <text x="40" y="252" fill="var(--muted-text)" fontSize="12">
          0 s
        </text>
        <text x="560" y="252" fill="var(--muted-text)" fontSize="12">
          1 s
        </text>
      </svg>
      <p className="artifact-caption">
        <span>{t.signalCaptionLead}</span> {t.artifactBody}
      </p>
      <div className="signal-result">
        <span className="muted">{t.persisted}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const next = { frequency: 8, sampling: 12, amplitude: 0.8 };
            setParameters(next);
            localStorage.setItem(storageKey, JSON.stringify(next));
            onPersist?.(next);
          }}
        >
          <RotateCcw size={14} />
          {t.reset}
        </Button>
      </div>
    </figure>
  );
}
