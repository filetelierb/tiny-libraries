import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Pencil, Play, RotateCcw, Square, X, CornerUpLeft } from 'lucide-react';
import type { TurnView, TurnAction } from '../../shared/tutor-turns';
import type { Catalog } from '../../shared/domain';
import {
  tutorPreferenceSchema,
  resolveTutorGeneration,
  type TutorPreference,
} from '../../shared/tutor-generation';
import { Button, Modal } from '../design/components';
import { GenerationControl, GenerationLabel } from './GenerationControl';
import type { T } from '../i18n';

export function tutorToolLabel(name: string, t: T) {
  return (
    (
      {
        read_segments: t.toolReadSegments,
        practice_summary: t.toolPracticeSummary,
        list_concepts: t.toolListConcepts,
        read_concepts: t.toolReadConcepts,
        create_bookmark: t.toolCreateBookmark,
      } as Record<string, string>
    )[name] || t.studyTool
  );
}
type Act = (
  turn: TurnView,
  action: TurnAction['action'],
  edit?: Pick<TurnAction, 'prompt' | 'generation'>,
) => Promise<TurnView | null>;
export function TurnProgress({
  turn,
  t,
  busy,
  act,
}: {
  turn: TurnView;
  t: T;
  busy: boolean;
  act: Act;
}) {
  return (
    <section className="tutor-run" aria-label={t.currentReply} data-turn-id={turn.id}>
      <div className="tutor-run-heading">
        <span role="status">
          <LoaderCircle size={14} className="spin" />{' '}
          {turn.stopRequested
            ? t.stoppingReply
            : turn.phase === 'tools'
              ? t.runningStudyTools
              : t.generatingReply}
        </span>
        <Button disabled={busy || turn.stopRequested} onClick={() => void act(turn, 'stop')}>
          <Square size={13} />
          {t.stopReply}
        </Button>
      </div>
      <small>
        <GenerationLabel value={turn.generation} t={t} />
      </small>
      {!!turn.toolNames.length && (
        <p className="tutor-run-tools">
          {t.toolsUsed}: {turn.toolNames.map((name) => tutorToolLabel(name, t)).join(', ')}
        </p>
      )}
      {turn.partial && (
        <div className="tutor-stream-text" aria-live="off">
          {turn.partial}
        </div>
      )}
      <small className="muted">{t.savedProgressNotice}</small>
    </section>
  );
}
export function TurnOutbox({
  items,
  catalog,
  t,
  busy,
  act,
  inspectAttachment,
  conversationId,
}: {
  items: TurnView[];
  catalog: Catalog;
  t: T;
  busy: boolean;
  act: Act;
  inspectAttachment: (id: string) => void;
  conversationId: string;
}) {
  const [editing, setEditing] = useState<TurnView | null>(null);
  const [expanded, setExpanded] = useState(() => items.some((item) => item.status !== 'cancelled'));
  const attention = items
    .filter((item) => item.status !== 'cancelled')
    .map((item) => `${item.id}:${item.status}`)
    .join(',');
  useEffect(() => {
    if (attention) setExpanded(true);
  }, [attention]);
  const editorTrigger = useRef<HTMLButtonElement | null>(null);
  const edit = async (turn: TurnView, trigger: HTMLButtonElement) => {
    editorTrigger.current = trigger;
    const value = turn.status === 'editing' ? turn : await act(turn, 'edit');
    if (value) setEditing(value);
  };
  const close = () => {
    setEditing(null);
    if (editorTrigger.current?.isConnected) editorTrigger.current.focus();
  };
  if (!items.length && !editing) return null;
  return (
    <section className="tutor-outbox" aria-label={t.questionOutbox}>
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>
          <h3>
            {t.questionOutbox} <span>{items.length}</span>
          </h3>
        </summary>
        {items.map((turn) => (
          <article className="tutor-outbox-card" data-turn-id={turn.id} key={turn.id}>
            <div className="tutor-outbox-heading">
              <strong>{t[`turn_${turn.status}`]}</strong>
              <small>
                <GenerationLabel value={turn.effectiveGeneration || turn.generation} t={t} />
              </small>
            </div>
            <p>{turn.prompt}</p>
            <details>
              <summary>{t.savedQuestionContext}</summary>
              {!!turn.references?.length && (
                <ul>
                  {turn.references.map((ref) => (
                    <li key={ref.id}>
                      {catalog.files.find((file) => file.id === ref.id)?.name || t.missingReference}{' '}
                      · {t.sourceVersion} {ref.version}
                    </li>
                  ))}
                </ul>
              )}
              {!turn.references?.length && <p>{t.noPersistentReferences}</p>}
              {turn.context && (
                <blockquote>
                  {turn.context.sourceName}
                  {turn.context.location.quote ? `: ${turn.context.location.quote}` : ''}
                </blockquote>
              )}
              {turn.attachments?.map((item) => (
                <Button variant="ghost" key={item.id} onClick={() => inspectAttachment(item.id)}>
                  {item.name}
                </Button>
              ))}
              <p className="muted">{t.frozenQuestionNotice}</p>
            </details>
            {turn.error && <p className="tutor-turn-error">{turn.error}</p>}
            {turn.status === 'editing' && <p className="muted">{t.queueEditingNotice}</p>}
            {turn.status === 'steering' && <p className="muted">{t.steeringNotice}</p>}
            <div className="tutor-turn-actions">
              {turn.canEdit && (
                <Button disabled={busy} onClick={(event) => void edit(turn, event.currentTarget)}>
                  <Pencil size={13} />
                  {t.editQueuedQuestion}
                </Button>
              )}
              {turn.status === 'editing' && (
                <Button disabled={busy} onClick={() => void act(turn, 'resume')}>
                  <Play size={13} />
                  {t.resumeQueuedQuestion}
                </Button>
              )}
              {turn.canEdit && (
                <Button disabled={busy} onClick={() => void act(turn, 'cancel')}>
                  <X size={13} />
                  {t.cancelQueuedQuestion}
                </Button>
              )}
              {turn.canRetry && (
                <Button disabled={busy} onClick={() => void act(turn, 'retry')}>
                  <RotateCcw size={13} />
                  {t.retrySavedQuestion}
                </Button>
              )}
              {turn.canSteer && (
                <Button
                  disabled={busy}
                  title={t.steeringNotice}
                  onClick={() => void act(turn, 'steer')}
                >
                  <CornerUpLeft size={13} />
                  {t.steerReply}
                </Button>
              )}
            </div>
          </article>
        ))}
        {editing && (
          <TurnEditor
            key={`${editing.id}:${editing.revision}`}
            turn={editing}
            conversationId={conversationId}
            t={t}
            catalog={catalog}
            busy={busy}
            close={close}
            save={async (prompt, generation) => {
              const saved = await act(editing, 'save', { prompt, generation });
              if (saved) close();
            }}
          />
        )}
      </details>
    </section>
  );
}
function TurnEditor({
  turn,
  conversationId,
  t,
  catalog,
  busy,
  close,
  save,
}: {
  turn: TurnView;
  conversationId: string;
  t: T;
  catalog: Catalog;
  busy: boolean;
  close: () => void;
  save: (prompt: string, generation: TurnView['generation']) => Promise<void>;
}) {
  const key = `tl:queued-question:${conversationId}:${turn.id}:r${turn.revision}`;
  const [draft, setDraft] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || 'null');
      const generation = tutorPreferenceSchema.safeParse(value?.generation);
      if (typeof value?.prompt === 'string' && value.prompt.length <= 8000 && generation.success)
        return { prompt: value.prompt, generation: generation.data };
    } catch {}
    return { prompt: turn.prompt, generation: turn.generation as TutorPreference };
  });
  const change = (value: typeof draft) => {
    setDraft(value);
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  };
  return (
    <Modal title={t.editQueuedQuestion} close={close} closeLabel={t.keepQuestionPaused}>
      <p>{t.queueEditingNotice}</p>
      <form
        className="tutor-turn-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void save(
            draft.prompt.trim(),
            resolveTutorGeneration(draft.generation, catalog.settings.model),
          );
        }}
      >
        <label>
          {t.quizQuestion}
          <textarea
            autoFocus
            maxLength={8000}
            value={draft.prompt}
            onChange={(event) => change({ ...draft, prompt: event.target.value })}
          />
        </label>
        <GenerationControl
          value={draft.generation}
          defaultModel={catalog.settings.model}
          change={(generation) => change({ ...draft, generation })}
          t={t}
        />
        <div className="modal-actions">
          <Button variant="primary" type="submit" disabled={busy || !draft.prompt.trim()}>
            {t.saveQueuedQuestion}
          </Button>
          <Button onClick={close}>{t.keepQuestionPaused}</Button>
        </div>
      </form>
    </Modal>
  );
}
