import type { Source, Directory } from '../shared/domain';
import type { PublishedCapture } from '../shared/captures';
import { sourceState } from '../shared/directories';
import type { GlossaryStorage } from './glossary';
import { CaptureError } from './capture-store';

export async function requireCaptureOriginContext(
  storage: Pick<GlossaryStorage, 'get' | 'list'>,
  capture: Pick<PublishedCapture, 'origin' | 'originSource' | 'stamp'>,
) {
  const origin = capture.originSource;
  if (!origin) return;
  const file = await storage.get<Source>(`file:${origin.id}`);
  if (!file || file.version !== origin.version)
    throw new CaptureError('The captured source changed. Choose its current version again.', 409);
  const directories = [...(await storage.list<Directory>({ prefix: 'directory:' })).values()];
  if (sourceState(file, directories) === 'trash')
    throw new CaptureError('Restore the captured source before using it.', 409);
  if (
    (capture.origin === 'pdf_page' && file.kind !== 'pdf') ||
    (capture.origin === 'video_frame' && file.kind !== 'video') ||
    (capture.origin === 'image' && file.kind !== 'image')
  )
    throw new CaptureError('Capture kind does not match its source');
  if (
    capture.stamp &&
    (capture.stamp.sourceId !== origin.id || capture.stamp.sourceVersion !== origin.version)
  )
    throw new CaptureError('Capture location belongs to another source');
}
