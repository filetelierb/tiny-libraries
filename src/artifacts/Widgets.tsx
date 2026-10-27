import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { compileExpression, parseWidget, type ArtifactWidget } from '../../shared/artifact-widgets';
import { Button } from '../design/components';
import type { T } from '../i18n';
import { Formula } from '../study/Formula';
import { StudyMarkdown } from '../study/StudyMarkdown';

/** What widgets need from the artifact around them: citations and the source's pictures. */
export type WidgetHost = {
  cite?: (segmentId: string) => void;
  citeNumber?: (segmentId: string) => number | undefined;
  imageUrl?: (segmentId: string) => string;
};
export const WidgetHostContext = createContext<WidgetHost>({});

/** Widget fields are plain text whose only markup is inline math: `$latex$` or `\(latex\)`. */
function WidgetText({ text }: { text: string }) {
  const pieces: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/\$([^$\n]+)\$|\\\(([\s\S]+?)\\\)/g)) {
    pieces.push(text.slice(last, match.index));
    pieces.push(<Formula key={match.index} source={match[1] ?? match[2]} />);
    last = match.index + match[0].length;
  }
  pieces.push(text.slice(last));
  return <>{pieces}</>;
}

function Cite({ segmentId, t }: { segmentId?: string; t: T }) {
  const host = useContext(WidgetHostContext);
  if (!segmentId || !host.cite) return null;
  const number = host.citeNumber?.(segmentId);
  return (
    <button
      type="button"
      className="artifact-cite"
      title={`${t.source}: ${segmentId}`}
      aria-label={`${t.source}: ${segmentId}`}
      onClick={() => host.cite!(segmentId)}
    >
      {number ?? '↗'}
    </button>
  );
}

function Caption({ text, t }: { text?: string; t: T }) {
  return text ? (
    <p className="artifact-caption">
      <span>{t.whatToObserve}</span> <WidgetText text={text} />
    </p>
  ) : null;
}

function Steps({ widget, t }: { widget: Extract<ArtifactWidget, { type: 'steps' }>; t: T }) {
  const [active, setActive] = useState(0);
  const step = widget.steps[active];
  return (
    <figure className="artifact-widget artifact-steps">
      <figcaption>{widget.title}</figcaption>
      <ol role="tablist" aria-label={widget.title}>
        {widget.steps.map((item, index) => (
          <li key={index}>
            <button
              type="button"
              role="tab"
              aria-selected={index === active}
              className={index === active ? 'active' : index < active ? 'done' : ''}
              onClick={() => setActive(index)}
            >
              <span>{index + 1}</span>
              {item.title}
            </button>
          </li>
        ))}
      </ol>
      <div role="tabpanel" className="artifact-step-body">
        <p className="artifact-step-title">
          {t.stepLabel} {active + 1} · <WidgetText text={step.title} />
          <Cite segmentId={step.segmentId} t={t} />
        </p>
        <p>
          <WidgetText text={step.body} />
        </p>
        <div className="artifact-step-nav">
          <Button
            size="sm"
            variant="default"
            disabled={active === 0}
            onClick={() => setActive(active - 1)}
          >
            <ChevronLeft />
            {t.previousStep}
          </Button>
          <Button
            size="sm"
            variant="default"
            disabled={active === widget.steps.length - 1}
            onClick={() => setActive(active + 1)}
          >
            {t.nextStep}
            <ChevronRight />
          </Button>
        </div>
      </div>
      <Caption text={widget.caption} t={t} />
    </figure>
  );
}

