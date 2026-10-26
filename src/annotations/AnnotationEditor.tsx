import { useEffect, useRef, useState } from 'react';
import { useEditor, useEditorState, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { Markdown } from '@tiptap/markdown';
import {
  Bold,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link,
  Quote,
  Code2,
  Table,
  Undo2,
  Redo2,
} from 'lucide-react';
import {
  annotationInputSchema,
  plainDocument,
  richDocumentSchema,
  drawingSchema,
  type Annotation,
  type DrawingStroke,
  type SourceLocation,
} from '../../shared/annotations';
import type { Source } from '../../shared/domain';
import { api } from '../api';
import { Button, IconButton, Modal } from '../design/components';
import { Sketch } from './Sketch';
import type { T } from '../i18n';

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
export default function AnnotationEditor({
  request,
  sessionId,
  source,
  t,
  close,
  saved,
}: {
  request: AnnotationRequest;
  sessionId: string;
  source: Source | null;
  t: T;
  close: () => void;
  saved: (value: Annotation) => void;
}) {
  const draftKey = `tl:annotation-draft:${request.initial?.id || `${sessionId}:${request.sourceId}:${JSON.stringify(request.location)}`}`;
  const previousDraftKey = `tl:note-draft:${sessionId}:${request.sourceId}`;
  const [previousDraft] = useState(() => {
    try {
      return !request.initial && !request.markdown
        ? localStorage.getItem(previousDraftKey) || ''
        : '';
    } catch {
      return '';
    }
  });
  const [draft] = useState(() => {
    try {
      const value = JSON.parse(localStorage.getItem(draftKey) || 'null') as {
        title?: string;
        document?: unknown;
        markdown?: string;
        sourceMode?: boolean;
        strokes?: DrawingStroke[];
      } | null;
      if (!value) return null;
      const document = richDocumentSchema.safeParse(value.document);
      const drawing = drawingSchema.safeParse(value.strokes);
      return {
        title: typeof value.title === 'string' ? value.title.slice(0, 240) : '',
        document: document.success ? document.data : undefined,
        markdown: typeof value.markdown === 'string' ? value.markdown : '',
        sourceMode: value.sourceMode === true,
        strokes: drawing.success ? drawing.data : [],
      };
    } catch {
      return null;
    }
  });
  const [title, setTitle] = useState(draft?.title || request.initial?.title || ''),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [sourceMode, setSourceMode] = useState(draft?.sourceMode || false),
    [markdown, setMarkdown] = useState(draft?.markdown || request.markdown || ''),
    [strokes, setStrokes] = useState<DrawingStroke[]>(
      draft?.strokes || request.initial?.strokes || [],
    ),
    [link, setLink] = useState<string | null>(null);
  const record = useRef(request.initial),
    initialContent = useRef(
      draft?.document ||
        request.initial?.document ||
        request.markdown ||
        plainDocument(previousDraft),
    );
  const captureOperation = useRef(crypto.randomUUID());
  const capturePending = useRef(false);
  const draftRef = useRef({ title, sourceMode, markdown, strokes });
  draftRef.current = { title, sourceMode, markdown, strokes };
  const documentRef = useRef<unknown>(initialContent.current);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false, HTMLAttributes: { target: '_blank', rel: 'noreferrer' } },
      }),
      TableKit.configure({ table: { resizable: true } }),
      Markdown,
    ],
    content: initialContent.current,
    contentType: typeof initialContent.current === 'string' ? 'markdown' : 'json',
    editorProps: {
      attributes: { role: 'textbox', 'aria-label': t.annotationBody, spellcheck: 'true' },
    },
    onUpdate: ({ editor }) => persist(editor.getJSON()),
  });
  const toolbar = useEditorState({
    editor,
    selector: ({ editor }) => ({
      bold: editor?.isActive('bold'),
      italic: editor?.isActive('italic'),
      underline: editor?.isActive('underline'),
      list: editor?.isActive('bulletList'),
      ordered: editor?.isActive('orderedList'),
      table: editor?.isActive('table'),
      heading: editor?.isActive('heading')
        ? String(editor.getAttributes('heading').level)
        : 'paragraph',
    }),
  });
  const image: CaptureImage | undefined =
    request.capture ||
    (record.current?.capture
      ? {
          url: `/api/annotations/${record.current.id}/capture?v=${record.current.capture.id}`,
          width: record.current.capture.width,
          height: record.current.capture.height,
        }
      : undefined);
  function persist(document: unknown = documentRef.current) {
    if (document !== undefined) documentRef.current = document;
    try {
      localStorage.setItem(
        draftKey,
        JSON.stringify({ ...draftRef.current, document: documentRef.current }),
      );
    } catch {}
  }
  useEffect(() => persist(editor?.getJSON()), [title, sourceMode, markdown, strokes]);
  useEffect(() => {
    editor?.setEditable(!pending);
  }, [editor, pending]);
  useEffect(
    () => () => {
      if (request.capture?.blob) URL.revokeObjectURL(request.capture.url);
    },
    [],
  );
  const toggleSource = () => {
    if (!editor) return;
    if (sourceMode) editor.commands.setContent(markdown, { contentType: 'markdown' });
    else setMarkdown(editor.getMarkdown());
    setSourceMode(!sourceMode);
  };
  async function saveCapture(): Promise<Annotation> {
    const value = record.current!;
    const response = await fetch(
      `/api/annotations/${value.id}/capture?revision=${value.revision}&width=${request.capture!.width}&height=${request.capture!.height}&operationId=${captureOperation.current}`,
      { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: request.capture!.blob },
    );
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || t.error);
    record.current = data;
    capturePending.current = false;
    return data;
  }
  const save = async () => {
    if (!editor || pending) return;
    setPending(true);
    setError('');
    try {
      if (request.sourceId && !source) throw new Error(t.sourceUnavailable);
      // Complete an interrupted image upload before making another metadata revision.
      if (capturePending.current) await saveCapture();
      if (sourceMode) editor.commands.setContent(markdown, { contentType: 'markdown' });
      const input = annotationInputSchema.parse({
        id: request.id,
        sessionId: request.initial?.sessionId || sessionId,
        sourceId: request.sourceId,
        sourceVersion: request.initial?.sourceVersion ?? source?.version ?? null,
        title,
        document: editor.getJSON(),
        location: request.location,
        strokes,
        origin: request.origin || request.initial?.origin || 'manual',
        references:
          request.references || request.initial?.references || (source ? [source.id] : []),
        expectedRevision: record.current?.revision || 0,
      });
      let value = await api<Annotation>(`/annotations/${request.id}`, 'PUT', input);
      record.current = value;
      if (request.capture?.blob && !value.capture) {
        capturePending.current = true;
        value = await saveCapture();
      }
      localStorage.removeItem(draftKey);
      if (previousDraft && localStorage.getItem(previousDraftKey) === previousDraft)
        localStorage.removeItem(previousDraftKey);
      saved(value);
    } catch (error) {
      setError(error instanceof Error ? error.message : t.error);
    } finally {
      setPending(false);
    }
  };
  return (
    <Modal
      title={request.initial ? t.editAnnotation : t.newAnnotation}
      close={() => {
        if (!pending) close();
      }}
      closeLabel={t.close}
    >
      <div className="annotation-editor" aria-busy={pending}>
        <p className="annotation-source">
          {source?.name || t.sessionAnnotation}
          {request.location.page
            ? ` · ${t.page} ${request.location.page}`
            : request.location.seconds != null
              ? ` · ${Math.floor(request.location.seconds / 60)}:${String(Math.floor(request.location.seconds % 60)).padStart(2, '0')}`
              : ''}
        </p>
        {request.location.quote && (
          <blockquote className="selected-quote">{request.location.quote}</blockquote>
        )}
        <label>
          {t.annotationTitle}
          <input
            aria-label={t.annotationTitle}
            maxLength={240}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={pending}
          />
        </label>
        <div className="rich-toolbar" role="toolbar" aria-label={t.annotationFormatting}>
          <select
            aria-label={t.textStyle}
            disabled={sourceMode || pending}
            value={toolbar?.heading || 'paragraph'}
            onChange={(event) => {
              if (event.target.value === 'paragraph') editor?.chain().focus().setParagraph().run();
              else
                editor
                  ?.chain()
                  .focus()
                  .toggleHeading({ level: Number(event.target.value) as 1 | 2 | 3 })
                  .run();
            }}
          >
            <option value="paragraph">{t.paragraph}</option>
            <option value="1">{t.headingOne}</option>
            <option value="2">{t.headingTwo}</option>
            <option value="3">{t.headingThree}</option>
          </select>
          <IconButton
            label={t.bold}
            disabled={sourceMode || pending}
            aria-pressed={toolbar?.bold}
            onClick={() => editor?.chain().focus().toggleBold().run()}
          >
            <Bold />
          </IconButton>
          <IconButton
            label={t.italic}
            disabled={sourceMode || pending}
            aria-pressed={toolbar?.italic}
            onClick={() => editor?.chain().focus().toggleItalic().run()}
          >
            <Italic />
          </IconButton>
          <IconButton
            label={t.underline}
            disabled={sourceMode || pending}
            aria-pressed={toolbar?.underline}
            onClick={() => editor?.chain().focus().toggleUnderline().run()}
          >
            <Underline />
          </IconButton>
          <IconButton
            label={t.bulletList}
            disabled={sourceMode || pending}
            aria-pressed={toolbar?.list}
            onClick={() => editor?.chain().focus().toggleBulletList().run()}
          >
            <List />
          </IconButton>
          <IconButton
            label={t.numberedList}
            disabled={sourceMode || pending}
            aria-pressed={toolbar?.ordered}
            onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          >
            <ListOrdered />
          </IconButton>
          <IconButton
            label={t.insertLink}
            disabled={sourceMode || pending}
            onClick={() => setLink(editor?.getAttributes('link').href || 'https://')}
          >
            <Link />
          </IconButton>
          <IconButton
            label={t.blockQuote}
            disabled={sourceMode || pending}
            onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          >
            <Quote />
          </IconButton>
          <IconButton
            label={t.codeBlock}
            disabled={sourceMode || pending}
            onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          >
            <Code2 />
          </IconButton>
          <IconButton
            label={t.insertTable}
            disabled={sourceMode || pending}
            onClick={() =>
              editor?.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run()
            }
          >
            <Table />
          </IconButton>
          <IconButton
            label={t.undo}
            disabled={sourceMode || pending}
            onClick={() => editor?.chain().focus().undo().run()}
          >
            <Undo2 />
          </IconButton>
          <IconButton
            label={t.redo}
            disabled={sourceMode || pending}
            onClick={() => editor?.chain().focus().redo().run()}
          >
            <Redo2 />
          </IconButton>
          <Button disabled={pending} onClick={toggleSource}>
            {sourceMode ? t.visualEditor : t.markdownSource}
          </Button>
        </div>
        {toolbar?.table && !sourceMode && (
          <fieldset disabled={pending} className="table-tools">
            <Button onClick={() => editor?.chain().focus().addRowAfter().run()}>{t.addRow}</Button>
            <Button onClick={() => editor?.chain().focus().addColumnAfter().run()}>
              {t.addColumn}
            </Button>
            <Button onClick={() => editor?.chain().focus().deleteTable().run()}>
              {t.removeTable}
            </Button>
          </fieldset>
        )}
        {sourceMode ? (
          <textarea
            disabled={pending}
            className="annotation-markdown"
            aria-label={t.annotationMarkdown}
            value={markdown}
            onChange={(event) => setMarkdown(event.target.value)}
          />
        ) : (
          <EditorContent editor={editor} className="annotation-body" />
        )}
        {image && (
          <div inert={pending}>
            <Sketch image={image} strokes={strokes} change={setStrokes} t={t} />
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button variant="primary" disabled={pending || !editor} onClick={() => void save()}>
            {pending ? t.working : t.saveAnnotation}
          </Button>
          <Button disabled={pending} onClick={close}>
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
    </Modal>
  );
}
