type Node = {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  children?: Node[];
  data?: { hProperties?: Record<string, unknown> };
};
/** Keep source offsets on rendered blocks so chunk navigation survives Markdown formatting. */
export function remarkSourceAnchors() {
  return (root: unknown) => {
    const visit = (node: Node) => {
      const start = node.position?.start.offset,
        end = node.position?.end.offset;
      if (
        start != null &&
        end != null &&
        ['paragraph', 'heading', 'listItem', 'blockquote', 'table', 'code'].includes(node.type)
      ) {
        node.data ||= {};
        node.data.hProperties = {
          ...node.data.hProperties,
          'data-source-start': start,
          'data-source-end': end,
        };
      }
      node.children?.forEach(visit);
    };
    visit(root as Node);
  };
}
