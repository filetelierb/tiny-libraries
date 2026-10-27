import type { MermaidConfig } from 'mermaid';

export const MAX_DIAGRAM_LENGTH = 20000;
export function diagramSourceAllowed(source: string) {
  return (
    source.trim().length > 0 &&
    source.length <= MAX_DIAGRAM_LENGTH &&
    !/^\s*---/.test(source) &&
    !/%%\s*\{|(?:https?|data|javascript|file):|\/\/|\burl\s*\(|@import|@\{[^}]*\b(?:img|icon)\s*:/i.test(
      source,
    )
  );
}
export const diagramConfig: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  htmlLabels: false,
  maxTextSize: MAX_DIAGRAM_LENGTH,
  maxEdges: 300,
  fontFamily: 'Arial, sans-serif',
  theme: 'neutral',
  layout: 'dagre',
  secure: [
    'secure',
    'securityLevel',
    'startOnLoad',
    'suppressErrorRendering',
    'htmlLabels',
    'maxTextSize',
    'maxEdges',
    'fontFamily',
    'theme',
    'themeCSS',
    'themeVariables',
    'layout',
  ],
};
/** A flowchart node and where it sits on the image, in percent of its width and height. */
export type DiagramNode = {
  id: string;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
};
export type DiagramLink = { id: string; from: string; to: string; label: string };
export type DiagramFlow = { nodes: DiagramNode[]; links: DiagramLink[] };
export type DiagramImage = { url: string; width: number; height: number; flow?: DiagramFlow };
type Mermaid = (typeof import('mermaid'))['default'];
type FlowDb = {
  getVertices(): Map<string, { id: string; text?: string }>;
  getEdges(): Array<{ start: string; end: string; text?: string }>;
};
const plainLabel = (value: string) =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Flowcharts also report their nodes and links, so the image can be explored: nodes are
 * located by measuring the sanitized drawing off-screen, never by running it in the page.
 */
async function flowOf(
  mermaid: Mermaid,
  source: string,
  root: Element,
  host: HTMLElement,
  [x, y, width, height]: number[],
): Promise<DiagramFlow | undefined> {
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(source).catch(() => null);
  if (!diagram || !/^flowchart/.test(diagram.type)) return undefined;
  const db = diagram.db as unknown as FlowDb;
  const svg = document.importNode(root, true) as SVGSVGElement;
  host.replaceChildren(svg);
  const groups = [...svg.querySelectorAll<SVGGraphicsElement>('g.node')];
  const space = svg.getScreenCTM()?.inverse();
  const nodes: DiagramNode[] = [];
  for (const vertex of db.getVertices().values()) {
    const element = groups.find(
      (group) =>
        group.dataset.id === vertex.id ||
        group.id.endsWith(`-flowchart-${vertex.id}-${group.id.split('-').at(-1)}`),
    );
    const screen = element?.getScreenCTM();
    if (!element || !screen || !space) continue;
    const box = element.getBBox(),
      matrix = space.multiply(screen),
      from = new DOMPoint(box.x, box.y).matrixTransform(matrix),
      to = new DOMPoint(box.x + box.width, box.y + box.height).matrixTransform(matrix);
    nodes.push({
      id: vertex.id,
      label: plainLabel(vertex.text || vertex.id) || vertex.id,
      left: ((from.x - x) / width) * 100,
      top: ((from.y - y) / height) * 100,
      width: ((to.x - from.x) / width) * 100,
      height: ((to.y - from.y) / height) * 100,
    });
  }
  if (nodes.length < 2) return undefined;
  const known = new Set(nodes.map((node) => node.id));
  const links = db
    .getEdges()
    .filter((edge) => known.has(edge.start) && known.has(edge.end))
    .map((edge, index) => ({
      id: `link-${index}`,
      from: edge.start,
      to: edge.end,
      label: plainLabel(edge.text || ''),
    }));
  return { nodes, links };
}
let engine: Promise<(typeof import('mermaid'))['default']> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let sequence = 0;
const cache = new Map<string, Promise<DiagramImage>>();

export function renderDiagram(source: string): Promise<DiagramImage> {
  if (!diagramSourceAllowed(source)) return Promise.reject(new Error('Source-only diagram'));
  const existing = cache.get(source);
  if (existing) return existing;
  const result = queue.then(async () => {
    engine ||= import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize(diagramConfig);
      return mermaid;
    });
    const mermaid = await engine;
    const host = document.createElement('div');
    host.className = 'diagram-render-host';
    host.setAttribute('aria-hidden', 'true');
    document.body.append(host);
    try {
      const { svg } = await mermaid.render(`study-diagram-${++sequence}`, source, host);
      const documentSvg = new DOMParser().parseFromString(svg, 'image/svg+xml');
      const root = documentSvg.documentElement;
      if (root.tagName !== 'svg' || documentSvg.querySelector('parsererror'))
        throw new Error('Invalid diagram');
      // Images never execute diagram scripts or click callbacks. Remove external resources as well.
      root.querySelectorAll('script,foreignObject,image').forEach((node) => node.remove());
      [root, ...root.querySelectorAll('*')].forEach((node) => {
        for (const attribute of [...node.attributes]) {
          if (
            /^on/i.test(attribute.name) ||
            (/href$/i.test(attribute.name) && !attribute.value.startsWith('#'))
          )
            node.removeAttribute(attribute.name);
        }
      });
      const box = root
        .getAttribute('viewBox')
        ?.split(/[\s,]+/)
        .map(Number);
      const width = box?.[2] && Number.isFinite(box[2]) ? box[2] : 800;
      const height = box?.[3] && Number.isFinite(box[3]) ? box[3] : 600;
      root.setAttribute('width', String(width));
      root.setAttribute('height', String(height));
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`;
      const origin =
        box && box.length === 4 && box.every(Number.isFinite) ? box : [0, 0, width, height];
      const flow = await flowOf(mermaid, source, root, host, origin).catch(() => undefined);
      return { url, width, height, ...(flow ? { flow } : {}) };
    } finally {
      host.remove();
    }
  });
  queue = result.catch(() => undefined);
  cache.set(source, result);
  if (cache.size > 32) cache.delete(cache.keys().next().value!);
  void result.catch(() => cache.delete(source));
  return result;
}
