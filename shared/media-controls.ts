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

/**
 * Each chapter is a start marker on the recording's timeline; its end is where the next
 * chapter begins, or the end of the video for the last one. The first chapter always starts
 * at 0, so the whole recording is covered by one continuous bar.
 */
export function chapterRanges(learning: PublicLearning | null, duration: number) {
  if (!learning || !Number.isFinite(duration) || duration <= 0) return [];
  const starts = learning.synthesis.chapters
    .map((chapter) => {
      const segments = learning.segments.filter(
        (segment) =>
          chapter.segmentIds.includes(segment.id) &&
          segment.start != null &&
          Number.isFinite(segment.start),
      );
      if (!segments.length) return null;
      return {
        id: chapter.id,
        title: chapter.title,
        start: Math.max(0, Math.min(duration, Math.min(...segments.map((s) => s.start!)))),
      };
    })
    .filter((chapter): chapter is { id: string; title: string; start: number } => !!chapter)
    .sort((a, b) => a.start - b.start);
  if (!starts.length) return [];
  // The first chapter always starts at 0, and later chapters that share a start are kept apart.
  starts[0] = { ...starts[0], start: 0 };
  for (let i = 1; i < starts.length; i++)
    if (starts[i].start <= starts[i - 1].start)
      starts[i] = { ...starts[i], start: Math.min(duration, starts[i - 1].start + 0.001) };
  return starts
    .map((chapter, index) => ({
      ...chapter,
      end: index + 1 < starts.length ? starts[index + 1].start : duration,
    }))
    .filter((chapter) => chapter.start < chapter.end);
}

/** The whole bar is one continuous row; every range lives on lane 0. */
export function chapterLanes(ranges: ReturnType<typeof chapterRanges>) {
  return ranges.map((range) => ({ ...range, lane: 0 }));
}
