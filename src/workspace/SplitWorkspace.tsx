import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Source } from '../../shared/domain';
import type { T } from '../i18n';

export function splitLimits(width: number) {
  const available = Math.max(1, width - 8);
  const min = Math.max(0.2, Math.min(220, available * 0.25) / available);
  return { min, max: 1 - min };
}
export function SplitWorkspace({
  sources,
  focused,
  ratio,
  focus,
  resize,
  children,
  t,
}: {
  sources: Source[];
  focused: string;
  ratio: number;
  focus: (id: string) => void;
  resize: (ratio: number) => void;
  children: (source: Source) => ReactNode;
  t: T;
}) {
  const ref = useRef<HTMLDivElement>(null),
    handle = useRef<HTMLDivElement>(null),
    id = useId();
  const [width, setWidth] = useState(1000),
    [narrow, setNarrow] = useState(window.innerWidth < 1024),
    [draft, setDraft] = useState<number | null>(null);
  const dragging = useRef<{ pointer: number; value: number } | null>(null);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    const media = window.matchMedia('(max-width: 1023px)');
    const changed = () => setNarrow(media.matches);
    media.addEventListener('change', changed);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', changed);
    };
  }, []);
  useEffect(() => {
    if (!narrow) return;
    for (const pane of ref.current?.querySelectorAll<HTMLElement>('[data-source-id]') || []) {
      if (pane.dataset.sourceId !== focused)
        for (const player of pane.querySelectorAll<HTMLMediaElement>('audio,video')) player.pause();
    }
  }, [narrow, focused]);
  const limits = splitLimits(width),
    shown = Math.max(limits.min, Math.min(limits.max, draft ?? ratio));
  const finish = (commit: boolean) => {
    const current = dragging.current;
    dragging.current = null;
    setDraft(null);
    if (commit && current) resize(current.value);
  };
  return (
    <div
      className={`split-workspace ${sources.length === 2 ? 'paired' : ''} ${narrow ? 'narrow' : ''} ${draft !== null ? 'resizing' : ''}`}
      ref={ref}
    >
      {sources.length === 2 && narrow && (
        <div className="split-source-tabs" role="tablist" aria-label={t.splitResources}>
          {sources.map((source, index) => (
            <button
              type="button"
              key={source.id}
              id={`${id}-tab-${source.id}`}
              role="tab"
              aria-selected={focused === source.id}
              aria-controls={`${id}-pane-${source.id}`}
              tabIndex={focused === source.id ? 0 : -1}
              onClick={() => focus(source.id)}
              onKeyDown={(event) => {
                if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                  event.preventDefault();
                  const next =
                    event.key === 'Home'
                      ? sources[0]
                      : event.key === 'End'
                        ? sources[1]
                        : sources[1 - index];
                  focus(next.id);
                  document.getElementById(`${id}-tab-${next.id}`)?.focus();
                }
              }}
              title={source.name}
            >
              {source.name}
            </button>
          ))}
        </div>
      )}
      {sources.map((source, index) => (
        <div className="split-slot" style={{ display: 'contents' }} key={source.id}>
          {index === 1 && !narrow && (
            <div
              ref={handle}
              role="separator"
              tabIndex={0}
              className="split-resizer"
              aria-orientation="vertical"
              aria-label={t.splitWidth}
              aria-valuemin={Math.ceil(limits.min * 100)}
              aria-valuemax={Math.floor(limits.max * 100)}
              aria-valuenow={Math.round(shown * 100)}
              aria-valuetext={`${Math.round(shown * 100)}% / ${Math.round((1 - shown) * 100)}%`}
              title={t.splitResizeHelp}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.focus();
                event.currentTarget.setPointerCapture(event.pointerId);
                dragging.current = { pointer: event.pointerId, value: shown };
                setDraft(shown);
              }}
              onPointerMove={(event) => {
                if (
                  !dragging.current ||
                  dragging.current.pointer !== event.pointerId ||
                  !ref.current
                )
                  return;
                const rect = ref.current.getBoundingClientRect();
                const next = Math.max(
                  limits.min,
                  Math.min(
                    limits.max,
                    (event.clientX - rect.left - 4) / Math.max(1, rect.width - 8),
                  ),
                );
                dragging.current.value = next;
                setDraft(next);
              }}
              onPointerUp={(event) => {
                finish(true);
                if (event.currentTarget.hasPointerCapture(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={() => finish(false)}
              onLostPointerCapture={() => finish(true)}
              onDoubleClick={() => resize(0.5)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && dragging.current) {
                  event.preventDefault();
                  finish(false);
                  return;
                }
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key))
                  return;
                event.preventDefault();
                event.stopPropagation();
                const next =
                  event.key === 'Home'
                    ? limits.min
                    : event.key === 'End'
                      ? limits.max
                      : event.key === 'Enter'
                        ? 0.5
                        : shown +
                          (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 0.1 : 0.05);
                resize(Math.max(limits.min, Math.min(limits.max, next)));
              }}
            >
              <span />
            </div>
          )}
          <section
            id={`${id}-pane-${source.id}`}
            className={`resource-pane ${focused === source.id ? 'focused' : ''}`}
            role={narrow && sources.length === 2 ? 'tabpanel' : 'region'}
            aria-label={source.name}
            aria-labelledby={narrow && sources.length === 2 ? `${id}-tab-${source.id}` : undefined}
            data-source-id={source.id}
            hidden={narrow && focused !== source.id}
            style={{
              flexGrow: narrow || sources.length === 1 ? 1 : index === 0 ? shown : 1 - shown,
            }}
            onPointerDownCapture={() => {
              if (focused !== source.id) focus(source.id);
            }}
            onFocusCapture={() => {
              if (focused !== source.id) focus(source.id);
            }}
          >
            {children(source)}
          </section>
        </div>
      ))}
    </div>
  );
}
