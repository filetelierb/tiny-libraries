import { useEffect, useRef, useState, type RefObject } from 'react';
import {
  clamp,
  PANEL_DEFAULT,
  PANEL_MIN,
  PANEL_STORAGE_KEY,
  readPanelPreferences,
  resolvePanels,
  type Side,
} from './layout';

export function usePanels() {
  const [viewport, setViewport] = useState(window.innerWidth);
  const [preferences, setPreferences] = useState(() => {
    try {
      return readPanelPreferences(localStorage.getItem(PANEL_STORAGE_KEY), window.innerWidth);
    } catch {
      return readPanelPreferences(null, window.innerWidth);
    }
  });
  // A smaller viewport temporarily changes placement, not the saved desktop visibility.
  const [mobileOpen, setMobileOpen] = useState<Side | null>(null);
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      /* Reading still works without browser storage. */
    }
  }, [preferences]);
  const narrow = viewport < 960;
  const effective = narrow
    ? {
        left: { ...preferences.left, open: mobileOpen === 'left' },
        right: { ...preferences.right, open: mobileOpen === 'right' },
      }
    : preferences;
  const resolved = resolvePanels(effective, viewport);
  const open = (side: Side, value = true) => {
    if (narrow) {
      setMobileOpen(value ? side : null);
      return;
    }
    setPreferences((previous) => {
      const other = side === 'left' ? 'right' : 'left';
      return {
        ...previous,
        [side]: { ...previous[side], open: value },
        ...(value && !previous[side].pinned && !previous[other].pinned
          ? { [other]: { ...previous[other], open: false } }
          : {}),
      };
    });
  };
  const pin = (side: Side) =>
    setPreferences((previous) => {
      const other = side === 'left' ? 'right' : 'left';
      const pinned = !previous[side].pinned;
      return {
        ...previous,
        [side]: { ...previous[side], pinned, open: true },
        ...(!pinned && !previous[other].pinned
          ? { [other]: { ...previous[other], open: false } }
          : {}),
      };
    });
  const resize = (side: Side, width: number) =>
    setPreferences((previous) => {
      const other = side === 'left' ? 'right' : 'left';
      return {
        ...previous,
        // Hold the other panel at its displayed width during an explicit resize.
        [other]: {
          ...previous[other],
          ...(resolved[other].docked ? { width: resolved[other].width } : {}),
        },
        [side]: {
          ...previous[side],
          width: clamp(width, PANEL_MIN[side], Math.max(PANEL_MIN[side], resolved[side].max)),
        },
      };
    });
  const drawer =
    (['left', 'right'] as const).find((side) => effective[side].open && !resolved[side].docked) ||
    null;
  return { preferences, effective, resolved, narrow, drawer, open, pin, resize };
}

export function useDrawerFocus(
  side: Side,
  floating: boolean,
  ref: RefObject<HTMLElement | null>,
  close: () => void,
) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!floating) return;
    const panel = ref.current;
    if (!panel) return;
    const selectors =
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]';
    const elements = () =>
      [...panel.querySelectorAll<HTMLElement>(selectors)].filter(
        (element) => element.getClientRects().length > 0,
      );
    const previous = document.activeElement as HTMLElement | null;
    elements()[0]?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== 'Tab' || document.querySelector('dialog[open]')) return;
      const items = elements();
      const first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => {
      document.removeEventListener('keydown', keyboard);
      const toggle = document.querySelector<HTMLElement>(`[data-panel-toggle="${side}"]`);
      if (previous?.isConnected && previous.getClientRects().length && !panel.contains(previous))
        previous.focus();
      else toggle?.focus();
    };
  }, [floating, side, ref]);
}

export function PanelResizer({
  side,
  width,
  max,
  label,
  help,
  change,
}: {
  side: Side;
  width: number;
  max: number;
  label: string;
  help: string;
  change: (value: number) => void;
}) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  return (
    <div
      className={`panel-resizer ${resizing ? 'resizing' : ''}`}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={PANEL_MIN[side]}
      aria-valuemax={Math.floor(max)}
      aria-valuenow={width}
      aria-valuetext={`${width}px`}
      title={`${label}. ${help}`}
      aria-controls={`${side}-panel`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width };
        setResizing(true);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        change(drag.current.width + (event.clientX - drag.current.x) * (side === 'left' ? 1 : -1));
      }}
      onPointerUp={(event) => {
        drag.current = null;
        setResizing(false);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onLostPointerCapture={() => {
        drag.current = null;
        setResizing(false);
      }}
      onPointerCancel={() => {
        if (drag.current) change(drag.current.width);
        drag.current = null;
        setResizing(false);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 40 : 10;
        const direction = side === 'left' ? 1 : -1;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          change(width + (event.key === 'ArrowRight' ? step : -step) * direction);
        } else if (event.key === 'Home' || event.key === 'End' || event.key === 'Enter') {
          event.preventDefault();
          change(
            event.key === 'Home'
              ? PANEL_MIN[side]
              : event.key === 'End'
                ? max
                : PANEL_DEFAULT[side],
          );
        } else if (event.key === 'Escape' && drag.current) {
          change(drag.current.width);
          drag.current = null;
          setResizing(false);
        }
      }}
    >
      <span />
    </div>
  );
}
