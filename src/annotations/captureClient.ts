import { api, ApiResponseError } from '../api';
import {
  captureRecordSchema,
  publishedCaptureSchema,
  captureDrawingDigest,
  type CaptureRecord,
  type PublishedCapture,
} from '../../shared/captures';
import {
  captureDrawingSchema,
  emptyCaptureDrawing,
  type CaptureDrawing,
} from '../../shared/capture-drawing';
import { editorDrafts, imageDraftKey, visualDraftKey, type CaptureEntry } from './draftStore';

export const capturePath = (owner: string, id: string) => `/annotations/${owner}/captures/${id}`;
export const capturePreviewUrl = (
  owner: string,
  item: Pick<PublishedCapture, 'id' | 'drawingDigest'>,
) => `/api${capturePath(owner, item.id)}/previews/${item.drawingDigest}`;
export const captureBaseUrl = (owner: string, id: string) => `/api${capturePath(owner, id)}/base`;
async function uploadBase(path: string, blob: Blob): Promise<CaptureRecord> {
  const response = await fetch(`/api${path}/base`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png' },
    body: blob,
  });
  const body = await response.json();
  if (!response.ok)
    throw new ApiResponseError(body.error || 'Capture upload failed', response.status);
  return captureRecordSchema.parse(body);
}
export async function stageCapture(entry: CaptureEntry) {
  const owner = entry.descriptor.annotationId,
    path = capturePath(owner, entry.descriptor.id);
  let record = captureRecordSchema.parse(await api(path, 'POST', entry.descriptor));
  if (!record.base) {
    const blob = await editorDrafts.get<Blob>('images', imageDraftKey(owner, entry.descriptor.id));
    if (!blob) throw new Error('The original image is unavailable in this draft. Choose it again.');
    record = await uploadBase(path, blob);
  }
  if (!record.base) throw new Error('Capture upload was not confirmed');
  if (entry.baseDigest && entry.baseDigest !== record.base.digest)
    throw new Error('The saved capture has a different base image. Create another capture.');
  let drawing: CaptureDrawing;
  if (entry.localDrawingDigest) {
    const raw = await editorDrafts.get(
      'drawings',
      visualDraftKey(owner, entry.descriptor.id, entry.localDrawingDigest),
    );
    if (!raw)
      throw new Error('The drawing draft is unavailable. Reopen the capture before saving.');
    drawing = captureDrawingSchema.parse(raw);
  } else if (entry.version) {
    return { ...entry.version, label: entry.label };
  } else drawing = emptyCaptureDrawing(record.base.space);
  const digest = await captureDrawingDigest(drawing),
    version = publishedCaptureSchema.parse(await api(`${path}/drawings/${digest}`, 'PUT', drawing));
  return { ...version, label: entry.label };
}
export async function getCaptureDrawing(owner: string, entry: CaptureEntry) {
  if (entry.localDrawingDigest) {
    const raw = await editorDrafts.get(
      'drawings',
      visualDraftKey(owner, entry.descriptor.id, entry.localDrawingDigest),
    );
    if (raw) return captureDrawingSchema.parse(raw);
  }
  if (!entry.version) throw new Error('Finish uploading this capture before editing');
  return captureDrawingSchema.parse(
    await api(`${capturePath(owner, entry.descriptor.id)}/drawings/${entry.version.drawingDigest}`),
  );
}
export async function stageCaptureDrawing(entry: CaptureEntry, drawing: CaptureDrawing) {
  const digest = await captureDrawingDigest(drawing),
    owner = entry.descriptor.annotationId;
  await editorDrafts.commit([
    { table: 'drawings', key: visualDraftKey(owner, entry.descriptor.id, digest), value: drawing },
  ]);
  return stageCapture({ ...entry, localDrawingDigest: digest });
}
