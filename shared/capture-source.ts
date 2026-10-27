import type { Source } from './domain';
import type { SourceLocation } from './locations';
import { sourceStampSchema, type SourceStamp } from './captures';

export function captureContentUrl(source: Pick<Source, 'id' | 'version'>) {
  return `/api/files/${encodeURIComponent(source.id)}/content?version=${source.version}`;
}
export function captureTime(value: number, duration: number, frame = false) {
  if (!Number.isFinite(value) || !Number.isFinite(duration) || duration <= 0)
    throw new Error('A finite recording duration is required');
  const max =
    Math.floor(Math.min(86400, Math.max(0, duration - (frame ? 0.001 : 0))) * 1000) / 1000;
  return Math.min(max, Math.max(0, Math.round(value * 1000) / 1000));
}
export function sourceLocationStamp(
  source: Pick<Source, 'id' | 'version' | 'name'>,
  location: SourceLocation,
): SourceStamp {
  return sourceStampSchema.parse({
    id: crypto.randomUUID(),
    sourceId: source.id,
    sourceVersion: source.version,
    label: source.name,
    location,
  });
}

export function formatCaptureTime(seconds: number) {
  const total = Math.max(0, Math.round(seconds * 1000)),
    whole = Math.floor(total / 1000),
    fraction = total % 1000;
  const hours = Math.floor(whole / 3600),
    minutes = Math.floor((whole % 3600) / 60),
    rest = String(whole % 60).padStart(2, '0');
  return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${rest}${fraction ? '.' + String(fraction).padStart(3, '0') : ''}`;
}
