import { Fragment, type ReactNode } from 'react';
import type { RichNode } from '../../shared/annotations';

export function RichContent({ document }: { document: RichNode }) {
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
        return (
          <pre key={key}>
            <code>{children}</code>
          </pre>
        );
      case 'hardBreak':
        return <br key={key} />;
      case 'horizontalRule':
        return <hr key={key} />;
      case 'table':
        return (
          <div className="rich-table-scroll" key={key}>
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
