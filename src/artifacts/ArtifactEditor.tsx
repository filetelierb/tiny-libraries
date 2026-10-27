import { useState } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Blockquote from '@tiptap/extension-blockquote';
import { Markdown } from '@tiptap/markdown';
import {
  AlertTriangle,
  Bold,
  FlaskConical,
  Heading2,
  Heading3,
  Italic,
  Lightbulb,
  List,
  ListOrdered,
  Redo2,
  Sigma,
  Undo2,
} from 'lucide-react';
import type { Artifact } from '../../shared/domain';
import { api } from '../api';
import { Button, IconButton } from '../design/components';
import type { T } from '../i18n';
import { InlineMath, BlockMath } from '../annotations/mathNodes';
import { calloutMarker, editorMarkdown, type CalloutVariant } from '../study/callouts';
import { WidgetNode } from './WidgetNode';

type JsonNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: JsonNode[];
};

/** Blockquotes carry an optional callout variant, written back as a leading `[!variant]` line. */
const Callout = Blockquote.extend({
  addAttributes: () => ({
    variant: {
      default: null,
      parseHTML: (element) => element.getAttribute('data-callout'),
      renderHTML: (attributes) =>
        attributes.variant ? { 'data-callout': attributes.variant, class: 'study-callout' } : {},
    },
  }),
  parseMarkdown: (token, helpers) => {
    const children = (helpers.parseBlockChildren ?? helpers.parseChildren)(
      token.tokens || [],
    ) as JsonNode[];
    const first = children[0]?.type === 'paragraph' ? children[0].content?.[0] : undefined;
    const found = first?.type === 'text' ? calloutMarker(first.text || '') : null;
    if (found) {
      if (found.rest) first!.text = found.rest;
      else children[0].content!.shift();
      if (!children[0].content!.length) children.shift();
    }
    return helpers.createNode(
      'blockquote',
      found ? { variant: found.variant } : undefined,
      children.length ? children : [{ type: 'paragraph' }],
    );
  },
  renderMarkdown: (node, h) => {
    const lines = (node.content || []).map((child, index) =>
      (h.renderChild?.(child, index) ?? h.renderChildren([child]))
        .split('\n')
        .map((line: string) => (line.trim() ? `> ${line}` : '>'))
        .join('\n'),
    );
    const variant = node.attrs?.variant as CalloutVariant | null;
    return [...(variant ? [`> [!${variant}]`] : []), lines.join('\n>\n')].join('\n');
  },
});

const callouts = [
  ['key', Lightbulb],
  ['warning', AlertTriangle],
  ['example', FlaskConical],
] as const;

