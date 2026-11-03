import React from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import { mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Mention from '@tiptap/extension-mention';
import type { SuggestionProps } from '@tiptap/suggestion';

/**
 * Payload the parent needs to render its menu. `command` commits the highlighted candidate as
 * a chip (TipTap's Suggestion plugin owns the range replacement); `rect` positions the menu
 * above the editor and tracks as the caret moves.
 */
export type MentionKind = 'file' | 'concept';
export type MentionRecord = { id: string; label: string; kind: MentionKind };
export type ComposerSuggestion = {
  query: string;
  command: (attrs: MentionRecord) => void;
  rect: DOMRect | null;
};

/**
 * Keyboard glue the parent populates when its menu mounts. The Suggestion plugin grabs the
 * keystrokes that hit the editor while a suggestion is open; forwarding them through this
 * ref lets the menu drive highlight/commit without stealing the editor's focus.
 */
export type ComposerMenuCommands = {
  highlightPrev: () => void;
  highlightNext: () => void;
  commit: () => boolean;
};

export type TipTapComposerHandle = {
  focus: (options?: FocusOptions) => void;
  clear: () => void;
  setDraft: (text: string) => void;
  /** Mentions currently in the editor, in document order; duplicates stay duplicated. */
  readMentions: () => MentionRecord[];
};

/** `@label` for mentions, paragraph breaks as `\n`, hard breaks also as `\n`. */
function serializeDoc(editor: Editor): string {
  const paragraphs: string[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name !== 'paragraph') {
      paragraphs.push(node.textContent);
      return;
    }
    let out = '';
    node.forEach((child) => {
      if (child.type.name === 'text') out += child.text ?? '';
      else if (child.type.name === 'mention') out += `@${child.attrs.label ?? child.attrs.id}`;
      else if (child.type.name === 'hardBreak') out += '\n';
      else out += child.textContent;
    });
    paragraphs.push(out);
  });
  return paragraphs.join('\n');
}

function buildDocFromDraft(draft: string, candidates: string[]): object {
  const ordered = [...candidates].sort((a, b) => b.length - a.length);
  const lines = draft.split('\n');
  return {
    type: 'doc',
    content: lines.map((line) => ({
      type: 'paragraph',
      content: parseLine(line, ordered),
    })),
  };
}

function parseLine(line: string, ordered: string[]): object[] {
  const out: object[] = [];
  let cursor = 0;
  const pushText = (text: string) => {
    if (text) out.push({ type: 'text', text });
  };
  while (cursor < line.length) {
    const at = line.indexOf('@', cursor);
    if (at < 0) {
      pushText(line.slice(cursor));
      break;
    }
    if (at > 0 && !/\s/.test(line[at - 1])) {
      pushText(line.slice(cursor, at + 1));
      cursor = at + 1;
      continue;
    }
    const match = ordered.find((name) => {
      if (line.slice(at + 1, at + 1 + name.length) !== name) return false;
      const next = line[at + 1 + name.length];
      return next === undefined || /\s/.test(next);
    });
    if (!match) {
      pushText(line.slice(cursor, at + 1));
      cursor = at + 1;
      continue;
    }
    pushText(line.slice(cursor, at));
    out.push({ type: 'mention', attrs: { id: match, label: match } });
    cursor = at + 1 + match.length;
  }
  return out;
}

export const TipTapComposer = React.forwardRef<
  TipTapComposerHandle,
  {
    initialDraft: string;
    candidates: string[];
    placeholder: string;
    ariaLabel: string;
    onDraftChange: (value: string) => void;
    onSuggestionChange: (suggestion: ComposerSuggestion | null) => void;
    onSubmit: () => void;
    onEscape: () => void;
    onEmptyBackspace: () => boolean;
    /** Live reference to the menu's keyboard commands; `null` when the menu isn't mounted. */
    menuCommandsRef: React.RefObject<ComposerMenuCommands | null>;
  }
