import { useRef, useState } from 'react';
import type { Components } from 'react-markdown';
import {
  Clock3,
  CornerDownRight,
  LoaderCircle,
  PenLine,
  Play,
  RotateCcw,
  Square,
  Trash2,
} from 'lucide-react';
import type { TurnView, TurnAction } from '../../shared/tutor-turns';
import type { Catalog } from '../../shared/domain';
import {
  tutorPreferenceSchema,
  resolveTutorGeneration,
  type TutorPreference,
} from '../../shared/tutor-generation';
import { Button, IconButton, Modal } from '../design/components';
import { GenerationControl, GenerationLabel } from './GenerationControl';
import { StudyMarkdown } from '../study/StudyMarkdown';
import type { T } from '../i18n';

// Unfinished code fences stay plain text instead of mounting diagrams mid-stream.
const streamingComponents: Components = {
  pre: ({ node: _node, ...pre }) => <pre {...pre} />,
};

export function tutorToolLabel(name: string, t: T) {
  return (
    (
      {
        read_segments: t.toolReadSegments,
        practice_summary: t.toolPracticeSummary,
        list_concepts: t.toolListConcepts,
        read_concepts: t.toolReadConcepts,
        create_bookmark: t.toolCreateBookmark,
        save_artifact: t.toolSaveArtifact,
        create_artifact: t.toolCreateArtifact,
        browse_library: t.toolBrowseLibrary,
        list_notes: t.toolListNotes,
        manage_files: t.toolManageFiles,
        manage_notes: t.toolManageNotes,
        merge_concepts: t.toolMergeConcepts,
        start_test: t.toolStartTest,
        search_glossary: t.toolSearchGlossary,
        save_concept: t.toolSaveConcept,
        web_search: t.toolWebSearch,
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
  const status = turn.stopRequested
    ? t.stoppingReply
    : turn.phase === 'tools'
      ? t.runningStudyTools
      : t.generatingReply;
  return (
    <section
      className="chat-entry assistant tutor-run"
      aria-label={t.currentReply}
      data-turn-id={turn.id}
    >
      {turn.partial && (
        <div className="chat-message assistant" aria-live="off">
          <StudyMarkdown t={t} components={streamingComponents}>
            {turn.partial}
          </StudyMarkdown>
        </div>
      )}
      <div className="tutor-run-status" title={t.savedProgressNotice}>
        <span role="status">
          <LoaderCircle className="spin" />
          {status}
        </span>
        <IconButton
          label={t.stopReply}
          disabled={busy || turn.stopRequested}
          onClick={() => void act(turn, 'stop')}
        >
          <Square />
        </IconButton>
      </div>
      <small>
        <GenerationLabel value={turn.generation} t={t} />
        {turn.webSearch && <> · {t.webEnabledQuestion}</>}
        {!!turn.toolNames.length && (
          <>
            {' '}
            · {t.toolsUsed}: {turn.toolNames.map((name) => tutorToolLabel(name, t)).join(', ')}
          </>
        )}
      </small>
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
  // Cancelled questions stay hidden unless they can still be retried.
  const shown = items.filter((item) => item.status !== 'cancelled' || item.canRetry);
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
  if (!shown.length && !editing) return null;
  return (
    <section className="tutor-outbox" aria-label={t.questionOutbox}>
      {!!shown.length && (
        <p className="tutor-outbox-heading">
          <Clock3 aria-hidden="true" />
          {t.questionOutbox} · {shown.length}
        </p>
      )}
      {shown.map((turn) => (
        <article className="tutor-outbox-card" data-turn-id={turn.id} key={turn.id}>
          <div className="tutor-outbox-row">
            <CornerDownRight aria-hidden="true" />
            <button
              type="button"
              className="tutor-outbox-prompt"
              title={`${t[`turn_${turn.status}`]} · ${turn.prompt}`}
              disabled={busy || !turn.canEdit}
              onClick={(event) => void edit(turn, event.currentTarget)}
            >
              {turn.prompt}
            </button>
            {turn.canSteer && (
              <button
                type="button"
                className="tutor-outbox-steer"
                title={t.steeringNotice}
                disabled={busy}
                onClick={() => void act(turn, 'steer')}
              >
                {t.steerShort}
              </button>
            )}
            {turn.canEdit && (
              <IconButton
                label={t.editQueuedQuestion}
                disabled={busy}
                onClick={(event) => void edit(turn, event.currentTarget)}
              >
                <PenLine />
              </IconButton>
            )}
            {turn.status === 'editing' && (
              <IconButton
                label={t.resumeQueuedQuestion}
                disabled={busy}
                onClick={() => void act(turn, 'resume')}
              >
                <Play />
              </IconButton>
            )}
            {turn.canRetry && (
              <IconButton
                label={t.retrySavedQuestion}
                disabled={busy}
                onClick={() => void act(turn, 'retry')}
              >
                <RotateCcw />
              </IconButton>
            )}
            {turn.status === 'steering' ? (
              <LoaderCircle className="spin" aria-label={t.steeringNotice} />
            ) : (
              turn.canEdit && (
                <IconButton
                  label={t.cancelQueuedQuestion}
                  disabled={busy}
                  onClick={() => void act(turn, 'cancel')}
                >
                  <Trash2 />
                </IconButton>
              )
            )}
          </div>
          {!!turn.attachments?.length && (
            <p className="tutor-outbox-attachments">
              {turn.attachments.map((item) => (
                <button type="button" key={item.id} onClick={() => inspectAttachment(item.id)}>
                  {item.name}
                </button>
              ))}
            </p>
          )}
          {turn.error && (
            <p role="alert" className="tutor-turn-error">
              {turn.error}
            </p>
          )}
          {turn.status === 'editing' && <p className="muted">{t.queueEditingNotice}</p>}
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
