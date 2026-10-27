import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Maximize2, Pause, Play } from 'lucide-react';
import type { T } from '../i18n';
import { Button, Modal } from '../design/components';
import { renderDiagram, type DiagramFlow, type DiagramImage } from './diagrams';

type FlowStep = { kind: 'node'; id: string } | { kind: 'link'; id: string };
const FLOW_STEP_MS = 1800;

/** Walks a flowchart from its first link: each node, then the link leaving it, and so on. */
export function flowSteps(flow: DiagramFlow): FlowStep[] {
  if (!flow.links.length) return flow.nodes.map((node) => ({ kind: 'node', id: node.id }));
  return [
    { kind: 'node', id: flow.links[0].from },
    ...flow.links.flatMap((link): FlowStep[] => [
      { kind: 'link', id: link.id },
      { kind: 'node', id: link.to },
    ]),
  ];
}

/** Lets students select nodes on the diagram image and play the flow step by step. */
function FlowExplorer({ image, flow, t }: { image: DiagramImage; flow: DiagramFlow; t: T }) {
  const steps = useMemo(() => flowSteps(flow), [flow]);
  const [selected, setSelected] = useState<FlowStep | null>(null),
    [step, setStep] = useState(-1),
    [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(
      () =>
        setStep((index) => {
          if (index >= steps.length - 1) {
            setPlaying(false);
            return index;
          }
          return index + 1;
        }),
      FLOW_STEP_MS,
    );
    return () => window.clearInterval(timer);
  }, [playing, steps.length]);
  const current = step >= 0 ? steps[step] : selected;
  const node = (id: string) => flow.nodes.find((item) => item.id === id);
  const link = current?.kind === 'link' ? flow.links.find((item) => item.id === current.id) : null;
  const lit = new Set(current?.kind === 'node' ? [current.id] : link ? [link.from, link.to] : []);
  const choose = (next: FlowStep) => {
    setPlaying(false);
    setStep(-1);
    setSelected(next);
  };
  const go = (index: number) => {
    setPlaying(false);
    setStep(Math.max(0, Math.min(steps.length - 1, index)));
  };
  const linked = (id: string) => ({
    out: flow.links.filter((item) => item.from === id),
    in: flow.links.filter((item) => item.to === id),
  });
  return (
    <>
      <div className="flow-toolbar">
        <Button
          size="sm"
          variant="ghost"
          aria-label={t.previousStep}
          disabled={step <= 0}
          onClick={() => go(step - 1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            if (playing) return setPlaying(false);
            if (step < 0 || step >= steps.length - 1) setStep(0);
            setSelected(null);
            setPlaying(true);
          }}
        >
          {playing ? <Pause /> : <Play />}
          {playing ? t.pauseFlow : t.playFlow}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t.nextStep}
          disabled={step >= steps.length - 1}
          onClick={() => go(step + 1)}
        >
          <ChevronRight />
        </Button>
        <span>{step < 0 ? t.exploreFlow : `${step + 1} / ${steps.length}`}</span>
      </div>
      <div className="diagram-scroll" tabIndex={0} role="region" aria-label={t.diagram}>
        <div className="flow-canvas">
          <img
            src={image.url}
            alt={t.diagramDescription}
            width={image.width}
            height={image.height}
          />
          {flow.nodes.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`flow-node ${lit.has(item.id) ? 'lit' : ''}`}
              style={{
                left: `${item.left}%`,
                top: `${item.top}%`,
                width: `${item.width}%`,
                height: `${item.height}%`,
              }}
              aria-label={item.label}
              aria-pressed={lit.has(item.id)}
              onClick={() => choose({ kind: 'node', id: item.id })}
            />
          ))}
        </div>
      </div>
      {current && (
        <div className="flow-detail" role="status">
          {current.kind === 'node' ? (
            <>
              <p>
                <strong>{t.flowNode}</strong> · {node(current.id)?.label}
              </p>
              {(['out', 'in'] as const).map((direction) => {
                const items = linked(current.id)[direction];
                return items.length ? (
                  <p key={direction}>
                    {direction === 'out' ? t.flowLeadsTo : t.flowComesFrom}{' '}
                    {items.map((item) => {
                      const target = direction === 'out' ? item.to : item.from;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => choose({ kind: 'node', id: target })}
                        >
                          {node(target)?.label}
                          {item.label ? ` (${item.label})` : ''}
                        </button>
                      );
                    })}
                  </p>
                ) : null;
              })}
            </>
          ) : link ? (
            <p>
              <strong>{t.flowLink}</strong> · {node(link.from)?.label} → {node(link.to)?.label}
              {link.label ? `: ${link.label}` : ''}
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}

export function Diagram({ source, t }: { source: string; t: T }) {
  const [image, setImage] = useState<DiagramImage | null>(null),
    [failed, setFailed] = useState(false),
    [expanded, setExpanded] = useState(false),
    [zoom, setZoom] = useState(100);
  useEffect(() => {
    let disposed = false;
    setImage(null);
    setFailed(false);
    void renderDiagram(source).then(
      (value) => {
        if (!disposed) setImage(value);
      },
      () => {
        if (!disposed) setFailed(true);
      },
    );
    return () => {
      disposed = true;
    };
  }, [source]);
  return (
    <figure className="study-diagram">
      <div className="diagram-head">
        <span>{t.diagram}</span>
        {image && (
          <button
            type="button"
            aria-label={t.expandDiagram}
            onClick={() => {
              setZoom(100);
              setExpanded(true);
            }}
          >
            <Maximize2 size={14} />
            {t.expand}
          </button>
        )}
      </div>
      {image?.flow ? (
        <FlowExplorer image={image} flow={image.flow} t={t} />
      ) : image ? (
        <div className="diagram-scroll" tabIndex={0} role="region" aria-label={t.diagram}>
          <img
            src={image.url}
            alt={t.diagramDescription}
            width={image.width}
            height={image.height}
          />
        </div>
      ) : (
        <p role="status">{failed ? t.diagramUnavailable : t.diagramLoading}</p>
      )}
      <details open={failed}>
        <summary>{t.diagramSource}</summary>
        <pre tabIndex={0} aria-label={t.diagramSource}>
          <code>{source}</code>
        </pre>
      </details>
      {expanded && image && (
        <Modal
          title={t.diagram}
          close={() => setExpanded(false)}
          closeLabel={t.close}
          className="diagram-modal"
        >
          <div className="diagram-zoom">
            <p>{t.diagramZoomHint}</p>
            <select
              aria-label={t.zoom}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
            >
              {[50, 75, 100, 150, 200].map((n) => (
                <option key={n} value={n}>
                  {n}%
                </option>
              ))}
            </select>
          </div>
          <div
            className="diagram-scroll diagram-expanded"
            tabIndex={0}
            role="region"
            aria-label={t.diagram}
          >
            <img
              src={image.url}
              alt={t.diagramDescription}
              style={{ width: (image.width * zoom) / 100, maxWidth: 'none' }}
            />
          </div>
          <details>
            <summary>{t.diagramSource}</summary>
            <pre tabIndex={0}>
              <code>{source}</code>
            </pre>
          </details>
        </Modal>
      )}
    </figure>
  );
}