>(function TipTapComposer(props, ref) {
  const {
    initialDraft,
    candidates,
    placeholder,
    ariaLabel,
    onDraftChange,
    onSuggestionChange,
    onSubmit,
    onEscape,
    onEmptyBackspace,
    menuCommandsRef,
  } = props;

  const candidatesRef = React.useRef(candidates);
  candidatesRef.current = candidates;
  const suggestionChangeRef = React.useRef(onSuggestionChange);
  suggestionChangeRef.current = onSuggestionChange;
  const submitRef = React.useRef(onSubmit);
  submitRef.current = onSubmit;
  const escapeRef = React.useRef(onEscape);
  escapeRef.current = onEscape;
  const emptyBackspaceRef = React.useRef(onEmptyBackspace);
  emptyBackspaceRef.current = onEmptyBackspace;
  const suggestionOpenRef = React.useRef(false);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          codeBlock: false,
          blockquote: false,
          horizontalRule: false,
          bold: false,
          italic: false,
          strike: false,
          code: false,
        }),
        Placeholder.configure({ placeholder, emptyEditorClass: 'composer-empty' }),
        Mention.extend({
          // Default node spec prints `@label`; the chip visual already looks like a tag, so
          // the `@` would duplicate the signal. Serialized text (copy/paste) still uses `@`.
          renderHTML({ node, HTMLAttributes }) {
            return [
              'span',
              mergeAttributes({ 'data-type': 'mention' }, this.options.HTMLAttributes, HTMLAttributes),
              node.attrs.label ?? node.attrs.id,
            ];
          },
          addAttributes() {
            return {
              ...this.parent?.(),
              // The picker tags each chip with its origin so the send pipeline can emit a
              // structured record (id + kind + label) alongside the plain-text prompt.
              kind: {
                default: 'file',
                parseHTML: (element) => element.getAttribute('data-kind') || 'file',
                renderHTML: (attrs) => (attrs.kind ? { 'data-kind': attrs.kind } : {}),
              },
            };
          },
        }).configure({
          HTMLAttributes: { class: 'composer-chip-inline' },
          renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
          suggestion: {
            char: '@',
            allowSpaces: true,
            items: ({ query }) => {
              const q = query.trim().toLocaleLowerCase('es');
              return candidatesRef.current
                .filter((name) => !q || name.toLocaleLowerCase('es').includes(q))
                .slice(0, 50)
                .map((name) => ({ id: name, label: name }));
            },
            render: () => ({
              onStart: (p: SuggestionProps) => {
                suggestionOpenRef.current = true;
                suggestionChangeRef.current({
                  query: p.query,
                  command: (attrs) => p.command(attrs),
                  rect: p.clientRect?.() ?? null,
                });
              },
              onUpdate: (p: SuggestionProps) => {
                suggestionChangeRef.current({
                  query: p.query,
                  command: (attrs) => p.command(attrs),
                  rect: p.clientRect?.() ?? null,
                });
              },
              onKeyDown: ({ event }) => {
                if (event.key === 'Escape') {
                  escapeRef.current();
                  return true;
                }
                const menu = menuCommandsRef.current;
                if (!menu) return false;
                if (event.key === 'ArrowDown') {
                  menu.highlightNext();
                  return true;
                }
                if (event.key === 'ArrowUp') {
                  menu.highlightPrev();
                  return true;
                }
                if (event.key === 'Enter' || event.key === 'Tab') return menu.commit();
                return false;
              },
              onExit: () => {
                suggestionOpenRef.current = false;
                suggestionChangeRef.current(null);
              },
            }),
          },
        }),
      ],
      content: buildDocFromDraft(initialDraft, candidates),
      editorProps: {
        attributes: {
          class: 'composer-editable',
          role: 'textbox',
          'aria-label': ariaLabel,
          'aria-multiline': 'true',
        },
        handleKeyDown: (view, event) => {
          if (event.key === 'Enter' && !event.shiftKey && !suggestionOpenRef.current) {
            event.preventDefault();
            submitRef.current();
            return true;
          }
          if (
            event.key === 'Backspace' &&
            !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.repeat &&
            !suggestionOpenRef.current
          ) {
            if (view.state.doc.textContent.length === 0 && emptyBackspaceRef.current()) {
              event.preventDefault();
              return true;
            }
          }
          return false;
        },
      },
      onUpdate: ({ editor: ed }) => {
        onDraftChange(serializeDoc(ed));
      },
    },
    // Stable editor across renders; dynamic bits flow in via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  React.useImperativeHandle(
    ref,
    () => ({
      focus: (options) => {
        editor?.commands.focus(options?.preventScroll ? undefined : 'end');
      },
      clear: () => {
        editor?.commands.clearContent(true);
      },
      setDraft: (text) => {
        if (!editor) return;
        if (serializeDoc(editor) === text) return;
        editor.commands.setContent(buildDocFromDraft(text, candidatesRef.current), { emitUpdate: false });
      },
      readMentions: () => {
        if (!editor) return [];
        const out: MentionRecord[] = [];
        editor.state.doc.descendants((node) => {
          if (node.type.name === 'mention') {
            const id = (node.attrs.id ?? '') as string;
            const label = (node.attrs.label ?? id) as string;
            const kindAttr = (node.attrs.kind ?? 'file') as string;
            const kind: MentionKind = kindAttr === 'concept' ? 'concept' : 'file';
            if (id) out.push({ id, label, kind });
          }
          return true;
        });
        return out;
      },
    }),
    [editor],
  );

  return <EditorContent editor={editor} />;
});
