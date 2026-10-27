import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { FilePlus, Upload, PenLine } from 'lucide-react';
import { api, uploadFile, ApiResponseError } from '../api';
import { Button, Modal } from '../design/components';
import type { T } from '../i18n';
import type { Catalog, Source } from '../../shared/domain';
import { fold } from '../../shared/domain';
import { sourceState } from '../../shared/directories';
import type { Annotation, AnnotationSummary } from '../../shared/annotations';
import { queryAnnotations } from '../annotations/api';
import type { AnnotationRequest } from '../annotations/AnnotationEditor';
import { DirectoryTree, type TreeActions } from '../workspace/DirectoryTree';
import { MAX_QUESTION_ATTACHMENTS, type QuestionAttachment } from '../../shared/tutor-attachments';
const AnnotationEditor = lazy(() => import('../annotations/AnnotationEditor'));

export function AttachmentPicker({
  sessionId,
  source,
  catalog,
  t,
  treeActions,
  chosen,
  choose,
  close,
  changed,
  prepareSource,
  createAttachment,
}: {
  sessionId: string;
  source: Source | null;
  catalog: Catalog;
  t: T;
  treeActions: TreeActions;
  chosen: QuestionAttachment[];
  choose: (item: QuestionAttachment) => void;
  close: () => void;
  changed: () => Promise<unknown>;
  prepareSource: (source: Source) => void;
  createAttachment: () => Promise<AnnotationRequest | null>;
}) {
  const [query, setQuery] = useState(''),
    [mode, setMode] = useState<'files' | 'notes'>('files'),
    [notes, setNotes] = useState<AnnotationSummary[]>([]),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [toPrepare, setToPrepare] = useState<Source | null>(null),
    [editor, setEditor] = useState<AnnotationRequest | null>(null);
  const upload = useRef<HTMLInputElement>(null),
    alive = useRef(true);
  const attaching = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (error) {
      errorRef.current?.focus();
      errorRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [error]);
  const selectedFile = useRef<Source | null>(null);
  const operations = useRef(new Map<string, string>());
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const ids = catalog.files
      .filter((file) => sourceState(file, catalog.directories) !== 'trash')
      .map((file) => file.id);
    const load = async () => {
      const pages: AnnotationSummary[][] = [];
      for (let start = 0; start < Math.max(1, ids.length); start += 100) {
        pages.push(
          ...(await Promise.all([
            queryAnnotations(sessionId, ids.slice(start, start + 100), start === 0),
            queryAnnotations(sessionId, ids.slice(start, start + 100), start === 0, 'bookmark'),
          ])),
        );
      }
      return pages;
    };
    void load()
      .then((pages) => {
        if (active) setNotes(pages.flat().filter((note) => !note.deleted));
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [sessionId, catalog.files]);
  const attach = async (
    value:
      | { kind: 'file'; sourceId: string; sourceVersion: number }
      | { kind: 'annotation'; annotationId: string; revision: number },
  ) => {
    if (attaching.current) return;
    setToPrepare(null);
    if (chosen.length >= MAX_QUESTION_ATTACHMENTS) {
      setError(t.attachmentLimit);
      return;
    }
    if (
      chosen.some((item) =>
        value.kind === 'file'
          ? item.kind === 'file' &&
            item.sourceId === value.sourceId &&
            item.sourceVersion === value.sourceVersion
          : item.annotationId === value.annotationId && item.annotationRevision === value.revision,
      )
    ) {
      setError(t.attachmentAlreadySelected);
      return;
    }
    attaching.current = true;
    setBusy(true);
    setError('');
    const key = JSON.stringify(value);
    let id = operations.current.get(key);
    if (!id) {
      id = crypto.randomUUID();
      operations.current.set(key, id);
    }
    try {
      const item = await api<QuestionAttachment>('/tutor-attachments', 'POST', {
        ...value,
        id,
        sessionId,
      });
      if (alive.current) {
        choose(item);
        close();
      }
    } catch (e) {
      if (alive.current) {
        setError(e instanceof Error ? e.message : t.error);
        if (
          value.kind === 'file' &&
          e instanceof ApiResponseError &&
          e.status === 409 &&
          e.message.startsWith('Prepare this PDF') &&
          selectedFile.current?.id === value.sourceId
        )
          setToPrepare(selectedFile.current);
      }
    } finally {
      attaching.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const attachFile = (file: Source) => {
    selectedFile.current = file;
    void attach({ kind: 'file', sourceId: file.id, sourceVersion: file.version });
  };
  return (
    <>
      <Modal
        title={t.attachForQuestion}
        close={close}
        closeLabel={t.close}
        className="attachment-picker"
      >
        <p>{t.attachmentDisclosure}</p>
        <p className="muted">{t.attachmentLimits}</p>
        {busy && <p role="status">{t.preparingAttachment}</p>}
        {error && (
          <p className="form-error" role="alert" tabIndex={-1} ref={errorRef}>
            {error}
          </p>
        )}
        {error && toPrepare && (
          <Button
            onClick={() => {
              close();
              prepareSource(toPrepare);
            }}
          >
            {t.openToPrepareAttachment}
          </Button>
        )}
        <fieldset disabled={busy}>
          <div className="attachment-picker-actions">
            {source && (
              <Button onClick={() => attachFile(source)}>
                <FilePlus size={16} />
                {t.attachCurrentResource}
              </Button>
            )}
            {source && (
              <Button
                onClick={() => {
                  setBusy(true);
                  setError('');
                  void createAttachment()
                    .then((value) => {
                      if (alive.current && value) setEditor(value);
                    })
                    .catch((e) => {
                      if (alive.current) setError(e.message);
                    })
                    .finally(() => {
                      if (alive.current) setBusy(false);
                    });
                }}
              >
                <PenLine size={16} />
                {t.createAnnotatedAttachment}
              </Button>
            )}
            <Button onClick={() => upload.current?.click()}>
              <Upload size={16} />
              {t.importAttachment}
            </Button>
            <input
              ref={upload}
              type="file"
              accept=".md,.txt,.pdf,.mp3,.wav,.mp4,.png,.jpg,.jpeg"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                if (file.size > 20 * 1024 * 1024) {
                  setError(t.attachmentUploadLimit);
                  return;
                }
                setBusy(true);
                setError('');
                void uploadFile(file, 'Attachments', () => {})
                  .then(async (saved) => {
                    await changed();
                    if (alive.current) {
                      setBusy(false);
                      attachFile(saved);
                    }
                  })
                  .catch((e) => {
                    if (alive.current) {
                      setBusy(false);
                      setError(e.message);
                    }
                  });
              }}
            />
          </div>
          <input
            type="search"
            aria-label={t.searchQuestionAttachments}
            placeholder={t.searchQuestionAttachments}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="attachment-picker-tabs" role="group" aria-label={t.attachmentTypes}>
            <Button aria-pressed={mode === 'files'} onClick={() => setMode('files')}>
              {t.files}
            </Button>
            <Button aria-pressed={mode === 'notes'} onClick={() => setMode('notes')}>
              {t.annotationsAndBookmarks}
            </Button>
          </div>
          {mode === 'files' ? (
            <DirectoryTree
              actions={treeActions}
              mode="file"
              directories={catalog.directories}
              files={catalog.files.filter(
                (file) => sourceState(file, catalog.directories) !== 'trash',
              )}
              view="files"
              query={query}
              storageKey="tl:tree:question-attachments"
              t={t}
              chooseFile={attachFile}
            />
          ) : (
            <div className="attachment-note-options">
              {loading && <p role="status">{t.loadingAnnotations}</p>}
              {notes
                .filter((note) => fold(`${note.title} ${note.text}`).includes(fold(query)))
                .map((note) => (
                  <button
                    key={note.id}
                    type="button"
                    onClick={() =>
                      void attach({
                        kind: 'annotation',
                        annotationId: note.id,
                        revision: note.revision,
                      })
                    }
                  >
                    <strong>{note.title || t.untitledAnnotation}</strong>
                    <span>
                      {note.kind === 'bookmark'
                        ? t.attachmentKind_bookmark
                        : note.capture
                          ? t.attachmentKind_capture
                          : t.attachmentKind_annotation}{' '}
                      · {t.revision} {note.revision} ·{' '}
                      {note.capture ? t.attachmentIncludesImage : t.attachmentTextOnly}
                    </span>
                    <small>{note.text.slice(0, 120)}</small>
                  </button>
                ))}
            </div>
          )}
        </fieldset>
      </Modal>
      {editor && (
        <Suspense fallback={<p role="status">{t.loadingAnnotations}</p>}>
          <AnnotationEditor
            catalog={catalog}
            treeActions={treeActions}
            key={editor.id}
            request={editor}
            sessionId={sessionId}
            source={catalog.files.find((file) => file.id === editor.sourceId) || null}
            t={t}
            close={() => setEditor(null)}
            saved={(note: Annotation) => {
              setEditor(null);
              void changed();
              void attach({ kind: 'annotation', annotationId: note.id, revision: note.revision });
            }}
          />
        </Suspense>
      )}
    </>
  );
}
