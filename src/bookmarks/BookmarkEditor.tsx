import { useState } from 'react';
import { plainDocument, type Annotation, type SourceLocation } from '../../shared/annotations';
import type { Source } from '../../shared/domain';
import { api } from '../api';
import { Button, Modal } from '../design/components';
import type { T } from '../i18n';

export type BookmarkIntent = { source: Source; location: SourceLocation; initial?: Annotation };
export function BookmarkEditor({
  intent,
  sessionId,
  t,
  close,
  saved,
  inline = false,
}: {
  intent: BookmarkIntent;
  sessionId: string;
  t: T;
  close: () => void;
  saved: () => void;
  /** Renders as a tinted card in the bookmarks panel instead of a dialog. */
  inline?: boolean;
}) {
  const [id] = useState(() => intent.initial?.id || crypto.randomUUID());
  const key = `tl:bookmark-draft:${id}`;
  const [label, setLabel] = useState(() => {
    try {
      return localStorage.getItem(key) || intent.initial?.title || '';
    } catch {
      return intent.initial?.title || '';
    }
  });
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const cancel = () => {
    if (!pending) {
      localStorage.removeItem(key);
      close();
    }
  };
  const title = intent.initial ? t.editBookmark : t.newBookmark;
  const content = (
    <>
      <p className="muted">
        {intent.source.name}
        {intent.location.page
          ? ` · ${t.page} ${intent.location.page}`
          : intent.location.seconds != null
            ? ` · ${Math.floor(intent.location.seconds / 60)}:${String(Math.floor(intent.location.seconds % 60)).padStart(2, '0')}`
            : ''}
      </p>
      {intent.location.quote && <blockquote>{intent.location.quote}</blockquote>}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!label.trim() || pending) return;
          setPending(true);
          setError('');
          void api(`/annotations/${id}`, 'PUT', {
            id,
            kind: 'bookmark',
            sessionId: intent.initial?.sessionId || sessionId,
            sourceId: intent.source.id,
            sourceVersion: intent.initial?.sourceVersion || intent.source.version,
            title: label.trim(),
            document: plainDocument(label.trim()),
            location: intent.location,
            strokes: [],
            origin: intent.initial?.origin || 'manual',
            references: intent.initial?.references || [intent.source.id],
            expectedRevision: intent.initial?.revision || 0,
          })
            .then(() => {
              localStorage.removeItem(key);
              saved();
            })
            .catch((error) => setError(error.message))
            .finally(() => setPending(false));
        }}
      >
        <label>
          {t.bookmarkLabel}
          <textarea
            autoFocus
            maxLength={240}
            disabled={pending}
            value={label}
            placeholder={t.bookmarkPlaceholder}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            onChange={(event) => {
              setLabel(event.target.value);
              try {
                localStorage.setItem(key, event.target.value);
              } catch {}
            }}
          />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button variant="primary" type="submit" disabled={pending || !label.trim()}>
            {pending ? t.working : t.save}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={cancel}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </>
  );
  if (!inline)
    return (
      <Modal title={title} close={cancel} closeLabel={t.close}>
        {content}
      </Modal>
    );
  return (
    <section
      className="annotation-composer bookmark-composer"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
    >
      <h2>{title}</h2>
      {content}
    </section>
  );
}
