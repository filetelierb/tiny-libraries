import { useEffect, useState } from 'react';
import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import type { T } from '../i18n';
import { Button, IconButton, Modal } from '../design/components';
import { renderDiagram, type DiagramImage } from './diagrams';

export function Diagram({ source, t }: { source: string; t: T }) {
  const [image, setImage] = useState<DiagramImage | null>(null),
    [failed, setFailed] = useState(false),
    [expanded, setExpanded] = useState(false),
    [zoom, setZoom] = useState(1);
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
      {image ? (
        <>
          <div className="diagram-scroll" tabIndex={0} role="region" aria-label={t.diagram}>
            <img
              src={image.url}
              alt={t.diagramDescription}
              width={image.width}
              height={image.height}
            />
          </div>
          <Button
            onClick={() => {
              setZoom(1);
              setExpanded(true);
            }}
          >
            <Maximize2 size={14} />
            {t.expandDiagram}
          </Button>
        </>
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
            <IconButton
              label={t.zoomOut}
              disabled={zoom <= 0.5}
              onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
            >
              <ZoomOut />
            </IconButton>
            <output aria-live="polite">{Math.round(zoom * 100)}%</output>
            <IconButton
              label={t.zoomIn}
              disabled={zoom >= 3}
              onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
            >
              <ZoomIn />
            </IconButton>
            <Button onClick={() => setZoom(1)}>{t.resetZoom}</Button>
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
              style={{ width: image.width * zoom, maxWidth: 'none' }}
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
