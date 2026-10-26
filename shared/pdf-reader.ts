export type PdfZoom = 'width' | 'page' | number;
export function readPdfZoom(value: unknown): PdfZoom {
  return value === 'width' || value === 'page'
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? Math.max(25, Math.min(300, value))
      : 'width';
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
