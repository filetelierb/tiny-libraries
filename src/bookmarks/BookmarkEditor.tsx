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
}: {
  intent: BookmarkIntent;
  sessionId: string;
  t: T;
  close: () => void;
  saved: () => void;
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
  return (
    <Modal
      title={intent.initial ? t.editBookmark : t.newBookmark}
      close={cancel}
      closeLabel={t.close}
    >
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
          <input
            autoFocus
            maxLength={240}
            disabled={pending}
            value={label}
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
          <Button disabled={pending} onClick={cancel}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
