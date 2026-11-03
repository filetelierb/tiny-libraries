import { AGENT_EVENT_LIMIT, agentEventSchema, type AgentEvent } from '../shared/agent-events';
import { internal } from './index';
import type { ProjectId } from '../shared/projects';

/**
 * One ring buffer on the home library for the whole app. Each entry is keyed by its sortable
 * timestamp and a short random tail, so writes from different libraries land in time order.
 */
const KEY_PREFIX = 'agent-event:';
const key = (at: string) => `${KEY_PREFIX}${at}-${Math.random().toString(36).slice(2, 8)}`;

/** Called from the home library's own fetch to add an event. */
export async function appendEventOnHome(storage: DurableObjectStorage, event: AgentEvent) {
  await storage.put(key(event.at), event);
  // Prune cheaply: when the newest adds push beyond the limit, drop the oldest.
  const all = await storage.list<AgentEvent>({ prefix: KEY_PREFIX, limit: AGENT_EVENT_LIMIT + 50 });
  if (all.size > AGENT_EVENT_LIMIT) {
    const extra = [...all.keys()].slice(0, all.size - AGENT_EVENT_LIMIT);
    if (extra.length) await storage.delete(extra);
  }
}

/** Lists events newer than `since` (an ISO date), newest first, up to `limit`. */
export async function readEventsOnHome(
  storage: DurableObjectStorage,
  since: string | null,
  limit: number,
) {
  const entries = await storage.list<AgentEvent>({ prefix: KEY_PREFIX });
  const values = [...entries.values()].sort((a, b) => b.at.localeCompare(a.at));
  const filtered = since ? values.filter((event) => event.at > since) : values;
  return filtered.slice(0, limit);
}

/** Called from any library or the outer handler. Failures only log. */
export async function recordEvent(
  env: Env,
  project: ProjectId,
  input: Omit<AgentEvent, 'id' | 'at' | 'project'> & { at?: string; id?: string },
) {
  const event: AgentEvent = agentEventSchema.parse({
    ...input,
    id: input.id ?? crypto.randomUUID(),
    at: input.at ?? new Date().toISOString(),
    project,
  });
  try {
    await internal(env, '/internal/agent-events', event, 'default');
  } catch (error) {
    console.error('agent event push failed', (error as Error).message);
  }
}
