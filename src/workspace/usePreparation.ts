import { useEffect, useRef, useState } from 'react';
import type { Job, Locale } from '../../shared/domain';
import { api } from '../api';

type QueueItem = { sourceId: string; prepared: boolean; job: Job | null };
/** Preparation still under way or waiting, or stopped and needing the student. */
const unfinished = (job: Job) => ['queued', 'running', 'partial', 'failed'].includes(job.status);

/**
 * The files being prepared in the student's language, by file id, followed while the library
 * is open: often while any is under way, now and then otherwise, so preparation started
 * elsewhere (a course import, the queue) shows up. `finished` runs when one completes.
 */
export function usePreparation(locale: Locale, finished: () => void) {
  const [jobs, setJobs] = useState<Map<string, Job>>(new Map());
  const done = useRef(finished);
  done.current = finished;
  useEffect(() => {
    let live = true,
      timer = 0,
      previous: Set<string> | null = null;
    const load = async () => {
      let busy = false;
      try {
        const items = await api<QueueItem[]>(`/jobs?locale=${locale}`);
        if (!live) return;
        const next = new Map(
          items
            .filter((item): item is QueueItem & { job: Job } => !!item.job && unfinished(item.job))
            .map((item) => [item.sourceId, item.job]),
        );
        const completed = items.filter((item) => item.job?.status === 'completed');
        if (previous && completed.some((item) => previous!.has(item.sourceId))) done.current();
        previous = new Set(
          [...next].filter(([, job]) => job.status !== 'failed').map(([id]) => id),
        );
        busy = previous.size > 0;
        setJobs(next);
      } catch {
        // The queue is shown again on the next successful check.
      }
      if (live) timer = window.setTimeout(() => void load(), busy ? 4000 : 15000);
    };
    void load();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [locale]);
  return jobs;
}
