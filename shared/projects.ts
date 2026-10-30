import { z } from 'zod';

/**
 * A project is a library of its own, with its own files, sessions, notes, glossary and tests.
 * The first library predates projects and keeps the id `default`.
 */
export const projectIdSchema = z.union([z.literal('default'), z.string().uuid()]);
export type ProjectId = z.infer<typeof projectIdSchema>;
export const projectSchema = z.object({
  id: projectIdSchema,
  name: z.string().trim().min(1).max(120),
  createdAt: z.string(),
  lastActiveAt: z.string().nullable(),
});
export type Project = z.infer<typeof projectSchema>;
export const projectInputSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();
/** A project with what the home page shows on its card. */
export type ProjectSummary = Project & { files: number; sessions: number };

/** The Durable Object that holds a project's library; the first one keeps its original name. */
export const libraryObjectName = (project: ProjectId) =>
  project === 'default' ? 'local-user' : `project:${project}`;

export const activityDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The interactions the activity graph scores. Each counts once per day for the record it
 * concerns (a file, a deck, a quiz, a test question, a note); tutor questions count each time.
 * A mini quiz or a flashcard deck counts once all its questions or cards are done that day.
 */
export const activityKinds = ['progress', 'deck', 'quiz', 'test', 'note', 'tutor'] as const;
export type ActivityKind = (typeof activityKinds)[number];
export const activityWeights: Record<ActivityKind, number> = {
  progress: 1,
  deck: 2,
  quiz: 3,
  test: 2,
  note: 2,
  tutor: 2,
};
export const activityEventSchema = z.object({
  kind: z.enum(activityKinds),
  key: z.string().min(1).max(300),
  /** For a quiz or deck: the question or card done, and how many the whole has. */
  part: z.string().min(1).max(300).optional(),
  parts: z.number().int().min(1).max(500).optional(),
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;
/** A day's points, in total and per project, and how many interactions of each kind it had. */
export type ActivityDay = {
  day: string;
  total: number;
  projects: Record<string, number>;
  kinds?: Partial<Record<ActivityKind, number>>;
};
/** What the activity log stores for a day: the counted identities and each project's kinds. */
export type StoredActivityDay = ActivityDay & {
  seen?: string[];
  projectKinds?: Record<string, Partial<Record<ActivityKind, number>>>;
};

/** The local calendar day of a date, as YYYY-MM-DD. */
export function localDay(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Routes whose interaction is identified by a field of the request body. */
export const activityBodyRoute = (method: string, path: string) =>
  (method === 'POST' &&
    /^\/api\/(assessments\/[^/]+\/answers|glossary\/merge|conversations\/[^/]+\/messages)$/.test(
      path,
    )) ||
  (method === 'PATCH' && /^\/api\/files\/[^/]+$/.test(path));

/**
 * The scored interactions a successful request made, read from the route. Saved positions,
 * quiz answers and card reviews are reported by the library, which knows which files moved and
 * how many questions or cards make the whole.
 */
export function classifyActivity(method: string, path: string, body: unknown): ActivityEvent[] {
  const value = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>,
    field = (name: string) => (typeof value[name] === 'string' ? (value[name] as string) : '');
  let match: RegExpMatchArray | null;
  if (method === 'PATCH' && (match = path.match(/^\/api\/files\/([^/]+)$/)))
    return value.reviewed === undefined ? [] : [{ kind: 'progress', key: match[1] }];
  if (method === 'POST' && (match = path.match(/^\/api\/assessments\/([^/]+)\/answers$/)))
    return [{ kind: 'test', key: `${match[1]}:${field('questionId')}` }];
  if (
    (method === 'PUT' || method === 'POST') &&
    (match = path.match(/^\/api\/annotations\/([a-f0-9-]+)(\/capture|\/captures\/.*)?$/))
  )
    return [{ kind: 'note', key: `note:${match[1]}` }];
  if (method === 'PUT' && (match = path.match(/^\/api\/glossary\/([a-f0-9-]+)$/)))
    return [{ kind: 'note', key: `concept:${match[1]}` }];
  if (method === 'POST' && (match = path.match(/^\/api\/glossary\/([a-f0-9-]+)\/proposals$/)))
    return [{ kind: 'note', key: `concept:${match[1]}` }];
  if (method === 'POST' && path === '/api/glossary/merge')
    return [{ kind: 'note', key: `concept:${field('targetId')}` }];
  if (method === 'POST' && /^\/api\/conversations\/[^/]+\/messages$/.test(path))
    return [{ kind: 'tutor', key: field('requestId') || crypto.randomUUID() }];
  if (method === 'POST' && (match = path.match(/^\/api\/tutor-actions\/([^/]+)$/)))
    return [{ kind: 'tutor', key: `action:${match[1]}` }];
  if (method === 'POST' && /^\/api\/tutor-artifacts\/[^/]+\/retry$/.test(path))
    return [{ kind: 'tutor', key: crypto.randomUUID() }];
  return [];
}

/**
 * Adds a request's interactions to its day. An interaction already counted that day for the
 * same record adds nothing; `seen` keeps those identities. A quiz or deck also keeps the
 * questions or cards done that day, and counts when the last one arrives.
 */
export function scoreActivity(
  current: StoredActivityDay,
  project: ProjectId,
  events: ActivityEvent[],
) {
  const seen = new Set(current.seen || []),
    own = { ...current.projectKinds?.[project] },
    next = {
      ...current,
      projects: { ...current.projects },
      kinds: { ...current.kinds },
      projectKinds: { ...current.projectKinds, [project]: own },
    };
  for (const event of events) {
    const identity = `${project}:${event.kind}:${event.key}`;
    if (seen.has(identity)) continue;
    if (event.part && event.parts) {
      seen.add(`${identity}#${event.part}`);
      const done = [...seen].filter((value) => value.startsWith(`${identity}#`)).length;
      if (done < event.parts) continue;
    }
    seen.add(identity);
    const weight = activityWeights[event.kind];
    next.total += weight;
    next.projects[project] = (next.projects[project] || 0) + weight;
    next.kinds[event.kind] = (next.kinds[event.kind] || 0) + 1;
    own[event.kind] = (own[event.kind] || 0) + 1;
  }
  return { ...next, seen: [...seen] };
}

/** A day without a deleted project's points; null when nothing else was logged that day. */
export function withoutProject(day: StoredActivityDay, project: ProjectId) {
  if (day.projects[project] === undefined) return day;
  const { [project]: points, ...projects } = day.projects,
    { [project]: removed, ...projectKinds } = day.projectKinds || {},
    kinds = { ...day.kinds };
  for (const kind of activityKinds) {
    kinds[kind] = (kinds[kind] || 0) - (removed?.[kind] || 0);
    if (!kinds[kind] || kinds[kind]! <= 0) delete kinds[kind];
  }
  const total = day.total - points;
  if (total <= 0 || !Object.keys(projects).length) return null;
  return {
    ...day,
    total,
    projects,
    kinds,
    projectKinds,
    seen: (day.seen || []).filter((identity) => !identity.startsWith(`${project}:`)),
  };
}

/** Activity points on a 0–4 scale, relative to the busiest day shown. */
export function activityLevel(count: number, max: number) {
  if (!count || !max) return 0;
  return Math.min(4, Math.ceil((count / max) * 4));
}

/** Weeks shown in the activity graph: a year, ending with this week. */
export const WEEKS = 53;

/** The first day shown: 52 weeks before this week's first day, so the grid ends with today. */
export function heatmapStart(today: Date, weekStart: number) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  start.setDate(start.getDate() - ((start.getDay() - weekStart + 7) % 7) - (WEEKS - 1) * 7);
  return start;
}

/** Days in a row with activity: the run ending today (or yesterday) and the longest one. */
export function activityStreaks(days: string[], counts: Map<string, number>) {
  let longest = 0,
    run = 0;
  for (const day of days) {
    run = counts.get(day) ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    if (counts.get(days[i])) current++;
    else if (i === days.length - 1) continue;
    else break;
  }
  return { current, longest };
}
