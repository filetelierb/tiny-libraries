import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

export type MenuAction = {
  label: string;
  icon?: ReactNode;
  run: () => void;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
};

export function ActionMenu({
  label,
  actions,
  icon = <MoreHorizontal size={17} />,
}: {
  label: string;
  actions: MenuAction[];
  icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false),
    [point, setPoint] = useState({ left: 8, top: 8 });
  const trigger = useRef<HTMLButtonElement>(null),
    menu = useRef<HTMLDivElement>(null),
    id = useId();
  const close = (restore = true) => {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!open || !menu.current || !trigger.current) return;
    const anchor = trigger.current.getBoundingClientRect(),
      rect = menu.current.getBoundingClientRect();
    const top =
      anchor.bottom + rect.height + 8 <= window.innerHeight
        ? anchor.bottom + 4
        : Math.max(8, anchor.top - rect.height - 4);
    setPoint({
      left: Math.max(8, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 8)),
      top,
    });
    menu.current
      .querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      ) {
        close(false);
      }
    };
    const scroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) {
        close(false);
      }
    };
    const resize = () => {
      close();
    };
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [open]);
  if (!actions.length) return null;
  const host =
    trigger.current?.closest('dialog[open]') || trigger.current?.closest('aside') || document.body;
  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        data-menu-trigger
        className="button icon-button button-ghost tree-menu-trigger"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {icon}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="action-menu"
            role="menu"
            aria-labelledby={id}
            style={point}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
              }
              if (event.key === 'Tab') {
                close();
                return;
              }
              const items = [
                ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ||
                  []),
              ];
              let index = items.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === 'ArrowDown') index = (index + 1) % items.length;
              else if (event.key === 'ArrowUp') index = (index + items.length - 1) % items.length;
              else if (event.key === 'Home') index = 0;
              else if (event.key === 'End') index = items.length - 1;
              else return;
              event.preventDefault();
              event.stopPropagation();
              const item = items[index];
              item?.focus({ preventScroll: true });
              if (item && menu.current) {
                const itemRect = item.getBoundingClientRect(),
                  menuRect = menu.current.getBoundingClientRect();
                if (itemRect.bottom > menuRect.bottom)
                  menu.current.scrollTop += itemRect.bottom - menuRect.bottom;
                if (itemRect.top < menuRect.top)
                  menu.current.scrollTop -= menuRect.top - itemRect.top;
              }
            }}
          >
            {actions.map((action) => (
              <div key={action.label} role="none">
                {action.separator && <hr />}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={action.disabled}
                  className={action.danger ? 'danger' : ''}
                  onClick={() => {
                    close();
                    action.run();
                  }}
                >
                  {action.icon}
                  <span>{action.label}</span>
                </button>
              </div>
            ))}
          </div>,
          host,
        )}
    </>
  );
}
