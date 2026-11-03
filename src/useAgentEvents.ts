import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import type { AgentEvent } from '../shared/agent-events';

/**
 * The latest AI tool and Librarian steps as the app observes them, newest first. Polls while
 * the tab is active, faster when the panel is open; a few hundred are kept.
 */
export function useAgentEvents(open: boolean, limit = 200) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const latest = useRef<string | null>(null);
  useEffect(() => {
    let live = true,
      timer = 0;
    const poll = async () => {
      if (!live || document.hidden) {
        if (live) timer = window.setTimeout(() => void poll(), 2000);
        return;
      }
      try {
        const since = latest.current;
        const newer = await api<AgentEvent[]>(
          `/agent-events?limit=${limit}${since ? `&since=${encodeURIComponent(since)}` : ''}`,
        );
        if (!live) return;
        if (newer.length) {
          latest.current = newer[0].at;
          setEvents((current) => {
            const seen = new Set(current.map((event) => event.id));
            const merged = [...newer.filter((event) => !seen.has(event.id)), ...current];
            return merged.slice(0, limit);
          });
        }
      } catch {
        // Transient; the next tick retries. Nothing is shown to the user from here.
      }
      if (live) timer = window.setTimeout(() => void poll(), open ? 2500 : 15000);
    };
    void poll();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, limit]);
  return events;
}