/** Edits an artifact's title and text; saving stores a new version and keeps the older ones. */
export function ArtifactEditor({
  sourceId,
  artifact,
  revision,
  t,
  onSaved,
  onCancel,
}: {
  sourceId: string;
  artifact: Artifact;
  revision: number;
  t: T;
  onSaved: (revision: number) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(artifact.title),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [formula, setFormula] = useState<string | null>(null),
    // Position of the formula being changed; null while inserting a new one.
    [formulaAt, setFormulaAt] = useState<number | null>(null),
    [discarding, setDiscarding] = useState(false);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2, 3] }, blockquote: false, link: false }),
      Callout,
      Markdown,
      InlineMath,
      BlockMath,
      WidgetNode.configure({ t }),
    ],
    content: artifact.explanation,
    contentType: 'markdown',
    editorProps: {
      // Clicking a formula opens it in the formula bar to change or keep.
      handleClickOn: (_view, _pos, node, nodePos) => {
        if (node.type.name !== 'inlineMath' && node.type.name !== 'blockMath') return false;
        setFormulaAt(nodePos);
        setFormula(String(node.attrs.latex || ''));
        return true;
      },
      attributes: {
        class: 'study-markdown',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': `${t.editArtifact}: ${artifact.title}`,
      },
    },
    onUpdate: () => setDirty(true),
  });
  const active = useEditorState({
    editor,
    selector: ({ editor }) => ({
      h2: !!editor?.isActive('heading', { level: 2 }),
      h3: !!editor?.isActive('heading', { level: 3 }),
      bold: !!editor?.isActive('bold'),
      italic: !!editor?.isActive('italic'),
      list: !!editor?.isActive('bulletList'),
      ordered: !!editor?.isActive('orderedList'),
      callout: editor?.isActive('blockquote')
        ? (editor.getAttributes('blockquote').variant as CalloutVariant | null)
        : undefined,
    }),
  });
  const chain = () => editor!.chain().focus();
  const callout = (variant: CalloutVariant) => {
    if (active?.callout === variant) chain().lift('blockquote').run();
    else if (active?.callout !== undefined)
      chain().updateAttributes('blockquote', { variant }).run();
    else chain().wrapIn('blockquote', { variant }).run();
  };
  const closeFormula = () => {
    setFormula(null);
    setFormulaAt(null);
  };
  const insertFormula = () => {
    const latex = formula?.trim();
    if (latex && formulaAt !== null)
      chain()
        .command(({ tr }) => {
          tr.setNodeMarkup(formulaAt, undefined, { latex });
          return true;
        })
        .run();
    else if (latex) chain().insertContent({ type: 'inlineMath', attrs: { latex } }).run();
    closeFormula();
  };
  const save = async () => {
    if (!editor) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api<{ revision: number }>(`/artifacts/${sourceId}/revisions`, 'POST', {
        expectedRevision: revision,
        artifact: {
          ...artifact,
          title: title.trim(),
          explanation: editorMarkdown(editor.getMarkdown()),
        },
      });
      onSaved(saved.revision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.error);
    } finally {
      setBusy(false);
    }
  };
  const tool = (label: string, Icon: typeof Bold, pressed: boolean, run: () => void) => (
    <IconButton
      key={label}
      label={label}
      aria-pressed={pressed}
      disabled={!editor || busy}
      onMouseDown={(event) => event.preventDefault()}
      onClick={run}
    >
      <Icon />
    </IconButton>
  );
  return (
    <div className="artifact-editor">
      <div className="rich-toolbar" role="toolbar" aria-label={t.artifactFormatting}>
        {tool(t.chapterTitle, Heading2, !!active?.h2, () =>
          chain().toggleHeading({ level: 2 }).run(),
        )}
        {tool(t.artifactSubtitle, Heading3, !!active?.h3, () =>
          chain().toggleHeading({ level: 3 }).run(),
        )}
        {tool(t.bold, Bold, !!active?.bold, () => chain().toggleBold().run())}
        {tool(t.italic, Italic, !!active?.italic, () => chain().toggleItalic().run())}
        {tool(t.bulletList, List, !!active?.list, () => chain().toggleBulletList().run())}
        {tool(t.numberedList, ListOrdered, !!active?.ordered, () =>
          chain().toggleOrderedList().run(),
        )}
        <span className="toolbar-divider" aria-hidden />
        {callouts.map(([variant, Icon]) =>
          tool(t[`highlightAs_${variant}`], Icon, active?.callout === variant, () =>
            callout(variant),
          ),
        )}
        {tool(t.insertFormula, Sigma, formula !== null, () =>
          formula === null ? setFormula('') : closeFormula(),
        )}
        <span className="toolbar-divider" aria-hidden />
        {tool(t.undo, Undo2, false, () => chain().undo().run())}
        {tool(t.redo, Redo2, false, () => chain().redo().run())}
      </div>
      {formula !== null && (
        <div className="artifact-editor-formula">
          <input
            autoFocus
            aria-label={t.formulaLatex}
            placeholder="f_s > 2 f_{max}"
            value={formula}
            onChange={(event) => setFormula(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                insertFormula();
              } else if (event.key === 'Escape') closeFormula();
            }}
          />
          <Button size="sm" variant="ghost" onClick={closeFormula}>
            {t.cancel}
          </Button>
          <Button size="sm" disabled={!formula.trim()} onClick={insertFormula}>
            {formulaAt === null ? t.insertFormula : t.updateFormula}
          </Button>
        </div>
      )}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      <div className="artifact-stage artifact-editor-body">
        <section className="generated-artifact">
          <div className="section-label">{t.explanation}</div>
          <input
            className="artifact-editor-title"
            aria-label={t.artifactTitle}
            value={title}
            disabled={busy}
            onChange={(event) => {
              setTitle(event.target.value);
              setDirty(true);
            }}
          />
          <EditorContent editor={editor} />
        </section>
      </div>
      <footer className="artifact-versions" aria-label={t.saveArtifactChanges}>
        {discarding ? (
          <>
            <span>{t.discardArtifactChanges}</span>
            <Button size="sm" variant="ghost" onClick={() => setDiscarding(false)}>
              {t.keepEditing}
            </Button>
            <Button size="sm" variant="danger" onClick={onCancel}>
              {t.discardChanges}
            </Button>
          </>
        ) : (
          <>
            <span>{t.newVersionHint}</span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => (dirty ? setDiscarding(true) : onCancel())}
            >
              {t.cancel}
            </Button>
            <Button
              size="sm"
              disabled={!dirty || busy || !title.trim()}
              onClick={() => void save()}
            >
              {busy ? t.saving : t.saveVersion}
            </Button>
          </>
        )}
      </footer>
    </div>
  );
}
