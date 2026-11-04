import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useEditor, useEditorState, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import {
  Bold,
  Italic,
  Heading2,
  List,
  ListOrdered,
  IndentIncrease,
  IndentDecrease,
  Link,
  Quote,
  Code,
  Clock,
  FileText,
  X,
} from 'lucide-react';
import { sourceLocationStamp } from '../../shared/capture-source';
import { stampIdentity } from '../../shared/captures';
import { stampLabel } from './captureLabels';
import {
  annotationInputSchema,
  annotationSnapshotSchema,
  richText,
  type Annotation,
  type DrawingStroke,
  type SourceLocation,
} from '../../shared/annotations';
import type { Source, Catalog } from '../../shared/domain';
import type { TreeActions } from '../workspace/DirectoryTree';
import { api } from '../api';
import { Button, IconButton, Modal } from '../design/components';
import { CaptureCollectionEditor, shortTime } from './CaptureCollection';
import type { CaptureWorkspace } from './CaptureWorkspace';
import { loadEditorSession, type EditorSession } from './editorSession';
import {
  DraftWriteQueue,
  editorDrafts,
  editableNote,
  mergeNoteChanges,
  type NoteDraft,
  type NoteEdit,
  type NoteEditField,
} from './draftStore';
import { ApiResponseError } from '../api';
import type { T } from '../i18n';
import { InlineMath, BlockMath } from './mathNodes';
import { RichContent } from './RichContent';
import { useTypingPauseController } from './typingPause';

