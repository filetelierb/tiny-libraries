import type { PublicLearning } from './domain';

export const playbackSpeeds = Array.from({ length: 16 }, (_, index) => (index + 1) / 4);
export const boundedTime = (value: number, duration: number) =>
  Math.max(
    0,
    Math.min(Number.isFinite(duration) ? duration : 0, Number.isFinite(value) ? value : 0),
  );
export const formatTime = (value: number) => {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    remainder = String(seconds % 60).padStart(2, '0');
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`;
};

export function chapterRanges(learning: PublicLearning | null, duration: number) {
  if (!learning || !Number.isFinite(duration) || duration <= 0) return [];
  return learning.synthesis.chapters
    .flatMap((chapter) => {
      const segments = learning.segments.filter(
        (segment) =>
          chapter.segmentIds.includes(segment.id) &&
          segment.start != null &&
          Number.isFinite(segment.start),
      );
      if (!segments.length) return [];
      const start = Math.min(...segments.map((segment) => segment.start!));
      const end = Math.max(...segments.map((segment) => segment.end ?? duration));
      if (start < 0 || start >= duration || end <= start) return [];
      return [{ id: chapter.id, title: chapter.title, start, end: Math.min(duration, end) }];
    })
    .sort((a, b) => a.start - b.start);
}

/** Preserve overlapping evidence ranges without hiding one chapter's control. */
export function chapterLanes(ranges: ReturnType<typeof chapterRanges>) {
  const ends: number[] = [];
  return ranges.map((range) => {
    let lane = ends.findIndex((end) => end <= range.start);
    if (lane < 0) lane = ends.length;
    ends[lane] = range.end;
    return { ...range, lane };
  });
}
