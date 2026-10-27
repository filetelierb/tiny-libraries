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
export type DiagramImage = { url: string; width: number; height: number };
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
      return {
        url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`,
        width,
        height,
      };
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