export type CaptureImage = { url: string; width: number; height: number; blob?: Blob };
export type AnnotationRequest = {
  id: string;
  sourceId: string | null;
  location: SourceLocation;
  initial?: Annotation;
  markdown?: string;
  capture?: CaptureImage;
  references?: string[];
  origin?: 'manual' | 'tutor';
};
type EditorProps = {
  catalog: Catalog;
  treeActions: TreeActions;
  request: AnnotationRequest;
  sessionId: string;
  source: Source | null;
  t: T;
  close: () => void;
  saved: (value: Annotation) => void;
  /** Renders inside the annotations panel instead of a dialog. */
  inline?: boolean;
};
/** The editor frame: a dialog, or a tinted card inside the annotations panel. */
function StampsRow({
  source,
  baseLocation,
  workspace,
  pending,
  t,
  onError,
}: {
  source: Source;
  baseLocation: SourceLocation;
  workspace: CaptureWorkspace;
  pending: boolean;
  t: T;
  onError: (message: string) => void;
}) {
  const snapshot = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot);
  const supportsCurrent =
    source.kind === 'video' || source.kind === 'audio' || source.kind === 'pdf';
  const baseStamp =
    baseLocation.page != null || baseLocation.seconds != null
      ? sourceLocationStamp(source, baseLocation)
      : null;
  const baseKey = baseStamp && stampIdentity(baseStamp);
  const hasBase = !!baseStamp && snapshot.stamps.some((s) => stampIdentity(s) === baseKey);
  const chips = [
    ...(baseStamp && !hasBase ? [baseStamp] : []),
    ...snapshot.stamps,
  ];
  const label = (stamp: { location: { page?: number; seconds?: number } }) =>
    stamp.location.page != null
      ? `${t.page} ${stamp.location.page}`
      : stamp.location.seconds != null
        ? shortTime(stamp.location.seconds)
        : '';
  return (
    <div className="annotation-source-chips" aria-label={t.captureLocationField}>
      {chips.map((stamp, index) => {
        const isBase = index === 0 && !hasBase && baseStamp && stamp === baseStamp;
        return (
          <span key={stamp.id || `base-${index}`} className="annotation-source-chip">
            {label(stamp)}
            {!isBase && (
              <button
                type="button"
                aria-label={stampLabel(stamp, t)}
                disabled={pending}
                onClick={() =>
                  void workspace
                    .setStamps(snapshot.stamps.filter((item) => item.id !== stamp.id))
                    .catch((e) => onError(e instanceof Error ? e.message : t.error))
                }
              >
                <X />
              </button>
            )}
          </span>
        );
      })}
      {supportsCurrent && (
        <Button
          className="annotation-source-add"
          disabled={pending}
          onClick={() => {
            const pane = [...document.querySelectorAll<HTMLElement>('[data-source-id]')].find(
              (node) => node.dataset.sourceId === source.id,
            );
            const media = pane?.querySelector<HTMLMediaElement>('audio,video');
            const page = pane?.querySelector<HTMLElement>('[data-pdf-page]')?.dataset.pdfPage;
            const location =
              source.kind === 'pdf'
                ? { page: page ? Number(page) || 1 : 1 }
                : {
                    seconds:
                      media && Number.isFinite(media.currentTime) ? media.currentTime : 0,
                  };
            void workspace
              .addStamp(sourceLocationStamp(source, location))
              .catch((e) => onError(e instanceof Error ? e.message : t.error));
          }}
        >
          {source.kind === 'pdf' ? <FileText /> : <Clock />}
          {source.kind === 'pdf' ? t.captureCurrentPage : t.captureCurrentTime}
        </Button>
      )}
    </div>
  );
}
function EditorShell({
  inline,
  title,
  close,
  t,
  children,
}: {
  inline?: boolean;
  title: string;
  close: () => void;
  t: T;
  children: ReactNode;
}) {
  if (!inline)
    return (
      <Modal title={title} close={close} closeLabel={t.close}>
        {children}
      </Modal>
    );
  return (
    <section
      className="annotation-composer"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || (event.target as HTMLElement).closest('dialog')) return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <header className="annotation-composer-head">
        <h2>{title}</h2>
        <p className="annotation-composer-intro">{t.annotationComposerIntro}</p>
      </header>
      {children}
    </section>
  );
}
export default function AnnotationEditor(props: EditorProps) {
  const [session, setSession] = useState<EditorSession | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void loadEditorSession(props.request, props.sessionId, props.source)
      .then((value) => {
        if (alive) setSession(value);
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : props.t.captureRecoveryError);
      });
    return () => {
      alive = false;
      if (props.request.capture?.blob) URL.revokeObjectURL(props.request.capture.url);
    };
  }, []);
  return session ? (
    <EditorForm {...props} session={session} />
  ) : (
    <EditorShell
      inline={props.inline}
      title={props.request.initial ? props.t.editAnnotation : props.t.newAnnotation}
      close={props.close}
      t={props.t}
    >
      <p role={error ? 'alert' : 'status'}>{error || props.t.loadingAnnotations}</p>
    </EditorShell>
  );
}
function EditorForm({
  catalog,
  treeActions,
  request,
  source,
  t,
  close,
  saved,
  session,
  inline,
}: { session: EditorSession } & EditorProps) {
  const [draft, setDraft] = useState(session.note),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(
      session.recovered
        ? `${t.captureRecovered} ${session.incomingAdded ? t.captureIncomingAdded : session.incomingSkipped ? t.captureLimit : ''}`
        : '',
    ),
    [localSaved, setLocalSaved] = useState(true),
    [link, setLink] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
      remote: Annotation;
      local: NoteEdit;
      merged: NoteEdit;
      fields: NoteEditField[];
    } | null>(null),
    [choices, setChoices] = useState<Partial<Record<NoteEditField, 'mine' | 'saved'>>>({});
  const draftRef = useRef(draft),
    writes = useRef(new DraftWriteQueue()),
    alive = useRef(true);
  // Typing in the composer pauses any sibling media players through context;
  // the release on blur / submit / cancel lets them resume what they owned.
  const typingPause = useTypingPauseController();
  const typingPauseRef = useRef(typingPause);
  typingPauseRef.current = typingPause;
  useEffect(
    () => () => {
      typingPauseRef.current.release();
    },
    [],
  );
  function changeNote(patch: Partial<NoteDraft>, semantic = true) {
    const next = {
      ...draftRef.current,
      ...patch,
      ...(semantic ? { stamp: crypto.randomUUID() } : {}),
    };
    draftRef.current = next;
    setDraft(next);
    setLocalSaved(false);
    void writes.current
      .enqueue([{ table: 'notes', key: session.key, value: next }], 'note')
      .then(() => {
        if (alive.current) setLocalSaved(true);
      })
      .catch((e) => {
        if (alive.current) setError(e instanceof Error ? e.message : t.captureDraftError);
      });
    return next;
  }
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, HTMLAttributes: { target: '_blank', rel: 'noreferrer' } },
      }),
      TableKit.configure({ table: { resizable: true } }),
      Markdown,
      InlineMath,
      BlockMath,
    ],
    content: session.note.document,
    contentType: 'json',
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': t.annotationBody, spellcheck: 'true' },
    },
    onUpdate: ({ editor }) => {
      typingPauseRef.current.pulse();
      changeNote({ document: editor.getJSON() });
    },
  });
  useEffect(() => {
    editor?.setEditable(!pending && !conflict, false);
  }, [editor, pending, conflict]);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const leave = async () => {
    if (pending) return;
    typingPause.release();
    try {
      await writes.current.flush();
      await session.workspace.flush();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.captureDraftError);
    }
  };
  const toolbar = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive('bold'),
      italic: editor?.isActive('italic'),
      heading: editor?.isActive('heading', { level: 2 }),
      list: editor?.isActive('bulletList'),
      ordered: editor?.isActive('orderedList'),
      quote: editor?.isActive('blockquote'),
      code: editor?.isActive('code'),
      link: editor?.isActive('link'),
    }),
  });
  function localFields(note: NoteDraft): NoteEdit {
    const collection = session.workspace.getSnapshot();
    return {
      title: note.title,
      document: note.document,
      strokes: note.strokes,
      location: note.location || note.base?.location || request.location,
      references:
        note.references ||
        note.base?.references ||
        request.references ||
        (source ? [source.id] : []),
      ...(collection.managed
        ? {
            captures: collection.items.map((item) => {
              if (!item.version) throw new Error(t.capturePreviewUpdating);
              return {
                id: item.version.id,
                drawingDigest: item.localDrawingDigest || item.version.drawingDigest,
                label: item.label,
              };
            }),
          }
        : {}),
      ...(collection.stampsManaged ? { stamps: collection.stamps } : {}),
    };
  }
  async function reviewConflict() {
    try {
      const remote = annotationSnapshotSchema.parse(
        await api(`/annotations/${draftRef.current.ownerId}`),
      );
      if (
        remote.deleted ||
        remote.sessionId !== session.note.context.sessionId ||
        remote.sourceId !== session.note.context.sourceId ||
        remote.sourceVersion !== session.note.context.sourceVersion
      )
        throw new Error(t.sourceUnavailable);
      const local = localFields(draftRef.current),
        result = mergeNoteChanges(
          draftRef.current.base ? editableNote(draftRef.current.base) : undefined,
          local,
          editableNote(remote),
        );
      setChoices({});
      setConflict({ remote, local, merged: result.merged, fields: result.conflicts });
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    }
  }
  async function applyMerge() {
    if (!conflict || conflict.fields.some((field) => !choices[field])) return;
    setPending(true);
    try {
      const merged = { ...conflict.merged };
      for (const field of conflict.fields)
        Object.assign(merged, {
          [field]:
            choices[field] === 'saved'
              ? editableNote(conflict.remote)[field]
              : conflict.local[field],
        });
      const collection = session.workspace.getSnapshot(),
        known = new Map(
          [
            ...collection.items.flatMap((item) => (item.version ? [item.version] : [])),
            ...(conflict.remote.captures || []),
          ].map((item) => [`${item.id}:${item.drawingDigest}`, item]),
        );
      const versions = (merged.captures || []).map((item) => {
        const version = known.get(`${item.id}:${item.drawingDigest}`);
        if (!version) throw new Error(t.capturePreviewUpdating);
        return { ...version, label: item.label };
      });
      await session.workspace.replace(
        versions,
        merged.captures !== undefined,
        merged.stamps || [],
        merged.stamps !== undefined,
      );
      const nextBase = annotationSnapshotSchema.parse(conflict.remote);
      editor?.commands.setContent(merged.document, { emitUpdate: false });
      changeNote({
        title: merged.title,
        document: merged.document,
        strokes: merged.strokes,
        location: merged.location,
        references: merged.references,
        sourceMode: false,
        base: nextBase,
        pending: undefined,
        unverified: undefined,
      });
      await writes.current.flush();
      setConflict(null);
      setNotice(t.captureDraftSaved);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    } finally {
      setPending(false);
    }
  }
  async function save() {
    if (!editor || pending || conflict || draftRef.current.unverified) return;
    typingPause.release();
    setPending(true);
    setError('');
    try {
      if (request.sourceId && !source) throw new Error(t.sourceUnavailable);
      let current = draftRef.current;
      if (!current.pending) {
        const collection = await session.workspace.stageAll(),
          fields = localFields(current);
        const input = annotationInputSchema.parse({
          id: current.ownerId,
          ...current.context,
          ...fields,
          origin: request.origin || current.base?.origin || 'manual',
          expectedRevision: current.base?.revision || 0,
          mutationId: crypto.randomUUID(),
        });
        current = changeNote(
          { pending: { input, noteStamp: current.stamp, collectionStamp: collection.stamp } },
          false,
        );
      }
      await writes.current.flush();
      await session.workspace.flush();
      const pendingSave = current.pending!,
        value = annotationSnapshotSchema.parse(
          await api(`/annotations/${current.ownerId}`, 'PUT', pendingSave.input),
        );
      await writes.current.flush();
      await session.workspace.flush();
      const cleared = await editorDrafts.acknowledge(
        session.key,
        current.ownerId,
        pendingSave,
        value,
      );
      if (!alive.current) return;
      if (cleared) {
        // Remove only the older text draft that was present when this editor opened.
        try {
          for (const previous of session.note.migratedDrafts || [])
            if (localStorage.getItem(previous.key) === previous.value)
              localStorage.removeItem(previous.key);
        } catch {}
        saved(value);
      } else {
        changeNote(
          {
            base: annotationSnapshotSchema.parse(value),
            pending: undefined,
            unverified: undefined,
          },
          false,
        );
        setNotice(t.captureNewerDraft);
      }
    } catch (e) {
      if (alive.current) {
        if (e instanceof ApiResponseError && e.status === 409) await reviewConflict();
        else setError(e instanceof Error ? e.message : t.error);
      }
    } finally {
      if (alive.current) setPending(false);
    }
  }
  const fieldLabels: Record<NoteEditField, string> = {
    title: t.captureRenameField,
    document: t.captureDocumentField,
    location: t.captureLocationField,
    strokes: t.captureStrokesField,
    references: t.captureReferencesField,
    captures: t.captureCapturesField,
    stamps: t.captureStampsField,
  };
  function fieldPreview(value: unknown) {
    return (
      value && typeof value === 'object' && 'type' in value
        ? richText(value as Annotation['document'])
        : typeof value === 'string'
          ? value
          : JSON.stringify(value) || '—'
    ).slice(0, 600);
  }
  return (
    <EditorShell
      inline={inline}
      title={request.initial ? t.editAnnotation : t.newAnnotation}
      close={() => {
        if (!pending) void leave();
      }}
      t={t}
    >
      <div className="annotation-editor" aria-busy={pending}>
        <fieldset className="annotation-edit-fields" disabled={pending || !!conflict}>
          <p className="annotation-source">{source?.name || t.sessionAnnotation}</p>
          {source && (
            <StampsRow
              source={source}
              baseLocation={request.location}
              workspace={session.workspace}
              pending={pending}
              t={t}
              onError={setError}
            />
          )}
          {request.location.quote && (
            <blockquote className="selected-quote">{request.location.quote}</blockquote>
          )}
          <div className="annotation-rich">
          <div className="rich-toolbar" role="toolbar" aria-label={t.annotationFormatting}>
            <IconButton
              label={t.bold}
              disabled={pending}
              aria-pressed={toolbar?.bold}
              onClick={() => editor?.chain().focus().toggleBold().run()}
            >
              <Bold />
            </IconButton>
            <IconButton
              label={t.italic}
              disabled={pending}
              aria-pressed={toolbar?.italic}
              onClick={() => editor?.chain().focus().toggleItalic().run()}
            >
              <Italic />
            </IconButton>
            <IconButton
              label={t.headingTwo}
              disabled={pending}
              aria-pressed={toolbar?.heading}
              onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            >
              <Heading2 />
            </IconButton>
            <IconButton
              label={t.bulletList}
              disabled={pending}
              aria-pressed={toolbar?.list}
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
            >
              <List />
            </IconButton>
            <IconButton
              label={t.numberedList}
              disabled={pending}
              aria-pressed={toolbar?.ordered}
              onClick={() => editor?.chain().focus().toggleOrderedList().run()}
            >
              <ListOrdered />
            </IconButton>
            <IconButton
              label={t.indentIncrease}
              disabled={pending}
              onClick={() => editor?.chain().focus().sinkListItem('listItem').run()}
            >
              <IndentIncrease />
            </IconButton>
            <IconButton
              label={t.indentDecrease}
              disabled={pending}
              onClick={() => editor?.chain().focus().liftListItem('listItem').run()}
            >
              <IndentDecrease />
            </IconButton>
            <IconButton
              label={t.blockQuote}
              disabled={pending}
              aria-pressed={toolbar?.quote}
              onClick={() => editor?.chain().focus().toggleBlockquote().run()}
            >
              <Quote />
            </IconButton>
            <IconButton
              label={t.codeBlock}
              disabled={pending}
              aria-pressed={toolbar?.code}
              onClick={() => editor?.chain().focus().toggleCode().run()}
            >
              <Code />
            </IconButton>
            <IconButton
              label={t.insertLink}
              disabled={pending}
              aria-pressed={toolbar?.link}
              onClick={() => setLink(editor?.getAttributes('link').href || 'https://')}
            >
              <Link />
            </IconButton>
          </div>
          <EditorContent
            editor={editor}
            className="annotation-body"
            onBlur={() => typingPause.release()}
          />
          <p className="annotation-list-hint">{t.annotationListHint}</p>
          </div>
          <CaptureCollectionEditor
            catalog={catalog}
            actions={treeActions}
            source={source}
            location={draft.location || request.location}
            workspace={session.workspace}
            t={t}
            disabled={pending || !!conflict}
          />
        </fieldset>
        <p role="status" className="capture-draft-status">
          {notice} {localSaved ? t.captureDraftSaved : t.captureDraftSaving}
        </p>
        {typingPause.typing && (
          <p role="status" className="typing-pause-chip">
            {t.typingPauseStatus}
          </p>
        )}
        {draft.pending && !conflict && <p>{t.captureNetworkPending}</p>}
        {draft.unverified && (
          <div className="capture-recovery-review">
            <p>{t.captureUnverified}</p>
            {draft.base && (
              <details>
                <summary>{t.captureSavedVersion}</summary>
                <RichContent document={draft.base.document} t={t} />
              </details>
            )}
            <Button
              onClick={() => {
                void (async () => {
                  if (JSON.stringify(draft.strokes) !== JSON.stringify(draft.base?.strokes || [])) {
                    const original = session.workspace
                      .getSnapshot()
                      .items.find((item) => item.original);
                    if (original) {
                      await session.workspace.stageOne(original.descriptor.id);
                      const model = await session.workspace.loadDrawing(original.descriptor.id);
                      await session.workspace.applyDrawing(original.descriptor.id, {
                        ...model,
                        objects: draft.strokes.map((stroke) => ({
                          id: crypto.randomUUID(),
                          kind: stroke.width >= 10 ? ('highlight' as const) : ('pen' as const),
                          points: stroke.points,
                          color: stroke.color,
                          width: stroke.width,
                        })),
                      });
                    }
                  }
                  changeNote({ unverified: undefined });
                })().catch((e) => setError(e instanceof Error ? e.message : t.error));
              }}
            >
              {t.captureReviewDraft}
            </Button>
          </div>
        )}
        {conflict && (
          <section className="capture-conflict">
            <p role="alert">{t.captureConflict}</p>
            {conflict.fields.map((field) => (
              <fieldset key={field}>
                <legend>{fieldLabels[field]}</legend>
                <label>
                  <input
                    type="radio"
                    name={field}
                    checked={choices[field] === 'mine'}
                    onChange={() => setChoices({ ...choices, [field]: 'mine' })}
                  />
                  {t.captureKeepMine}
                  <pre>{fieldPreview(conflict.local[field])}</pre>
                </label>
                <label>
                  <input
                    type="radio"
                    name={field}
                    checked={choices[field] === 'saved'}
                    onChange={() => setChoices({ ...choices, [field]: 'saved' })}
                  />
                  {t.captureUseSaved}
                  <pre>{fieldPreview(editableNote(conflict.remote)[field])}</pre>
                </label>
              </fieldset>
            ))}
            <Button
              variant="primary"
              disabled={pending || conflict.fields.some((field) => !choices[field])}
              onClick={() => void applyMerge()}
            >
              {t.captureReviewMerge}
            </Button>
          </section>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button
            variant="primary"
            disabled={pending || !editor || !!conflict || !!draft.unverified}
            onClick={() => void save()}
          >
            {pending ? t.working : draft.pending ? t.captureRetrySave : t.saveAnnotation}
          </Button>
          <Button variant="ghost" disabled={pending} onClick={() => void leave()}>
            {t.cancel}
          </Button>
        </div>
      </div>
      {link !== null && (
        <Modal title={t.insertLink} close={() => setLink(null)} closeLabel={t.close}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!/^(https?:\/\/|mailto:)/i.test(link) || /[\u0000-\u0020]/.test(link)) {
                setError(t.invalidLink);
                return;
              }
              if (editor?.state.selection.empty)
                editor
                  .chain()
                  .focus()
                  .insertContent({
                    type: 'text',
                    text: link,
                    marks: [{ type: 'link', attrs: { href: link } }],
                  })
                  .run();
              else editor?.chain().focus().extendMarkRange('link').setLink({ href: link }).run();
              setLink(null);
            }}
          >
            <label>
              {t.linkAddress}
              <input autoFocus value={link} onChange={(event) => setLink(event.target.value)} />
            </label>
            <div className="modal-actions">
              <Button type="submit" variant="primary">
                {t.save}
              </Button>
              <Button onClick={() => setLink(null)}>{t.cancel}</Button>
            </div>
          </form>
        </Modal>
      )}
    </EditorShell>
  );
}
