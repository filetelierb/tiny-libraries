import { useEffect, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import type { T } from '../i18n';
import { Modal } from '../design/components';
import { renderDiagram, type DiagramImage } from './diagrams';

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
      {image ? (
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
