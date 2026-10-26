import { useEffect, useState } from 'react';
import type { AnnotationSummary } from '../../shared/annotations';
import { queryAnnotations } from '../annotations/api';

export function useBookmarks(
  sessionId: string | undefined,
  sourceIds: string[],
  tick: number,
  onError: (message: string) => void,
) {
  const [items, setItems] = useState<AnnotationSummary[]>([]);
  const resourceKey = [...new Set(sourceIds)].sort().join(',');
  useEffect(() => {
    setItems([]);
    if (!sessionId || !resourceKey) return;
    let cancelled = false,
      busy = false;
    const load = async () => {
      if (busy) return;
      busy = true;
      try {
        const values = await queryAnnotations(sessionId, resourceKey.split(','), false, 'bookmark');
        if (!cancelled) setItems(values);
      } catch (error) {
        if (!cancelled)
          onError(error instanceof Error ? error.message : 'Bookmarks could not be loaded');
      } finally {
        busy = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), 5000);
    window.addEventListener('focus', load);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [sessionId, resourceKey, tick]);
  return items;
}
