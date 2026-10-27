import { useEffect, useRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { createPortal } from 'react-dom';

export function Button({
  variant = 'default',
  size = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'default' | 'sm';
}) {
  return (
    <button
      type="button"
      className={`button button-${variant} ${size === 'sm' ? 'button-sm' : ''} ${className}`}
      {...props}
    />
  );
}
/** Labelled command for the viewer bar; the label hides when the bar is narrow. */
export function ToolbarButton({
  label,
  text = label,
  icon,
  ...props
}: Parameters<typeof Button>[0] & { label: string; text?: string; icon: ReactNode }) {
  return (
    <Button variant="ghost" size="sm" title={label} aria-label={label} {...props}>
      {icon}
      <span className="toolbar-label">{text}</span>
    </Button>
  );
}
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <Button variant="ghost" className="icon-button" title={label} aria-label={label} {...props}>
      {children}
    </Button>
  );
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'outline' | 'primary';
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Empty({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function Modal({
  title,
  close,
  children,
  closeLabel = 'Close',
  className = '',
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  closeLabel?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous?.isConnected && previous.getClientRects().length)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className={`modal ${className}`}
      aria-labelledby={titleId}
    >
      <div className="modal-title">
        <h2 id={titleId}>{title}</h2>
        <IconButton label={closeLabel} onClick={close}>
          <X />
        </IconButton>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}
