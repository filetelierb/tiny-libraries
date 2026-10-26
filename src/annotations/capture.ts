import type { Source } from '../../shared/domain';
import type { SourceLocation } from '../../shared/annotations';
import type { CaptureImage } from './AnnotationEditor';

export async function captureSource(
  source: Source,
  location: SourceLocation,
): Promise<CaptureImage | undefined> {
  const pane = [...document.querySelectorAll<HTMLElement>('[data-source-id]')].find(
    (node) => node.dataset.sourceId === source.id,
  );
  if (!pane) return;
  let image: CanvasImageSource | null = null,
    width = 0,
    height = 0;
  if (source.kind === 'pdf') {
    const canvas = pane.querySelector<HTMLCanvasElement>(
      `[data-pdf-page="${location.page || 1}"] > canvas`,
    );
    if (
      canvas &&
      canvas.parentElement?.dataset.renderReady === 'true' &&
      canvas.width > 0 &&
      canvas.height > 0
    ) {
      image = canvas;
      width = canvas.width;
      height = canvas.height;
    }
  } else if (source.kind === 'video') {
    const video = pane.querySelector('video');
    if (video && video.readyState >= 2) {
      video.pause();
      image = video;
      width = video.videoWidth;
      height = video.videoHeight;
    }
  } else if (source.kind === 'image') {
    const original = pane.querySelector('img');
    if (original?.complete && original.naturalWidth) {
      image = original;
      width = original.naturalWidth;
      height = original.naturalHeight;
    }
  }
  if (!image || !width || !height) return;
  const ratio = Math.min(1, 1600 / Math.max(width, height)),
    canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Capture could not be created');
  return { blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
}