function Timeline({ widget, t }: { widget: Extract<ArtifactWidget, { type: 'timeline' }>; t: T }) {
  const [active, setActive] = useState(0);
  const event = widget.events[active];
  return (
    <figure className="artifact-widget artifact-timeline">
      <figcaption>{widget.title}</figcaption>
      <ol>
        {widget.events.map((item, index) => (
          <li key={index}>
            <button
              type="button"
              aria-current={index === active ? 'step' : undefined}
              className={index === active ? 'active' : ''}
              onClick={() => setActive(index)}
            >
              <span className="artifact-timeline-label">{item.label}</span>
              <span>
                <WidgetText text={item.title} />
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="artifact-step-body">
        <p className="artifact-step-title">
          {event.label} · <WidgetText text={event.title} />
          <Cite segmentId={event.segmentId} t={t} />
        </p>
        {event.body && (
          <p>
            <WidgetText text={event.body} />
          </p>
        )}
      </div>
      <Caption text={widget.caption} t={t} />
    </figure>
  );
}

function Predict({ widget, t }: { widget: Extract<ArtifactWidget, { type: 'predict' }>; t: T }) {
  const [choice, setChoice] = useState<number | null>(null),
    [revealed, setRevealed] = useState(false);
  const graded = revealed && choice !== null && widget.correctIndex !== undefined;
  return (
    <section className="artifact-widget artifact-predict" aria-label={t.predictTitle}>
      <p className="artifact-summary-title">{t.predictTitle}</p>
      <p className="artifact-predict-prompt">
        <WidgetText text={widget.prompt} />
      </p>
      {widget.choices.length > 0 && (
        <div className="artifact-predict-choices">
          {widget.choices.map((option, index) => (
            <button
              key={index}
              type="button"
              disabled={revealed}
              aria-pressed={choice === index}
              className={
                graded && index === widget.correctIndex
                  ? 'correct'
                  : graded && index === choice
                    ? 'incorrect'
                    : choice === index
                      ? 'chosen'
                      : ''
              }
              onClick={() => setChoice(index)}
            >
              <WidgetText text={option} />
            </button>
          ))}
        </div>
      )}
      {revealed ? (
        <output className="artifact-step-body">
          {graded && (
            <p className="artifact-step-title">
              {choice === widget.correctIndex ? t.predictRight : t.predictWrong}
            </p>
          )}
          <p>
            <WidgetText text={widget.reveal} />
          </p>
        </output>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          disabled={widget.choices.length > 0 && choice === null}
          onClick={() => setRevealed(true)}
        >
          {widget.choices.length ? t.predictCheck : t.predictReveal}
        </Button>
      )}
      <Caption text={widget.caption} t={t} />
    </section>
  );
}

const formatNumber = (value: number, digits = 2) =>
  Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : '—';

function Explorable({
  widget,
  t,
}: {
  widget: Extract<ArtifactWidget, { type: 'explorable' }>;
  t: T;
}) {
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries(widget.params.map((param) => [param.id, param.value])),
  );
  const compiled = useMemo(() => {
    const ids = widget.params.map((param) => param.id);
    return {
      outputs: widget.outputs.map((output) => compileExpression(output.expr, ids)),
      notes: widget.notes.map((note) => compileExpression(note.when, ids)),
      plot: widget.plot ? compileExpression(widget.plot.expr, ids) : null,
    };
  }, [widget]);
  const axis = widget.plot && widget.params.find((param) => param.id === widget.plot!.x);
  const curve = useMemo(() => {
    if (!axis || !compiled.plot) return null;
    const points = Array.from({ length: 121 }, (_, index) => {
      const x = axis.min + ((axis.max - axis.min) * index) / 120;
      return [x, compiled.plot!({ ...values, [axis.id]: x })] as const;
    }).filter(([, y]) => Number.isFinite(y));
    if (points.length < 2) return null;
    const ys = points.map(([, y]) => y),
      low = Math.min(...ys),
      high = Math.max(...ys),
      span = high - low || 1;
    const sx = (x: number) => 40 + ((x - axis.min) / (axis.max - axis.min)) * 580,
      sy = (y: number) => 190 - ((y - low) / span) * 170;
    const current = compiled.plot({ ...values });
    return {
      path: points
        .map(([x, y], index) => `${index ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`)
        .join(''),
      marker: Number.isFinite(current) ? [sx(values[axis.id]), sy(current)] : null,
      low,
      high,
    };
  }, [axis, compiled, values]);
  return (
    <figure className="artifact-widget artifact-explorer">
      <figcaption>{widget.title}</figcaption>
      <div className="artifact-explorable-grid">
        <div className="artifact-explorable-params">
          {widget.params.map((param) => (
            <label key={param.id}>
              <span>
                {param.label}
                <strong>
                  {formatNumber(values[param.id], 4)}
                  {param.unit ? ` ${param.unit}` : ''}
                </strong>
              </span>
              <input
                type="range"
                min={param.min}
                max={param.max}
                step={param.step}
                value={values[param.id]}
                onChange={(event) =>
                  setValues({ ...values, [param.id]: Number(event.target.value) })
                }
              />
            </label>
          ))}
        </div>
        <dl className="artifact-explorable-outputs" aria-live="polite">
          {widget.outputs.map((output, index) => (
            <div key={index}>
              <dt>
                <WidgetText text={output.label} />
              </dt>
              <dd>
                {compiled.outputs[index]
                  ? formatNumber(compiled.outputs[index]!(values), output.digits)
                  : '—'}
                {output.unit ? ` ${output.unit}` : ''}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {curve && (
        <svg
          viewBox="0 0 640 210"
          className="artifact-chart"
          aria-label={widget.plot?.label || widget.title}
        >
          <line x1={40} x2={620} y1={190} y2={190} className="axis" />
          <line x1={40} x2={40} y1={20} y2={190} className="axis" />
          <text x={36} y={24} textAnchor="end">
            {formatNumber(curve.high)}
          </text>
          <text x={36} y={190} textAnchor="end">
            {formatNumber(curve.low)}
          </text>
          <text x={620} y={206} textAnchor="end">
            {axis?.label}
          </text>
          <path d={curve.path} fill="none" strokeWidth={2.5} style={{ stroke: 'var(--chart-1)' }} />
          {curve.marker && (
            <circle
              cx={curve.marker[0]}
              cy={curve.marker[1]}
              r={5}
              style={{ fill: 'var(--chart-2)' }}
            />
          )}
        </svg>
      )}
      {widget.notes.map((note, index) =>
        compiled.notes[index]?.(values) ? (
          <p key={index} className="artifact-explorable-note">
            <WidgetText text={note.text} />
          </p>
        ) : null,
      )}
      <Caption text={widget.caption} t={t} />
    </figure>
  );
}

function Chart({ widget, t }: { widget: Extract<ArtifactWidget, { type: 'chart' }>; t: T }) {
  const values = widget.series.flatMap((item) => item.values);
  const max = Math.max(...values, 0),
    min = Math.min(...values, 0),
    span = max - min || 1;
  const width = 640,
    height = 260,
    left = 44,
    bottom = 36,
    plotW = width - left - 12,
    plotH = height - bottom - 12;
  const y = (value: number) => 12 + plotH - ((value - min) / span) * plotH;
  const band = plotW / widget.labels.length;
  return (
    <figure className="artifact-widget">
      <figcaption>
        {widget.title}
        {widget.unit && <span className="artifact-chart-unit"> ({widget.unit})</span>}
        <Cite segmentId={widget.segmentId} t={t} />
      </figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} aria-label={widget.title} className="artifact-chart">
        <line x1={left} x2={width - 12} y1={y(0)} y2={y(0)} className="axis" />
        <text x={left - 6} y={y(max) + 4} textAnchor="end">
          {max}
        </text>
        {min < 0 && (
          <text x={left - 6} y={y(min) + 4} textAnchor="end">
            {min}
          </text>
        )}
        {widget.series.map((series, s) =>
          widget.kind === 'line' ? (
            <polyline
              key={s}
              fill="none"
              strokeWidth={2.5}
              style={{ stroke: `var(--chart-${s + 1})` }}
              points={series.values
                .map((value, i) => `${left + band * (i + 0.5)},${y(value)}`)
                .join(' ')}
            />
          ) : (
            series.values.map((value, i) => {
              const w = (band * 0.7) / widget.series.length;
              return (
                <rect
                  key={`${s}-${i}`}
                  x={left + band * i + band * 0.15 + w * s}
                  width={w}
                  y={Math.min(y(value), y(0))}
                  height={Math.abs(y(value) - y(0))}
                  rx={3}
                  style={{ fill: `var(--chart-${s + 1})` }}
                >
                  <title>{`${widget.labels[i]} · ${series.name}: ${value}${widget.unit || ''}`}</title>
                </rect>
              );
            })
          ),
        )}
        {widget.labels.map((label, i) => (
          <text key={i} x={left + band * (i + 0.5)} y={height - 12} textAnchor="middle">
            {label.length > 14 ? `${label.slice(0, 13)}…` : label}
          </text>
        ))}
      </svg>
      {widget.series.length > 1 && (
        <p className="artifact-legend">
          {widget.series.map((series, s) => (
            <span key={s}>
              <i style={{ background: `var(--chart-${s + 1})` }} />
              {series.name}
            </span>
          ))}
        </p>
      )}
      <Caption text={widget.caption} t={t} />
    </figure>
  );
}

function Widget({ widget, t }: { widget: ArtifactWidget; t: T }): ReactNode {
  const host = useContext(WidgetHostContext);
  switch (widget.type) {
    case 'summary':
      return (
        <section
          className="artifact-widget artifact-summary"
          aria-label={widget.title || t.summaryTitle}
        >
          <p className="artifact-summary-title">{widget.title || t.summaryTitle}</p>
          <ol>
            {widget.points.map((point, index) => (
              <li key={index}>
                <WidgetText text={point.text} />
                <Cite segmentId={point.segmentId} t={t} />
              </li>
            ))}
          </ol>
          <Caption text={widget.caption} t={t} />
        </section>
      );
    case 'compare':
      return (
        <figure className="artifact-widget artifact-compare">
          <figcaption>{widget.title}</figcaption>
          <div className="artifact-table-scroll">
            <table className="artifact-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">{t.compareItem}</span>
                  </th>
                  {widget.columns.map((column, index) => (
                    <th key={index} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {widget.rows.map((row, index) => (
                  <tr key={index}>
                    <th scope="row">
                      <WidgetText text={row.label} />
                      <Cite segmentId={row.segmentId} t={t} />
                    </th>
                    {row.cells.map((cell, c) => (
                      <td key={c} data-label={widget.columns[c]}>
                        <WidgetText text={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Caption text={widget.caption} t={t} />
        </figure>
      );
    case 'steps':
      return <Steps widget={widget} t={t} />;
    case 'timeline':
      return <Timeline widget={widget} t={t} />;
    case 'predict':
      return <Predict widget={widget} t={t} />;
    case 'explorable':
      return <Explorable widget={widget} t={t} />;
    case 'chart':
      return <Chart widget={widget} t={t} />;
    case 'image':
      return host.imageUrl ? (
        <figure className="artifact-widget">
          <img src={host.imageUrl(widget.segmentId)} alt={widget.alt} loading="lazy" />
          <figcaption className="artifact-image-caption">
            {widget.caption}
            <Cite segmentId={widget.segmentId} t={t} />
          </figcaption>
        </figure>
      ) : null;
    case 'details':
      return (
        <details className="artifact-details">
          <summary>{widget.summary}</summary>
          <StudyMarkdown t={t}>{widget.body}</StudyMarkdown>
        </details>
      );
  }
}

/** Renders a ```widget block; malformed data falls back to showing the block as code. */
export function WidgetBlock({ source, t }: { source: string; t: T }) {
  const widget = useMemo(() => parseWidget(source), [source]);
  if (!widget)
    return (
      <pre tabIndex={0} className="artifact-widget-invalid" title={t.widgetInvalid}>
        <code>{source}</code>
      </pre>
    );
  return <Widget widget={widget} t={t} />;
}
