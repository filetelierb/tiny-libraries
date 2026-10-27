import type { Attempt, Kind, PublicLearning, PublicSynthesis, Segment } from './domain';

export type StudyChapter = PublicSynthesis['chapters'][number];
export type ChapterRange = {
  chapter: StudyChapter;
  ordinal: number;
  kind: 'time' | 'page' | 'text';
  start: number;
  end: number;
  segment: Segment;
};
export type ReadingProgress = {
  value: number;
  cause: 'read' | 'seek' | 'restore';
  playing?: boolean;
};

export function chapterLocations(learning: PublicLearning, kind: Kind): ChapterRange[] {
  const mode = kind === 'pdf' ? 'page' : kind === 'audio' || kind === 'video' ? 'time' : 'text';
  return learning.synthesis.chapters.flatMap((chapter, index) => {
    const segments = learning.segments.filter((s) => chapter.segmentIds.includes(s.id));
    if (!segments.length) return [];
    const eligible = segments.filter((s) =>
      mode === 'page' ? s.page != null : mode === 'time' ? s.start != null : true,
    );
    if (!eligible.length) return [];
    const values = eligible.map((s) =>
      mode === 'page' ? s.page! : mode === 'time' ? s.start! : learning.segments.indexOf(s),
    );
    const start = Math.min(...values),
      first = eligible[values.indexOf(start)];
    const end = Math.max(
      ...eligible.map((s, i) =>
        mode === 'page' ? s.page! : mode === 'time' ? (s.end ?? s.start!) : values[i],
      ),
    );
    if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
    return [{ chapter, ordinal: index + 1, kind: mode, start, end, segment: first }];
  });
}
export function currentChapter(ranges: ChapterRange[], position: number) {
  if (!Number.isFinite(position)) return null;
  return (
    ranges.find(
      (r, i) =>
        position >= r.start &&
        (r.kind === 'time'
          ? position < r.end || (i === ranges.length - 1 && position === r.end)
          : position <= r.end),
    ) || null
  );
}
export function chapterAttempts(
  attempts: Attempt[],
  learning: PublicLearning,
  chapter: StudyChapter,
) {
  return attempts.filter(
    (a) =>
      a.sourceId === learning.sourceId &&
      a.sourceVersion === learning.sourceVersion &&
      a.learningVersion === learning.createdAt &&
      chapter.questions.some((q) => q.id === a.questionId),
  );
}
export function completedChapter(
  attempts: Attempt[],
  learning: PublicLearning,
  chapter: StudyChapter,
) {
  if (!chapter.questions.length) return false;
  const runs = new Map<string, Set<string>>();
  for (const a of chapterAttempts(attempts, learning, chapter)) {
    const key = a.runId || 'earlier-attempts';
    if (!runs.has(key)) runs.set(key, new Set());
    runs.get(key)!.add(a.questionId);
  }
  return [...runs.values()].some((ids) => chapter.questions.every((q) => ids.has(q.id)));
}
export function chapterRuns(attempts: Attempt[], learning: PublicLearning, chapter: StudyChapter) {
  const groups = new Map<string, Map<string, Attempt>>();
  for (const attempt of chapterAttempts(attempts, learning, chapter)) {
    const id = attempt.runId || 'earlier-attempts';
    if (!groups.has(id)) groups.set(id, new Map());
    const old = groups.get(id)!.get(attempt.questionId);
    if (!old || old.createdAt < attempt.createdAt) groups.get(id)!.set(attempt.questionId, attempt);
  }
  return [...groups]
    .map(([id, values]) => ({
      id,
      attempts: [...values.values()],
      complete: chapter.questions.every((q) => values.has(q.id)),
      createdAt: [...values.values()]
        .map((a) => a.createdAt)
        .sort()
        .at(-1)!,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
/** Chapters whose end the reader just moved past while reading forward. */
export function crossedChapterEnds(
  ranges: ChapterRange[],
  previous: number,
  event: ReadingProgress,
) {
  if (
    event.cause !== 'read' ||
    !Number.isFinite(previous) ||
    !Number.isFinite(event.value) ||
    event.value <= previous
  )
    return [];
  return ranges.filter((range) =>
    range.kind === 'page'
      ? previous <= range.end && event.value > range.end
      : range.kind === 'time' && previous < range.end && event.value >= range.end,
  );
}
export function crossedChapter(
  ranges: ChapterRange[],
  previous: number,
  event: ReadingProgress,
  prompted: ReadonlySet<string>,
  completed: ReadonlySet<string>,
) {
  if (
    event.cause !== 'read' ||
    !Number.isFinite(previous) ||
    !Number.isFinite(event.value) ||
    event.value <= previous
  )
    return null;
  return (
    ranges.find(
      (range, index) =>
        index < ranges.length - 1 &&
        range.chapter.questions.length > 0 &&
        !prompted.has(range.chapter.id) &&
        !completed.has(range.chapter.id) &&
        (range.kind === 'page'
          ? previous <= range.end && event.value > range.end
          : range.kind === 'time' && previous < range.end && event.value >= range.end),
    ) || null
  );
}
