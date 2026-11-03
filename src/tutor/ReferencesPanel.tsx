import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Pause, Play } from 'lucide-react';
import type { Catalog } from '../../shared/domain';
import type { T } from '../i18n';
import { IconButton } from '../design/components';

/**
 * A compact popover for the conversation's permanent references. One row per attached file
 * with a pause/resume toggle and a remove button; the footer opens the full picker for
 * adding more. Replaces the earlier modal-first flow so the common "quiet this reference"
 * gesture no longer pulls the student out of the composer.
 */
export function ReferencesPanel({
  t,
  catalog,
  sourceIds,
  paused,
  pending,
  anchor,
  onPause,
  onDismiss,
}: {
  t: T;
  catalog: Catalog;
  sourceIds: string[];
  paused: Set<string>;
  pending: boolean;
  anchor: HTMLElement | null;
  onPause: (id: string, pauseIt: boolean) => void;
  onDismiss: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; bottom: number } | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      setBox({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor]);
  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (!root.current) return;
      if (root.current.contains(event.target as Node)) return;
      // Clicking the trigger button toggles the panel through its own handler.
      if ((event.target as HTMLElement).closest('.reference-chip')) return;
      onDismiss();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onDismiss]);
  const active = sourceIds.filter((id) => !paused.has(id)).length;
  if (!box) return null;
  return createPortal(
    <div
      ref={root}
      className="references-panel"
      role="dialog"
      aria-label={t.references}
      style={{ position: 'fixed', left: box.left, bottom: box.bottom }}
    >
      <header className="references-panel-head">
        <div>
          <p className="references-panel-title">{t.references}</p>
          <p className="references-panel-sub">{t.referencesNotice}</p>
        </div>
        <span className="references-panel-badge">
          {active}/{sourceIds.length}
        </span>
      </header>
      {sourceIds.length === 0 ? (
        <p className="references-panel-empty">{t.generalTutorNotice}</p>
      ) : (
        <ul className="references-panel-list">
          {sourceIds.map((id) => {
            const file = catalog.files.find((item) => item.id === id);
            const off = paused.has(id);
            const label = file?.name || t.missingReference;
            return (
              <li key={id} className={off ? 'is-paused' : undefined}>
                <FileText className="references-panel-icon" aria-hidden="true" />
                <span className="references-panel-name" title={label}>
                  {label}
                </span>
                <IconButton
                  label={`${off ? t.resumeReference : t.pauseReference}: ${label}`}
                  aria-pressed={off}
                  disabled={pending}
                  onClick={() => onPause(id, !off)}
                >
                  {off ? <Play /> : <Pause />}
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </div>,
    document.body,
  );
}
