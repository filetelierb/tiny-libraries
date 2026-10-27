import type { T } from '../i18n';
import { formatCaptureTime } from '../../shared/capture-source';

export function stampLabel(
  stamp: { label: string; location: { page?: number; seconds?: number; quote?: string } },
  t: T,
) {
  const where =
    stamp.location.page !== undefined
      ? `${t.page} ${stamp.location.page}`
      : stamp.location.seconds !== undefined
        ? formatCaptureTime(stamp.location.seconds)
        : stamp.location.quote?.slice(0, 100) || '';
  return `${stamp.label} · ${where}`;
}
