import { useEffect, useRef, useId, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Button({
  variant = 'default',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
}) {
  return <button type="button" className={`button button-${variant} ${className}`} {...props} />;
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
  tone?: 'neutral' | 'success' | 'warning';
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
  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
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
    </dialog>
  );
}
