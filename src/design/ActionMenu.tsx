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
export type MenuAnchor = { element: HTMLElement; point?: { x: number; y: number } };

export function ActionMenuSurface({
  id,
  label,
  actions,
  anchor,
  close,
  focusLast = false,
}: {
  id: string;
  label: string;
  actions: MenuAction[];
  anchor: MenuAnchor;
  close: (restoreFocus?: boolean) => void;
  focusLast?: boolean;
}) {
  const [point, setPoint] = useState({ left: 8, top: 8 });
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!menu.current) return;
    const rect = menu.current.getBoundingClientRect(),
      target = anchor.element.getBoundingClientRect();
    const left = anchor.point?.x ?? target.right - rect.width;
    const top =
      anchor.point?.y ??
      (target.bottom + rect.height + 8 <= window.innerHeight
        ? target.bottom + 4
        : target.top - rect.height - 4);
    setPoint({
      left: Math.max(8, Math.min(left, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - rect.height - 8)),
    });
    const items = menu.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
    items[focusLast ? items.length - 1 : 0]?.focus({ preventScroll: true });
  }, [anchor.element, anchor.point?.x, anchor.point?.y, focusLast]);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !anchor.element.contains(event.target as Node)
      )
        close(false);
    };
    const scroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) close(false);
    };
    const resize = () => close();
    document.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', resize);
    };
  }, [anchor.element, close]);
  const host =
    anchor.element.closest('dialog[open]') || anchor.element.closest('aside') || document.body;
  return createPortal(
    <div
      id={id}
      ref={menu}
      className="action-menu"
      role="menu"
      aria-label={label}
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
          ...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []),
        ];
        if (!items.length) return;
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
          if (itemRect.top < menuRect.top) menu.current.scrollTop -= menuRect.top - itemRect.top;
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
  );
}

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
    [focusLast, setFocusLast] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null),
    id = useId();
  const close = (restore = true) => {
    setOpen(false);
    if (restore && trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
  };
  if (!actions.length) return null;
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
        aria-controls={open ? `${id}-menu` : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setFocusLast(false);
          setOpen((value) => !value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setFocusLast(event.key === 'ArrowUp');
            setOpen(true);
          }
        }}
      >
        {icon}
      </button>
      {open && trigger.current && (
        <ActionMenuSurface
          id={`${id}-menu`}
          label={label}
          actions={actions}
          anchor={{ element: trigger.current }}
          close={close}
          focusLast={focusLast}
        />
      )}
    </>
  );
}
