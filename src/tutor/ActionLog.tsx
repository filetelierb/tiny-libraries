import { useEffect, useState } from 'react';
import { Check, ClipboardList, ShieldAlert } from 'lucide-react';
import type { ReplyAction, TutorActionState } from '../../shared/tutor-actions';
import { api } from '../api';
import { Button } from '../design/components';
import type { T } from '../i18n';

/** The sentence for an action, from its kind, the record it acts on and its new value. */
export function actionLabel(action: Pick<ReplyAction, 'op' | 'subject' | 'detail'>, t: T) {
  const templates: Record<string, string> = {
    'folder.create': t.actionFolderCreate,
    'item.rename': t.actionRename,
    'item.move': t.actionMove,
    'item.archive': t.actionArchive,
    'item.unarchive': t.actionUnarchive,
    'item.trash': t.actionTrash,
    'item.restore': t.actionRestore,
    'item.delete': t.actionDelete,
    'note.create': t.actionNoteCreate,
    'note.update': action.detail ? t.actionNoteRename : t.actionNoteUpdate,
    'note.delete': t.actionNoteDelete,
    'concept.merge': t.actionMerge,
    'test.start': t.actionTest,
  };
  return (templates[action.op] || action.op)
    .replace('{subject}', action.subject)
    .replace('{detail}', action.detail || '');
}

/** A deletion or merge the tutor proposed; nothing changes until the student confirms. */
function Proposal({ action, t, changed }: { action: ReplyAction; t: T; changed: () => void }) {
  const [state, setState] = useState<TutorActionState | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api<TutorActionState>(`/tutor-actions/${action.id}`)
      .then((value) => live && setState(value))
      .catch((cause) => live && setError(cause instanceof Error ? cause.message : t.error));
    return () => {
      live = false;
    };
  }, [action.id]);
  const decide = async (decision: 'confirm' | 'cancel') => {
    setBusy(true);
    setError('');
    try {
      const next = await api<TutorActionState>(`/tutor-actions/${action.id}`, 'POST', {
        decision,
      });
      setState(next);
      if (next.state === 'done') changed();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.error);
    } finally {
      setBusy(false);
    }
  };
  const current = state?.state;
  return (
    <section
      className={`tutor-action-card ${current === 'proposed' || current === 'failed' ? 'pending' : ''}`}
      aria-label={t.actionConfirmTitle}
    >
      <ShieldAlert size={16} aria-hidden="true" />
      <div>
        <strong>{actionLabel(action, t)}</strong>
        <small role="status">
          {current === 'done'
            ? t.actionDone
            : current === 'cancelled'
              ? t.actionCancelled
              : current === 'running'
                ? t.actionRunning
                : current === 'failed'
                  ? state?.error || t.error
                  : t.actionConfirmHint}
        </small>
        {error && <small className="error">{error}</small>}
      </div>
      {(current === 'proposed' || current === 'failed') && (
        <span className="tutor-action-buttons">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void decide('cancel')}>
            {t.cancel}
          </Button>
          <Button size="sm" variant="danger" disabled={busy} onClick={() => void decide('confirm')}>
            {t.actionConfirm}
          </Button>
        </span>
      )}
    </section>
  );
}

/** What the tutor did in the library during a reply, and what waits for confirmation. */
export function ActionLog({
  actions,
  t,
  changed,
  openTest,
}: {
  actions: ReplyAction[];
  t: T;
  changed: () => void;
  openTest: (sessionId: string, testId: string) => void;
}) {
  const done = actions.filter((action) => action.status === 'done');
  return (
    <div className="tutor-actions">
      {!!done.length && (
        <ul className="tutor-action-log" aria-label={t.actionLog}>
          {done.map((action) => (
            <li key={action.id}>
              {action.op === 'test.start' ? (
                <ClipboardList size={14} aria-hidden="true" />
              ) : (
                <Check size={14} aria-hidden="true" />
              )}
              <span>{actionLabel(action, t)}</span>
              {action.testId && action.sessionId && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => openTest(action.sessionId!, action.testId!)}
                >
                  {t.openTest}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {actions
        .filter((action) => action.status === 'proposed')
        .map((action) => (
          <Proposal key={action.id} action={action} t={t} changed={changed} />
        ))}
    </div>
  );
}
