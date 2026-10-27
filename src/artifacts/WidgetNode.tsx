import { useId, useState } from 'react';
import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { GripVertical, Minus, PencilLine, Plus, Trash2 } from 'lucide-react';
import { parseWidget, validateWidgetDraft } from '../../shared/artifact-widgets';
import { Button, IconButton } from '../design/components';
import type { T } from '../i18n';

type Draft = Record<string, unknown>;
type Item = Record<string, string | undefined>;
type ListForm = {
  key: string;
  min: number;
  max: number;
  fields: Array<{ key: string; label: keyof T; long?: boolean }>;
};
/** Widgets made of a title and a list of items are edited as forms; the rest as JSON. */
const listForms: Partial<Record<string, ListForm>> = {
  summary: {
    key: 'points',
    min: 1,
    max: 7,
    fields: [{ key: 'text', label: 'widgetText', long: true }],
  },
  steps: {
    key: 'steps',
    min: 2,
    max: 12,
    fields: [
      { key: 'title', label: 'widgetItemTitle' },
      { key: 'body', label: 'widgetItemBody', long: true },
    ],
  },
  timeline: {
    key: 'events',
    min: 2,
    max: 20,
    fields: [
      { key: 'label', label: 'widgetItemLabel' },
      { key: 'title', label: 'widgetItemTitle' },
      { key: 'body', label: 'widgetItemBody', long: true },
    ],
  },
};
const formTypes = new Set([...Object.keys(listForms), 'predict', 'details']);

