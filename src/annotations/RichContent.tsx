import { Fragment, type ReactNode } from 'react';
import type { RichNode } from '../../shared/annotations';
import type { T } from '../i18n';
import { Formula } from '../study/Formula';
import { Diagram } from '../study/Diagram';

export function RichContent({ document, t }: { document: RichNode; t: T }) {
  const render = (node: RichNode, key: number): ReactNode => {
    let children: ReactNode = node.type === 'text' ? node.text : node.content?.map(render);
    for (const mark of node.marks || []) {
      if (mark.type === 'bold') children = <strong>{children}</strong>;
      if (mark.type === 'italic') children = <em>{children}</em>;
      if (mark.type === 'underline') children = <u>{children}</u>;
      if (mark.type === 'strike') children = <s>{children}</s>;
      if (mark.type === 'code') children = <code>{children}</code>;
      if (mark.type === 'link')
        children = (
          <a href={mark.attrs?.href} target="_blank" rel="noreferrer">
            {children}
          </a>
        );
    }
    switch (node.type) {
      case 'inlineMath':
        return <Formula label={t.formula} key={key} source={node.attrs?.latex || ''} />;
      case 'blockMath':
        return <Formula label={t.formula} key={key} source={node.attrs?.latex || ''} display />;
      case 'doc':
      case 'text':
        return <Fragment key={key}>{children}</Fragment>;
      case 'paragraph':
        return <p key={key}>{children || <br />}</p>;
      case 'heading':
        return node.attrs?.level === 1 ? (
          <h2 key={key}>{children}</h2>
        ) : node.attrs?.level === 2 ? (
          <h3 key={key}>{children}</h3>
        ) : (
          <h4 key={key}>{children}</h4>
        );
      case 'bulletList':
        return <ul key={key}>{children}</ul>;
      case 'orderedList':
        return (
          <ol key={key} start={node.attrs?.start}>
            {children}
          </ol>
        );
      case 'listItem':
        return <li key={key}>{children}</li>;
      case 'blockquote':
        return <blockquote key={key}>{children}</blockquote>;
      case 'codeBlock':
        if (node.attrs?.language === 'mermaid')
          return (
            <Diagram
              key={key}
              source={node.content?.map((part) => part.text || '').join('') || ''}
              t={t}
            />
          );
        if (node.attrs?.language === 'math')
          return (
            <Formula
              label={t.formula}
              key={key}
              source={node.content?.map((part) => part.text || '').join('') || ''}
              display
            />
          );
        return (
          <pre key={key} tabIndex={0}>
            <code>{children}</code>
          </pre>
        );
      case 'hardBreak':
        return <br key={key} />;
      case 'horizontalRule':
        return <hr key={key} />;
      case 'table':
        return (
          <div
            className="rich-table-scroll study-table-scroll"
            key={key}
            tabIndex={0}
            role="region"
            aria-label={t.studyTable}
          >
            <table>
              <tbody>{children}</tbody>
            </table>
          </div>
        );
      case 'tableRow':
        return <tr key={key}>{children}</tr>;
      case 'tableCell':
        return (
          <td key={key} colSpan={node.attrs?.colspan} rowSpan={node.attrs?.rowspan}>
            {children}
          </td>
        );
      case 'tableHeader':
        return (
          <th key={key} colSpan={node.attrs?.colspan} rowSpan={node.attrs?.rowspan}>
            {children}
          </th>
        );
      default:
        return null;
    }
  };
  return <div className="rich-content">{render(document, 0)}</div>;
}
