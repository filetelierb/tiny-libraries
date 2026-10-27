export type PdfZoom = 'width' | 'page' | number;
export function readPdfZoom(value: unknown): PdfZoom {
  return value === 'width' || value === 'page'
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? Math.max(25, Math.min(300, value))
      : 'width';
}
export const PDF_ZOOM_PRESETS = [25, 50, 75, 100, 125, 150, 200, 250, 300];
/** Moves to the neighbouring preset; fit modes step from 100%. */
export function steppedZoom(zoom: PdfZoom, direction: 1 | -1): number {
  const current = typeof zoom === 'number' ? zoom : 100;
  return direction > 0
    ? (PDF_ZOOM_PRESETS.find((value) => value > current) ?? PDF_ZOOM_PRESETS.at(-1)!)
    : (PDF_ZOOM_PRESETS.findLast((value) => value < current) ?? PDF_ZOOM_PRESETS[0]);
}
export const boundedPage = (value: number, total: number) =>
  Math.min(Math.max(1, total), Math.max(1, Math.round(Number.isFinite(value) ? value : 1)));
export function pdfScale(
  zoom: PdfZoom,
  page: { width: number; height: number },
  available: { width: number; height: number },
) {
  if (typeof zoom === 'number') return zoom / 100;
  const width = Math.max(60, available.width - 36) / page.width;
  return zoom === 'width'
    ? width
    : Math.min(width, Math.max(60, available.height - 32) / page.height);
}
