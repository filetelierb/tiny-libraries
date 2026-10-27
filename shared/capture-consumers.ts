import { wholeCapture, type CaptureDrawing } from './capture-drawing';

/** Comments travel separately from pixels. Omit pins outside the crop or under a privacy region. */
export function visibleCaptureComments(drawing: CaptureDrawing) {
  const crop = drawing.crop || wholeCapture;
  return drawing.objects
    .filter((item) => item.kind === 'comment')
    .filter((item) => {
      const rx = (item.size || 24) / 2 / drawing.space.width,
        ry = (item.size || 24) / 2 / drawing.space.height,
        pin = {
          left: item.point.x - rx,
          right: item.point.x + rx,
          top: item.point.y - ry,
          bottom: item.point.y + ry,
        };
      if (
        pin.left < crop.x ||
        pin.right > crop.x + crop.width ||
        pin.top < crop.y ||
        pin.bottom > crop.y + crop.height
      )
        return false;
      return !drawing.objects.some((region) => {
        if (region.kind !== 'redact' && region.kind !== 'mosaic') return false;
        const dx = region.shape === 'stroke' ? region.width / 2 / drawing.space.width : 0,
          dy = region.shape === 'stroke' ? region.width / 2 / drawing.space.height : 0,
          left = Math.min(...region.points.map((p) => p.x)) - dx,
          right = Math.max(...region.points.map((p) => p.x)) + dx,
          top = Math.min(...region.points.map((p) => p.y)) - dy,
          bottom = Math.max(...region.points.map((p) => p.y)) + dy;
        // Conservative bounding boxes also cover partially hidden pins and brush strokes.
        return pin.right >= left && pin.left <= right && pin.bottom >= top && pin.top <= bottom;
      });
    })
    .sort((a, b) => a.number - b.number)
    .map((item) => `${item.number}. ${item.text}`)
    .join('\n');
}