function WidgetView({ node, updateAttributes, deleteNode, extension, selected }: NodeViewProps) {
  const t = (extension.options as { t: T }).t;
  const radioGroup = useId();
  const source = String(node.attrs.source || '');
  const widget = parseWidget(source);
  const [draft, setDraft] = useState<Draft | null>(null),
    [json, setJson] = useState(''),
    [error, setError] = useState('');
  const type = String(widget?.type || '');
  const asForm = !!widget && formTypes.has(type);
  const open = () => {
    setError('');
    setDraft(widget ? (structuredClone(widget) as Draft) : {});
    setJson(widget ? JSON.stringify(widget, null, 2) : source);
  };
  const apply = () => {
    let value: unknown = draft;
    if (!asForm) {
      try {
        value = JSON.parse(json);
      } catch {
        return setError(t.widgetInvalidJson);
      }
    }
    const result = validateWidgetDraft(value);
    if (result.error) return setError(result.error);
    updateAttributes({ source: result.source });
    setDraft(null);
  };
  const set = (key: string, value: unknown) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const text = (key: string, label: string, long = false) => {
    const props = {
      'aria-label': label,
      value: String(draft?.[key] ?? ''),
      onChange: (event: { target: { value: string } }) => set(key, event.target.value),
    };
    return (
      <label className="widget-field">
        <span>{label}</span>
        {long ? <textarea rows={3} {...props} /> : <input {...props} />}
      </label>
    );
  };
  const list = listForms[type];
  const items = list ? ((draft?.[list.key] as Item[]) ?? []) : [];
  const choices = (draft?.choices as string[]) ?? [];
  const heading =
    widget &&
    ('title' in widget && widget.title
      ? widget.title
      : 'prompt' in widget
        ? widget.prompt
        : 'summary' in widget
          ? widget.summary
          : '');
  return (
    <NodeViewWrapper
      className={`editor-widget ${selected ? 'selected' : ''}`}
      data-widget-type={type || 'invalid'}
    >
      <div className="editor-widget-head" contentEditable={false}>
        <span className="editor-widget-grip" data-drag-handle title={t.dragWidget}>
          <GripVertical aria-hidden />
        </span>
        <span className="editor-widget-label">
          <strong>{widget ? t.widgetBlock : t.widgetBadData}</strong>
          {widget && ` · ${type}${heading ? ` · ${heading}` : ''}`}
        </span>
        {draft === null && (
          <IconButton label={t.editWidget} onClick={open}>
            <PencilLine />
          </IconButton>
        )}
        <IconButton label={t.removeWidget} onClick={deleteNode}>
          <Trash2 />
        </IconButton>
      </div>
      {draft !== null && (
        <div className="editor-widget-form" contentEditable={false}>
          {!asForm ? (
            <label className="widget-field">
              <span>{t.widgetJson}</span>
              <textarea
                rows={10}
                spellCheck={false}
                aria-label={t.widgetJson}
                value={json}
                onChange={(event) => setJson(event.target.value)}
              />
            </label>
          ) : type === 'details' ? (
            <>
              {text('summary', t.widgetDisclosureTitle)}
              {text('body', t.widgetItemBody, true)}
            </>
          ) : type === 'predict' ? (
            <>
              {text('prompt', t.widgetPrompt, true)}
              <fieldset className="widget-rows">
                <legend>{t.widgetChoices}</legend>
                {choices.map((choice, index) => (
                  <div key={index} className="widget-row">
                    <input
                      type="radio"
                      name={radioGroup}
                      aria-label={t.widgetCorrectChoice}
                      checked={draft.correctIndex === index}
                      onChange={() => set('correctIndex', index)}
                    />
                    <input
                      aria-label={`${t.widgetChoices} ${index + 1}`}
                      value={choice}
                      onChange={(event) =>
                        set(
                          'choices',
                          choices.map((item, i) => (i === index ? event.target.value : item)),
                        )
                      }
                    />
                    <IconButton
                      label={t.removeRow}
                      onClick={() => {
                        set(
                          'choices',
                          choices.filter((_, i) => i !== index),
                        );
                        const correct = draft.correctIndex as number | undefined;
                        if (correct !== undefined && correct >= index)
                          set('correctIndex', correct === index ? undefined : correct - 1);
                      }}
                    >
                      <Minus />
                    </IconButton>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={choices.length >= 5}
                  onClick={() => set('choices', [...choices, ''])}
                >
                  <Plus />
                  {t.addRow}
                </Button>
              </fieldset>
              {text('reveal', t.widgetReveal, true)}
            </>
          ) : list ? (
            <>
              {text('title', t.widgetTitle)}
              <fieldset className="widget-rows">
                <legend>{t.widgetItems}</legend>
                {items.map((item, index) => (
                  <div key={index} className="widget-row">
                    <span className="widget-row-number">{index + 1}</span>
                    <div>
                      {list.fields.map((field) => {
                        const props = {
                          'aria-label': `${t[field.label]} ${index + 1}`,
                          placeholder: t[field.label] as string,
                          value: item[field.key] ?? '',
                          onChange: (event: { target: { value: string } }) =>
                            set(
                              list.key,
                              items.map((row, i) =>
                                i === index ? { ...row, [field.key]: event.target.value } : row,
                              ),
                            ),
                        };
                        return field.long ? (
                          <textarea key={field.key} rows={2} {...props} />
                        ) : (
                          <input key={field.key} {...props} />
                        );
                      })}
                      {item.segmentId && (
                        <small className="muted">
                          {t.widgetCites} {item.segmentId}
                        </small>
                      )}
                    </div>
                    <IconButton
                      label={t.removeRow}
                      disabled={items.length <= list.min}
                      onClick={() =>
                        set(
                          list.key,
                          items.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <Minus />
                    </IconButton>
                  </div>
                ))}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={items.length >= list.max}
                  onClick={() =>
                    set(list.key, [
                      ...items,
                      Object.fromEntries(list.fields.map((field) => [field.key, ''])),
                    ])
                  }
                >
                  <Plus />
                  {t.addRow}
                </Button>
              </fieldset>
            </>
          ) : null}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="editor-widget-actions">
            <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
              {t.cancel}
            </Button>
            <Button size="sm" variant="primary" onClick={apply}>
              {t.applyWidget}
            </Button>
          </div>
        </div>
      )}
    </NodeViewWrapper>
  );
}

/** A ```widget block in the artifact editor: dragged as a unit, edited through a form. */
export const WidgetNode = Node.create<{ t: T | null }>({
  name: 'artifactWidget',
  group: 'block',
  atom: true,
  draggable: true,
  addOptions: () => ({ t: null }),
  addAttributes: () => ({ source: { default: '' } }),
  parseHTML: () => [{ tag: 'div[data-artifact-widget]' }],
  renderHTML: ({ node }) => ['div', { 'data-artifact-widget': '' }, node.attrs.source],
  addNodeView() {
    return ReactNodeViewRenderer(WidgetView);
  },
  markdownTokenizer: {
    name: 'artifactWidget',
    level: 'block',
    start: (source) => source.search(/^```widget/m),
    tokenize(source) {
      const match = source.match(/^```widget[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n|$)/);
      if (!match) return undefined;
      return { type: 'artifactWidget', raw: match[0], text: match[1] };
    },
  },
  parseMarkdown: (token) => ({ type: 'artifactWidget', attrs: { source: token.text || '' } }),
  renderMarkdown: (node) => `\`\`\`widget\n${node.attrs?.source || ''}\n\`\`\``,
});
