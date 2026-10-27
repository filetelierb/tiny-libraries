import { useMemo } from 'react';
import Markdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { T } from '../i18n';
import { Formula } from './Formula';
import { Diagram } from './Diagram';
import { remarkLatexDelimiters } from './latexDelimiters';

export function StudyMarkdown({ t, components, remarkPlugins = [], ...props }: Options & { t: T }) {
  // Stable component types preserve diagram dialogs/zoom when selection or citations update the parent.
  const shared = useMemo<Components>(
    () => ({
      a: ({ node: _node, ...link }) => <a {...link} target="_blank" rel="noreferrer" />,
      table: ({ node: _node, ...table }) => (
        <div className="study-table-scroll" tabIndex={0} role="region" aria-label={t.studyTable}>
          <table {...table} />
        </div>
      ),
      pre: ({ node, children, ref: _ref, ...pre }) => {
        const code = node?.children[0];
        const anchors = Object.fromEntries(
          [
            ...Object.entries(pre),
            ...Object.entries(code?.type === 'element' ? code.properties : {}),
          ].filter(([key]) => key.startsWith('data-source-')),
        );
        if (code?.type === 'element' && code.tagName === 'code') {
          const classes = String(code.properties.className || '').split(/[ ,]+/);
          const source = code.children
            .map((item) => (item.type === 'text' ? item.value : ''))
            .join('')
            .replace(/\n$/, '');
          if (classes.includes('language-mermaid'))
            return (
              <div {...anchors} className="study-code-block">
                <Diagram source={source} t={t} />
              </div>
            );
          if (classes.includes('language-math'))
            return (
              <div {...anchors} className="study-math-block">
                <Formula label={t.formula} source={source} display />
              </div>
            );
        }
        return (
          <pre {...pre} tabIndex={0}>
            {children}
          </pre>
        );
      },
      code: ({ node: _node, className, children, ...code }) => {
        if (className?.split(' ').includes('language-math'))
          return (
            <Formula
              label={t.formula}
              source={String(children)}
              display={className.includes('math-display')}
            />
          );
        return (
          <code {...code} className={className}>
            {children}
          </code>
        );
      },
    }),
    [t],
  );
  return (
    <div className="study-markdown">
      <Markdown
        {...props}
        remarkPlugins={[remarkGfm, remarkMath, remarkLatexDelimiters, ...(remarkPlugins || [])]}
        components={{ ...shared, ...components }}
      />
    </div>
  );
}
