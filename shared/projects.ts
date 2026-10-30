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
/** Interactions recorded on one local day, in total and per project. */
export type ActivityDay = { day: string; total: number; projects: Record<string, number> };

/** The local calendar day of a date, as YYYY-MM-DD. */
export function localDay(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Requests that count as an interaction: changes the student makes. Reads, polling, read-only
 * queries sent as POST, session position saves and app settings do not count.
 */
export function countsAsActivity(method: string, path: string) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return false;
  if (method === 'PUT' && /^\/api\/sessions\/[^/]+$/.test(path)) return false;
  return !/^\/api\/(annotations\/query|assessments\/options|settings|projects|activity|tutor-tools)(\/|$)/.test(
    path,
  );
}

/** Activity counts on a 0–4 scale, relative to the busiest day shown. */
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
