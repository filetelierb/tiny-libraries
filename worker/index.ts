import { readAssessmentImages } from './assessment-vision';
import { assessmentHTML, assessmentExportPolicy } from './assessment-export';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import {
  MAX_FILE_BYTES,
  kindFor,
  localeSchema,
  sessionSchema,
  sourceSchema,
  segmentSchema,
  publicLearning,
  reviewSummary,
  fold,
  type Source,
  type Directory,
  type Catalog,
  type Settings,
  type StudySession,
  type Learning,
  type Attempt,
  type Job,
} from '../shared/domain';
export { ProcessingJob } from './jobs';
export { TutorConversation } from './tutor-conversation';
import {
  runAssistant,
  bridgedFetch,
  gradeShortAnswer,
  generateCards,
  generateArtifactStudy,
  generateReinforcement,
  generateAssessmentBatch,
  analyzeAssessment,
  planTutorArtifact,
  writeTutorArtifactChapter,
  MetaError,
} from './meta';
import {
  resumeTutorArtifact,
  startTutorArtifact,
  TutorArtifactError,
  type TutorArtifactServices,
} from './tutor-artifacts';
import { tutorArtifactDocumentSchema, tutorArtifactRequestSchema } from '../shared/tutor-artifacts';
import {
  decideTutorAction,
  readLibrary,
  requestTutorAction,
  tutorActionStatus,
  TutorActionError,
  type LibraryCall,
} from './tutor-actions';
import { tutorActionSchema } from '../shared/tutor-actions';
import { cardSnapshot, deckSize, startCardDecks, rateCard, CardError } from './flashcards';
import { visualKey } from '../shared/artifact-widgets';
import { artifactStudySnapshot, deleteArtifactStudy, startArtifactStudy } from './artifact-study';
import {
  ArtifactRevisionError,
  deleteRevisions,
  getRevision,
  latestArtifact,
  listRevisions,
  recordGenerated,
  saveEdit,
  saveTutorVersion,
} from './artifact-revisions';
import { reinforcementSnapshot, startReinforcement, ReinforcementError } from './reinforcements';
import type { Reinforcement } from '../shared/review';
import {
  createAssessment,
  assessmentDetail,
  assessmentSummary,
  assessmentHistory,
  assessmentAction,
  saveAssessmentAnswer,
  AssessmentError,
} from './assessments';
import { assessmentOptions, captureStudyProgress } from './assessment-context';
import { assessmentMarkdown } from '../shared/assessments';
import {
  conversationRoute,
  conversationSnapshot,
  conversationDetail,
  assessmentConversations,
} from './conversations';
import { TutorJournalError } from './tutor-journal';
import { attachmentRoute } from './attachment-route';
import { AttachmentError } from './tutor-attachments';
import { captureRoute } from './capture-route';
import { CaptureError } from './capture-store';
import { quizOf, recordAttempt, PracticeError } from './practice';
import {
  annotationRoute,
  AnnotationError,
  ensureSharedAnnotations,
  createSuggestedBookmark,
} from './annotations';
import {
  glossaryRoute,
  glossarySnapshot,
  GlossaryError,
  deleteConcepts,
  ingestLearning,
  saveTutorConcept,
  searchConcepts,
  conceptIndex,
  conceptContexts,
} from './glossary';
import {
  conceptLinkSchema,
  conceptSourceSchema,
  conceptsOnlyIn,
  type GlossaryEntry,
} from '../shared/glossary';
import {
  changeDirectory,
  ensureDirectories,
  normalizePath,
  assertWritableDirectory,
  directoryState,
  DirectoryError,
  purgeTargets,
  sourceState,
} from '../shared/directories';
import {
  activityDaySchema,
  activityBodyRoute,
  activityEventSchema,
  classifyActivity,
  scoreActivity,
  type ActivityEvent,
  libraryObjectName,
  projectIdSchema,
  projectInputSchema,
  withoutProject,
  type StoredActivityDay,
  type Project,
  type ProjectId,
  type ProjectSummary,
} from '../shared/projects';

/** Stored bytes of permanently deleted files go after their records. */
/** Removes every stored object under a prefix, a page at a time. */
async function purgePrefix(env: Env, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix, cursor });
    if (page.objects.length) await env.FILES.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}
async function purgeStoredFiles(env: Env, files: Array<{ id: string; version: number }>) {
  for (const file of files) {
    const keys = Array.from(
      { length: file.version },
      (_, index) => `original/${file.id}/${index + 1}`,
    );
    const captions = await env.FILES.list({ prefix: `captions/${file.id}/` }),
      visuals = await env.FILES.list({ prefix: `visuals/${file.id}/` });
    await env.FILES.delete([
      ...keys,
      ...[...captions.objects, ...visuals.objects].map((object) => object.key),
    ]);
  }
}
/** A response that reports scored interactions the router cannot see in the request. */
const withActivity = (value: unknown, status: number, events: ActivityEvent[]) =>
  Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...(events.length ? { 'X-Activity': encodeURIComponent(JSON.stringify(events)) } : {}),
    },
  });
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function library(env: Env, project: ProjectId = 'default') {
  return env.LIBRARY.getByName(libraryObjectName(project));
}
export async function internal<T>(
  env: Env,
  path: string,
  body?: unknown,
  project: ProjectId = 'default',
): Promise<T> {
  const response = await library(env, project).fetch(
    new Request(`http://internal${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined
        ? {}
        : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    }),
  );
  if (!response.ok) throw new ApiError('Library operation failed', response.status);
  return response.json<T>();
}
/** Queues a file's preparation in one language; an existing job is returned unchanged. */
function startJob(
  env: Env,
  file: Source,
  locale: z.infer<typeof localeSchema>,
  project: ProjectId,
) {
  const id = `${file.id}-v${file.version}-${locale}`;
  return env.JOBS.get(env.JOBS.idFromName(id)).fetch(
    new Request('http://internal/start', {
      method: 'POST',
      body: JSON.stringify({ id, file, locale, project }),
    }),
  );
}
/** The project a request works in: the app's header, then the cookie that media links carry. */
function requestProject(request: Request, url: URL): ProjectId {
  const cookie = request.headers.get('Cookie')?.match(/(?:^|;\s*)tl-project=([^;]+)/)?.[1];
  const value = request.headers.get('X-Project') || url.searchParams.get('project') || cookie;
  const parsed = projectIdSchema.safeParse(value || 'default');
  if (!parsed.success) throw new ApiError('Unknown project', 400);
  return parsed.data;
}
const knownProjects = new Set<ProjectId>(['default']);
async function existingProject(env: Env, project: ProjectId) {
  if (knownProjects.has(project)) return project;
  const { exists } = await internal<{ exists: boolean }>(env, `/internal/projects/${project}`);
  if (!exists) throw new ApiError('Project not found', 404);
  knownProjects.add(project);
  return project;
}
/** Routes that belong to the app as a whole rather than to one project's library. */
const appRoute = (path: string) => /^\/api\/(settings|projects|activity)(\/|$)/.test(path);
async function boundedJson(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new ApiError('Request exceeds 2 MB', 413);
    }
    chunks.push(value);
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    data.set(c, offset);
    offset += c.length;
  }
  return JSON.parse(new TextDecoder().decode(data));
}
export class Library extends DurableObject<Env> {
  readonly executionId = crypto.randomUUID();
  async directorySnapshot(storage: Pick<DurableObjectStorage, 'list' | 'put'> = this.ctx.storage) {
    const [fileEntries, directoryEntries] = await Promise.all([
      storage.list<Source>({ prefix: 'file:' }),
      storage.list<Directory>({ prefix: 'directory:' }),
    ]);
    const files = [...fileEntries.values()].map((file) => ({
        ...file,
        folder: normalizePath(file.folder),
      })),
      existing = [...directoryEntries.values()];
    for (const file of files)
      if (fileEntries.get(`file:${file.id}`)?.folder !== file.folder)
        await storage.put(`file:${file.id}`, file);
    const directories = ensureDirectories(
      existing,
      files.map((file) => file.folder),
    );
    const known = new Set(existing.map((directory) => directory.id));
    for (const directory of directories)
      if (!known.has(directory.id)) await storage.put(`directory:${directory.id}`, directory);
    return { files, directories };
  }
  /** Model calls, previous versions and saving for the tutor's artifact generations. */
  private artifactServices(): TutorArtifactServices {
    const key = async () => {
      const value = await this.apiKey();
      if (!value) throw new TutorArtifactError('Add a Meta API key in Settings', 409);
      return value;
    };
    const previous = async (fileId: string) => {
      const file = await this.ctx.storage.get<Source>(`file:${fileId}`);
      const object = file && (await this.env.FILES.get(`original/${file.id}/${file.version}`));
      return object ? tutorArtifactDocumentSchema.parse(await object.json()) : null;
    };
    return {
      owner: this.executionId,
      start: (task) => this.ctx.waitUntil(task),
      plan: async (job, materials, previousMarkdown) =>
        planTutorArtifact(
          await key(),
          job.model,
          job.locale,
          job.request,
          materials,
          previousMarkdown,
          bridgedFetch(this.env),
        ),
      chapter: async (job, plan, index, materials, repair) =>
        writeTutorArtifactChapter(
          await key(),
          job.model,
          job.locale,
          job.request,
          plan,
          index,
          materials,
          repair,
          bridgedFetch(this.env),
        ),
      previous,
      save: async (job, document) => {
        const body = JSON.stringify(document);
        return this.ctx.storage.transaction(async (storage) => {
          const snapshot = await this.directorySnapshot(storage);
          const existing = snapshot.files.find((file) => file.id === job.fileId);
          // A new artifact whose save was interrupted after writing keeps that first version.
          if (existing && !job.request.artifactId) return existing.version;
          const folder = existing?.folder ?? (job.locale === 'es' ? 'Artefactos' : 'Artifacts');
          if (!existing) {
            assertWritableDirectory(folder, snapshot.directories);
            for (const entry of ensureDirectories(snapshot.directories, [folder]))
              await storage.put(`directory:${entry.id}`, entry);
          }
          const name = `${document.title
            .replace(/[\\/:*?"<>|]+/g, ' ')
            .trim()
            .slice(0, 200)}.artifact`;
          const file: Source = existing
            ? { ...existing, version: existing.version + 1, size: body.length }
            : {
                id: job.fileId,
                version: 1,
                name,
                folder,
                kind: 'artifact',
                mime: 'application/json',
                size: body.length,
                archived: false,
                reviewed: false,
                createdAt: new Date().toISOString(),
              };
          await this.env.FILES.put(`original/${file.id}/${file.version}`, body, {
            httpMetadata: { contentType: 'application/json' },
          });
          await storage.put(`file:${file.id}`, file);
          return file.version;
        });
      },
    };
  }
  /** The library's own routes, for actions the tutor takes as the student would in the app. */
  private libraryCall(): LibraryCall {
    return async (method, path, body) => {
      const response = await this.fetch(
        new Request(`http://internal${path}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        }),
      );
      const value = await response.json<{
        error?: string;
        files?: Array<{ id: string; version: number }>;
      }>();
      if (!response.ok)
        throw new TutorActionError(value.error || 'Library action failed', response.status);
      if (method === 'DELETE' && value.files) await purgeStoredFiles(this.env, value.files);
      return value;
    };
  }
  private async conversationSession(conversationId: string) {
    const conversation = await this.ctx.storage.get<{ sessionId: string }>(
      `conversation:${conversationId}`,
    );
    if (!conversation) throw new ApiError('Conversation not found', 404);
    return conversation.sessionId;
  }
  /** The first library also keeps the app's settings, the project list and the activity log. */
  private get home() {
    return this.ctx.id.name === libraryObjectName('default');
  }
  private get project(): ProjectId {
    return this.home ? 'default' : (this.ctx.id.name!.slice('project:'.length) as ProjectId);
  }
  private async apiKey() {
    if (this.home) return this.ctx.storage.get<string>('apiKey');
    return (await internal<{ key: string | null }>(this.env, '/internal/key')).key || undefined;
  }
  /** Projects and the activity log, kept by the first library for the whole app. */
  private async homeRoute(request: Request, path: string): Promise<Response | null> {
    const storage = this.ctx.storage;
    const projects = async () => {
      const entries = [...(await storage.list<Project>({ prefix: 'project:' })).values()];
      if (!entries.some((project) => project.id === 'default')) {
        const first: Project = {
          id: 'default',
          name: (await storage.get<string>('locale')) === 'es' ? 'Mi biblioteca' : 'My library',
          createdAt: new Date().toISOString(),
          lastActiveAt: null,
        };
        await storage.put('project:default', first);
        entries.unshift(first);
      }
      return entries;
    };
    const existsMatch = path.match(/^\/internal\/projects\/([\w-]+)$/);
    if (existsMatch)
      return json({ exists: !!(await storage.get<Project>(`project:${existsMatch[1]}`)) });
    if (path === '/internal/activity' && request.method === 'POST') {
      const { project, day, events } = z
        .object({
          project: projectIdSchema,
          day: activityDaySchema,
          events: z.array(activityEventSchema).min(1).max(50),
        })
        .parse(await boundedJson(request));
      await storage.transaction(async (tx) => {
        const current = (await tx.get<StoredActivityDay>(`activity-day:${day}`)) || {
          day,
          total: 0,
          projects: {},
        };
        await tx.put(`activity-day:${day}`, scoreActivity(current, project, events));
        const record = await tx.get<Project>(`project:${project}`);
        if (record)
          await tx.put(`project:${project}`, { ...record, lastActiveAt: new Date().toISOString() });
      });
      return json({ ok: true });
    }
    if (path === '/api/activity' && request.method === 'GET') {
      const since = activityDaySchema.safeParse(new URL(request.url).searchParams.get('since'));
      const days = [
        ...(await storage.list<StoredActivityDay>({ prefix: 'activity-day:' })).values(),
      ].map(({ seen: _seen, projectKinds: _kinds, ...day }) => day);
      return json(since.success ? days.filter((day) => day.day >= since.data) : days);
    }
    if (path === '/api/projects') {
      if (request.method === 'POST') {
        const { name } = projectInputSchema.parse(await boundedJson(request));
        const project: Project = {
          id: crypto.randomUUID(),
          name,
          createdAt: new Date().toISOString(),
          lastActiveAt: null,
        };
        await storage.put(`project:${project.id}`, project);
        return json(project, 201);
      }
      const summaries: ProjectSummary[] = await Promise.all(
        (await projects()).map(async (project) => ({
          ...project,
          ...(await internal<{ files: number; sessions: number }>(
            this.env,
            '/internal/summary',
            undefined,
            project.id,
          )),
        })),
      );
      return json(summaries);
    }
    const projectMatch = path.match(/^\/api\/projects\/([\w-]+)$/);
    if (projectMatch && request.method === 'PATCH') {
      const id = projectIdSchema.parse(projectMatch[1]);
      await projects();
      const record = await storage.get<Project>(`project:${id}`);
      if (!record) throw new ApiError('Project not found', 404);
      const next = { ...record, ...projectInputSchema.parse(await boundedJson(request)) };
      await storage.put(`project:${id}`, next);
      return json(next);
    }
    if (projectMatch && request.method === 'DELETE') {
      const id = projectIdSchema.parse(projectMatch[1]);
      if (id === 'default')
        throw new ApiError('The first library keeps the app settings and cannot be deleted', 409);
      if (!(await storage.get<Project>(`project:${id}`)))
        throw new ApiError('Project not found', 404);
      // The project's library is emptied first; it stays listed if that fails, so it can be retried.
      await internal(this.env, '/internal/purge', {}, id);
      await storage.transaction(async (tx) => {
        for (const [key, day] of await tx.list<StoredActivityDay>({ prefix: 'activity-day:' })) {
          const next = withoutProject(day, id);
          if (!next) await tx.delete(key);
          else if (next !== day) await tx.put(key, next);
        }
        await tx.delete(`project:${id}`);
      });
      return json({ deleted: id });
    }
    return null;
  }
  /**
   * Deletes everything a project holds: its stored objects, its tutor conversations and
   * processing jobs, and finally its own storage.
   */
  private async purgeProject() {
    if (this.home) throw new ApiError('The first library cannot be deleted', 409);
    const storage = this.ctx.storage;
    const ids = async (prefix: string) =>
      [...(await storage.list({ prefix })).keys()].map((key) => key.slice(prefix.length));
    const files = [...(await storage.list<Source>({ prefix: 'file:' })).values()],
      conversations = await ids('conversation:');
    const prefixes = [
      ...files.flatMap((file) => [
        `original/${file.id}/`,
        `captions/${file.id}/`,
        `visuals/${file.id}/`,
      ]),
      ...(await ids('annotation:')).map((id) => `annotation/${id}/`),
      ...(await ids('capture-base:')).map((key) => `capture/${key.split(':')[0]}/`),
      ...(await ids('tutor-attachment:')).map((id) => `tutor-attachment/${id}/`),
      ...conversations.map((id) => `tutor/${encodeURIComponent(id)}/`),
    ];
    for (const prefix of new Set(prefixes)) await purgePrefix(this.env, prefix);
    for (const id of conversations) await this.env.TUTOR.getByName(id).purge();
    for (const file of files)
      for (let version = 1; version <= file.version; version++)
        for (const locale of localeSchema.options)
          await this.env.JOBS.get(
            this.env.JOBS.idFromName(`${file.id}-v${version}-${locale}`),
          ).fetch(new Request('http://internal/purge', { method: 'POST' }));
    await storage.deleteAlarm();
    await storage.deleteAll();
  }
  async settings(): Promise<Settings> {
    if (!this.home) return internal<Settings>(this.env, '/api/settings');
    const key = await this.ctx.storage.get<string>('apiKey');
    return {
      configured: !!key,
      locale: (await this.ctx.storage.get<'en' | 'es'>('locale')) || 'en',
      model: (await this.ctx.storage.get<string>('model')) || 'muse-spark-1.3',
      webAuto: (await this.ctx.storage.get<boolean>('webAuto')) ?? true,
      ...(key ? { keySuffix: key.slice(-4) } : {}),
    };
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    try {
      if (path === '/internal/prepared')
        return json(
          [...(await this.ctx.storage.list({ prefix: 'learning:' })).keys()].map((key) =>
            key.slice('learning:'.length),
          ),
        );
      if (path === '/internal/key') return json({ key: (await this.apiKey()) || null });
      if (path === '/internal/summary')
        return json({
          files: [...(await this.ctx.storage.list<Source>({ prefix: 'file:' })).values()].filter(
            (file) => !file.trashed,
          ).length,
          sessions: (await this.ctx.storage.list({ prefix: 'session:' })).size,
        });
      if (path === '/internal/purge' && request.method === 'POST') {
        await this.purgeProject();
        return json({ ok: true });
      }
      if (this.home) {
        const response = await this.homeRoute(request, path);
        if (response) return response;
      }
      // The glossary review reconciles a file's terms with the concepts already kept.
      if (path === '/internal/glossary-terms' && request.method === 'POST') {
        const { names } = z
          .object({ names: z.array(z.array(z.string().max(200)).max(11)).max(80) })
          .parse(await boundedJson(request));
        return json(await conceptIndex(this.ctx.storage, names));
      }
      if (path === '/internal/glossary-context' && request.method === 'POST') {
        const { ids } = z
          .object({ ids: z.array(z.string().uuid()).max(80) })
          .parse(await boundedJson(request));
        return json({ concepts: await conceptContexts(this.ctx.storage, ids) });
      }
      if (path === '/internal/tutor-artifact' && request.method === 'POST') {
        const value = z
          .object({
            conversationId: z.string().min(1).max(200),
            requestId: z.string().min(1).max(240),
            sourceId: z.string().uuid(),
            title: z.string().trim().min(1).max(180),
            markdown: z.string().trim().min(1).max(60000),
          })
          .parse(await boundedJson(request));
        if (!(await this.ctx.storage.get(`conversation:${value.conversationId}`)))
          throw new ApiError('Conversation not found', 404);
        const saved = await saveTutorVersion(this.ctx.storage, value.sourceId, value);
        return json({ saved: true, revision: saved.revision, title: saved.title });
      }
      if (path === '/internal/tutor-concept' && request.method === 'POST') {
        const value = z
          .object({
            conversationId: z.string().min(1).max(200),
            action: z.enum(['create', 'refine', 'add_sense', 'add_evidence']),
            mutationId: z.string().uuid(),
            term: z.string().trim().min(1).max(200).optional(),
            conceptId: z.string().uuid().optional(),
            version: z.number().int().nonnegative().optional(),
            senseId: z.string().min(1).max(100).optional(),
            label: z.string().trim().max(160).optional(),
            definition: z.string().trim().min(1).max(6000).optional(),
            aliases: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
            sources: z.array(conceptSourceSchema).max(8),
            basis: z.enum(['library', 'web', 'general']),
            links: z.array(conceptLinkSchema).max(10),
          })
          .parse(await boundedJson(request));
        if (!(await this.ctx.storage.get(`conversation:${value.conversationId}`)))
          throw new ApiError('Conversation not found', 404);
        const { conversationId: _, ...change } = value;
        const saved = await saveTutorConcept(this.ctx.storage, change);
        return json({
          saved: true,
          id: saved.id,
          term: saved.term,
          version: saved.version,
          senses: saved.senses.map((sense) => ({ id: sense.id, label: sense.label })),
        });
      }
      if (path === '/internal/tutor-artifact-job' && request.method === 'POST') {
        const value = z
          .object({
            id: z.string().uuid(),
            conversationId: z.string().min(1).max(200),
            model: z.string().min(1).max(100),
            request: tutorArtifactRequestSchema,
          })
          .parse(await boundedJson(request));
        const conversation = await this.ctx.storage.get<{ sessionId?: string }>(
          `conversation:${value.conversationId}`,
        );
        if (!conversation) throw new ApiError('Conversation not found', 404);
        const settings = await this.settings();
        return json(
          await startTutorArtifact(
            this.ctx.storage,
            {
              ...value,
              ...(conversation.sessionId ? { sessionId: conversation.sessionId } : {}),
              locale: settings.locale,
            },
            this.artifactServices(),
          ),
        );
      }
      if (
        (path === '/internal/tutor-action' || path === '/internal/tutor-library') &&
        request.method === 'POST'
      ) {
        const input = z
          .object({ conversationId: z.string().min(1).max(200) })
          .passthrough()
          .parse(await boundedJson(request));
        const sessionId = await this.conversationSession(input.conversationId);
        if (path === '/internal/tutor-library')
          return json(
            await readLibrary(
              this.ctx.storage,
              this.libraryCall(),
              z
                .discriminatedUnion('view', [
                  z.object({ view: z.literal('library'), query: z.string().max(200).optional() }),
                  z.object({
                    view: z.literal('notes'),
                    kind: z.enum(['annotation', 'bookmark']),
                    sourceId: z.string().uuid().optional(),
                  }),
                ])
                .parse(input),
              sessionId,
            ),
          );
        const { id, action } = z
          .object({ id: z.string().uuid(), action: tutorActionSchema })
          .parse(input);
        const record = await requestTutorAction(this.ctx.storage, this.libraryCall(), {
          id,
          conversationId: input.conversationId,
          sessionId,
          action,
        });
        return json({
          id: record.id,
          op: record.op,
          subject: record.subject,
          ...(record.detail ? { detail: record.detail } : {}),
          status: record.status,
          ...(record.testId ? { testId: record.testId, sessionId: record.sessionId } : {}),
        });
      }
      const tutorActionMatch = path.match(/^\/api\/tutor-actions\/([a-f0-9-]{36})$/);
      if (tutorActionMatch && request.method === 'GET')
        return json(await tutorActionStatus(this.ctx.storage, tutorActionMatch[1]));
      if (tutorActionMatch && request.method === 'POST') {
        const { decision } = z
          .object({ decision: z.enum(['confirm', 'cancel']) })
          .parse(await boundedJson(request));
        return json(
          await decideTutorAction(
            this.ctx.storage,
            this.libraryCall(),
            tutorActionMatch[1],
            decision,
            (id) => this.conversationSession(id),
          ),
        );
      }
      const tutorArtifactMatch = path.match(
        /^\/api\/tutor-artifacts\/([a-f0-9-]{36})(\/retry|\/versions\/(\d+))?$/,
      );
      if (tutorArtifactMatch && request.method === 'GET' && !tutorArtifactMatch[2])
        return json(
          await resumeTutorArtifact(
            this.ctx.storage,
            tutorArtifactMatch[1],
            this.artifactServices(),
          ),
        );
      if (tutorArtifactMatch?.[2] === '/retry' && request.method === 'POST')
        return json(
          await resumeTutorArtifact(
            this.ctx.storage,
            tutorArtifactMatch[1],
            this.artifactServices(),
            true,
          ),
        );
      if (tutorArtifactMatch?.[3] && request.method === 'GET') {
        // Any saved version of an artifact file, for its version history.
        const file = await this.ctx.storage.get<Source>(`file:${tutorArtifactMatch[1]}`);
        const version = Number(tutorArtifactMatch[3]);
        if (!file || file.kind !== 'artifact' || version > file.version)
          throw new ApiError('Artifact version not found', 404);
        const object = await this.env.FILES.get(`original/${file.id}/${version}`);
        if (!object) throw new ApiError('Artifact version not found', 404);
        return json(tutorArtifactDocumentSchema.parse(await object.json()));
      }
      if (path === '/internal/tutor-glossary-search' && request.method === 'POST') {
        const { query } = z
          .object({ query: z.string().trim().min(1).max(200) })
          .parse(await boundedJson(request));
        return json({ entries: await searchConcepts(this.ctx.storage, query) });
      }
      if (path === '/internal/tutor-bookmark' && request.method === 'POST') {
        const value = z
          .object({
            conversationId: z.string().min(1).max(200),
            requestId: z.string().min(1).max(240),
            sourceId: z.string().uuid(),
            sourceVersion: z.number().int().positive(),
            segment: segmentSchema,
            label: z.string().trim().min(1).max(240),
          })
          .parse(await boundedJson(request));
        const conversation = await this.ctx.storage.get<
          import('../shared/conversations').Conversation
        >(`conversation:${value.conversationId}`);
        if (!conversation) throw new ApiError('Conversation not found', 404);
        return json(
          await createSuggestedBookmark(this.ctx.storage, {
            sessionId: conversation.sessionId,
            requestId: value.requestId,
            sourceId: value.sourceId,
            sourceVersion: value.sourceVersion,
            label: value.label,
            segmentId: value.segment.id,
            location: {
              quote: value.segment.text.slice(0, 8000),
              ...(value.segment.page ? { page: value.segment.page } : {}),
              ...(value.segment.start != null ? { seconds: value.segment.start } : {}),
            },
          }),
        );
      }
      if (path === '/api/catalog') {
        const { files, directories } = await this.ctx.storage.transaction((storage) =>
          this.directorySnapshot(storage),
        );
        const sessions = await this.ctx.storage.list<StudySession>({ prefix: 'session:' });
        const attempts = await this.ctx.storage.list<Attempt>({ prefix: 'attempt:' });
        const concepts = await glossarySnapshot(this.ctx.storage);
        return json({
          files,
          directories,
          sessions: [...sessions.values()].map((value) => sessionSchema.parse(value)),
          conversations: await conversationSnapshot(
            this.ctx.storage,
            [...sessions.values()],
            (value) => conversationDetail(this.env, value),
          ),
          attempts: [...attempts.values()],
          concepts,
          settings: await this.settings(),
        } satisfies Catalog);
      }
      if (path === '/internal/destination' && request.method === 'POST') {
        const data = z
          .object({ folder: z.string(), directoryId: z.string().uuid().optional() })
          .parse(await boundedJson(request));
        const { directories } = await this.directorySnapshot();
        const directory = data.directoryId
          ? directories.find((entry) => entry.id === data.directoryId)
          : null;
        if (data.directoryId && !directory) throw new ApiError('Directory not found', 404);
        const folder = directory?.path ?? normalizePath(data.folder);
        assertWritableDirectory(folder, directories);
        return json({ folder });
      }
      const directoryMatch = path.match(/^\/api\/directories\/([a-f0-9-]+)$/);
      const purgeMatch = path.match(/^\/api\/(files|directories)\/([a-f0-9-]+)(\/purge-preview)?$/);
      // Concepts that cite only the files being deleted, offered for deletion alongside them.
      const conceptsLeftBehind = async (
        storage: Pick<DurableObjectStorage, 'list'>,
        files: Array<{ id: string }>,
        all: Array<{ id: string }>,
      ) =>
        conceptsOnlyIn(
          [...(await storage.list<GlossaryEntry>({ prefix: 'concept-entry:' })).values()],
          new Set(all.map((file) => file.id)),
          new Set(files.map((file) => file.id)),
        );
      if (purgeMatch?.[3] && request.method === 'GET') {
        const snapshot = await this.directorySnapshot();
        const target = purgeTargets(snapshot.directories, snapshot.files, {
          kind: purgeMatch[1] === 'files' ? 'file' : 'directory',
          id: purgeMatch[2],
        });
        const concepts = await conceptsLeftBehind(this.ctx.storage, target.files, snapshot.files);
        return json({
          files: target.files.length,
          concepts: concepts.map((entry) => ({ id: entry.id, term: entry.term })),
        });
      }
      if (purgeMatch && !purgeMatch[3] && request.method === 'DELETE') {
        const chosen = new Set(
          (url.searchParams.get('concepts') || '').split(',').filter(Boolean).slice(0, 2000),
        );
        const removed = await this.ctx.storage.transaction(async (storage) => {
          const snapshot = await this.directorySnapshot(storage);
          const target = purgeTargets(snapshot.directories, snapshot.files, {
            kind: purgeMatch[1] === 'files' ? 'file' : 'directory',
            id: purgeMatch[2],
          });
          // Only concepts still tied to nothing but these files go with them.
          if (chosen.size)
            await deleteConcepts(
              storage,
              (await conceptsLeftBehind(storage, target.files, snapshot.files))
                .map((entry) => entry.id)
                .filter((id) => chosen.has(id)),
            );
          for (const file of target.files) {
            await storage.delete([`file:${file.id}`, `learning:${file.id}`]);
            await deleteRevisions(storage, file.id);
            await deleteArtifactStudy(storage, file.id);
          }
          for (const directory of target.directories)
            await storage.delete(`directory:${directory.id}`);
          return target;
        });
        return json({
          files: removed.files.map((file) => ({ id: file.id, version: file.version })),
          directories: removed.directories.length,
        });
      }
      if (
        (path === '/api/directories' && request.method === 'POST') ||
        (directoryMatch && request.method === 'PATCH')
      ) {
        const input = directoryMatch
          ? z
              .discriminatedUnion('action', [
                z.object({ action: z.literal('rename'), name: z.string() }),
                z.object({ action: z.literal('move'), parentPath: z.string().max(240) }),
                z.object({ action: z.enum(['archive', 'unarchive', 'trash', 'restore']) }),
              ])
              .parse(await boundedJson(request))
          : z
              .object({ parentPath: z.string().default(''), name: z.string() })
              .parse(await boundedJson(request));
        const value = await this.ctx.storage.transaction(async (storage) => {
          const snapshot = await this.directorySnapshot(storage);
          const operation = directoryMatch
            ? {
                ...(input as
                  | { action: 'rename'; name: string }
                  | { action: 'move'; parentPath: string }
                  | { action: 'archive' | 'unarchive' | 'trash' | 'restore' }),
                id: directoryMatch[1],
              }
            : { ...(input as { parentPath: string; name: string }), action: 'create' as const };
          const next = changeDirectory(snapshot.directories, snapshot.files, operation);
          for (const directory of next.directories)
            await storage.put(`directory:${directory.id}`, directory);
          for (const file of next.files)
            if (snapshot.files.find((original) => original.id === file.id) !== file)
              await storage.put(`file:${file.id}`, file);
          return next;
        });
        return json(value, directoryMatch ? 200 : 201);
      }
      if (path === '/api/settings') {
        if (request.method === 'GET') return json(await this.settings());
        const value = z
          .object({
            apiKey: z.string().trim().min(10).max(1024).optional(),
            removeKey: z.boolean().optional(),
            locale: localeSchema.optional(),
            model: z.enum(['muse-spark-1.3', 'muse-wonder-1.0']).optional(),
            webAuto: z.boolean().optional(),
          })
          .parse(await boundedJson(request));
        if (value.removeKey) await this.ctx.storage.delete('apiKey');
        else if (value.apiKey) await this.ctx.storage.put('apiKey', value.apiKey);
        if (value.locale) await this.ctx.storage.put('locale', value.locale);
        if (value.model) await this.ctx.storage.put('model', value.model);
        if (value.webAuto !== undefined) await this.ctx.storage.put('webAuto', value.webAuto);
        return json(await this.settings());
      }
      if (path === '/internal/file') {
        const { directoryId, ...file } = sourceSchema
          .extend({ directoryId: z.string().uuid().optional() })
          .parse(await boundedJson(request));
        const stored = await this.ctx.storage.transaction(async (storage) => {
          const snapshot = await this.directorySnapshot(storage);
          const directory = directoryId
            ? snapshot.directories.find((entry) => entry.id === directoryId)
            : null;
          if (directoryId && !directory) throw new ApiError('Directory not found', 404);
          const folder = directory?.path ?? normalizePath(file.folder);
          assertWritableDirectory(folder, snapshot.directories);
          for (const entry of ensureDirectories(snapshot.directories, [folder]))
            await storage.put(`directory:${entry.id}`, entry);
          const next = { ...file, folder };
          await storage.put(`file:${file.id}`, next);
          return next;
        });
        return json(stored);
      }
      const fileMatch = path.match(/^\/api\/files\/([a-f0-9-]+)$/);
      if (fileMatch) {
        const file = await this.ctx.storage.get<Source>(`file:${fileMatch[1]}`);
        if (!file) throw new ApiError('File not found', 404);
        if (request.method === 'PATCH') {
          const update = z
            .object({
              name: z.string().trim().min(1).max(240).optional(),
              folder: z.string().trim().max(240).optional(),
              archived: z.boolean().optional(),
              trashed: z.boolean().optional(),
              reviewed: z.boolean().optional(),
            })
            .parse(await boundedJson(request));
          if (update.name && kindFor(update.name) !== file.kind)
            throw new ApiError('Keep the original file extension');
          const next = await this.ctx.storage.transaction(async (storage) => {
            const current = await storage.get<Source>(`file:${file.id}`);
            if (!current) throw new ApiError('File not found', 404);
            const { directories } = await this.directorySnapshot(storage);
            const folder =
              update.folder === undefined ? current.folder : normalizePath(update.folder);
            if (update.folder !== undefined) assertWritableDirectory(folder, directories);
            if (update.trashed === false && directoryState(folder, directories) === 'trash')
              throw new ApiError('Restore the parent directory first', 409);
            if (update.archived === false && directoryState(folder, directories) !== 'files')
              throw new ApiError('Restore the parent directory first', 409);
            for (const entry of ensureDirectories(directories, [folder]))
              await storage.put(`directory:${entry.id}`, entry);
            const value = { ...current, ...update, folder };
            await storage.put(`file:${file.id}`, value);
            return value;
          });
          return json(next);
        }
        return json(file);
      }
      if (path === '/api/sessions' && request.method === 'POST') {
        const data = z
          .object({ name: z.string().trim().min(1).max(160) })
          .parse(await boundedJson(request));
        const session: StudySession = {
          id: crypto.randomUUID(),
          name: data.name,
          tabs: [],
          active: null,
          split: null,
          positions: {},
          notes: [],
          bookmarks: [],
          artifacts: {},
          conversations: {},
          createdAt: new Date().toISOString(),
        };
        await this.ctx.storage.put(`session:${session.id}`, session);
        return json(session, 201);
      }
      const sessionMatch = path.match(/^\/api\/sessions\/([a-f0-9-]+)$/);
      if (sessionMatch && request.method === 'PUT') {
        const value = sessionSchema.parse(await boundedJson(request));
        if (value.id !== sessionMatch[1]) throw new ApiError('Session identity mismatch');
        const progressed = await this.ctx.storage.transaction(async (tx) => {
          const previous = await tx.get<StudySession>(`session:${value.id}`);
          if (!previous) throw new ApiError('Session not found', 404);
          await captureStudyProgress(tx, previous, value);
          await tx.put(`session:${value.id}`, value);
          return Object.keys(value.positions).filter(
            (id) => value.positions[id] !== previous.positions[id],
          );
        });
        // The files whose saved position moved count once a day each in the activity graph.
        return withActivity(
          value,
          200,
          progressed.map((key) => ({ kind: 'progress', key })),
        );
      }
      if (path.startsWith('/api/assessments')) {
        const options = {
          conversations: (sessionId: string, sourceIds: string[]) =>
            assessmentConversations(this.env, this.ctx.storage, sessionId, sourceIds),
          owner: this.executionId,
          settings: await this.settings(),
          start: (task: Promise<void>) => this.ctx.waitUntil(task),
          generate: async (
            context: import('../shared/assessments').AssessmentContext,
            config: import('../shared/assessments').AssessmentConfig,
            previous: string[],
            batch: number,
            locale: Settings['locale'],
            model: string,
          ) => {
            const key = await this.apiKey();
            if (!key) throw new ApiError('Add a Meta API key in Settings', 409);
            return generateAssessmentBatch(
              key,
              model,
              context,
              config,
              previous,
              batch,
              locale,
              bridgedFetch(this.env),
              await readAssessmentImages(this.env.FILES, context),
            );
          },
          analyze: async (
            context: import('../shared/assessments').AssessmentContext,
            plan: import('../shared/assessments').AssessmentPlan,
            grades: import('../shared/assessments').AssessmentGrade[],
            locale: Settings['locale'],
            model: string,
          ) => {
            const key = await this.apiKey();
            if (!key) throw new ApiError('Add a Meta API key in Settings', 409);
            return analyzeAssessment(
              key,
              model,
              context,
              plan,
              grades,
              locale,
              bridgedFetch(this.env),
              await readAssessmentImages(this.env.FILES, context),
            );
          },
        };
        if (path === '/api/assessments/options' && request.method === 'POST') {
          const input = z
            .object({ sessionId: z.string().uuid() })
            .parse(await boundedJson(request));
          await ensureSharedAnnotations(this.ctx.storage);
          return json(
            await this.ctx.storage.transaction((tx) => assessmentOptions(tx, input.sessionId)),
          );
        }
        if (path === '/api/assessments' && request.method === 'GET') {
          const sessionParam = url.searchParams.get('sessionId');
          const sessionId =
            sessionParam === null ? undefined : z.string().uuid().parse(sessionParam);
          return json(
            await assessmentHistory(
              this.ctx.storage,
              sessionId,
              this.executionId,
              url.searchParams.get('after') || undefined,
            ),
          );
        }
        if (path === '/api/assessments' && request.method === 'POST') {
          await ensureSharedAnnotations(this.ctx.storage);
          return json(
            await createAssessment(this.ctx.storage, await boundedJson(request), options),
            202,
          );
        }
        const match = path.match(
          /^\/api\/assessments\/([a-f0-9-]+)(?:\/(answers|export|export-html))?$/,
        );
        if (match) {
          if (match[2] === 'answers' && request.method === 'POST')
            return json(
              await saveAssessmentAnswer(this.ctx.storage, match[1], await boundedJson(request)),
              201,
            );
          if (request.method === 'GET') {
            if (!match[2] && url.searchParams.get('view') === 'summary')
              return json(await assessmentSummary(this.ctx.storage, match[1], this.executionId));
            const detail = await assessmentDetail(this.ctx.storage, match[1], this.executionId);
            if (match[2] === 'export' || match[2] === 'export-html') {
              if (!detail.report)
                throw new ApiError('Complete the assessment before exporting its report.', 409);
              const html = match[2] === 'export-html';
              return new Response(
                html
                  ? assessmentHTML(
                      detail,
                      await readAssessmentImages(this.env.FILES, detail.context),
                    )
                  : assessmentMarkdown(detail),
                {
                  headers: {
                    'Content-Type': html
                      ? 'text/html; charset=utf-8'
                      : 'text/markdown; charset=utf-8',
                    'Content-Disposition': `attachment; filename="assessment-${match[1]}.${html ? 'html' : 'md'}"`,
                    'Cache-Control': 'no-store',
                    ...(html
                      ? {
                          'Content-Security-Policy': assessmentExportPolicy,
                          'X-Content-Type-Options': 'nosniff',
                        }
                      : {}),
                  },
                },
              );
            }
            return json(detail);
          }
          if (!match[2] && request.method === 'POST')
            return json(
              await assessmentAction(
                this.ctx.storage,
                match[1],
                await boundedJson(request),
                options,
              ),
              202,
            );
        }
      }
      const learningMatch = path.match(/^\/(api|internal)\/learning\/([a-f0-9-]+)$/);
      if (learningMatch) {
        const id = learningMatch[2];
        if (request.method === 'POST' && learningMatch[1] === 'internal') {
          const value = (await boundedJson(request)) as Learning;
          const file = await this.ctx.storage.get<Source>(`file:${id}`);
          if (!file || file.version !== value.sourceVersion)
            throw new ApiError('Source version changed', 409);
          await this.ctx.storage.put(`learning:${id}`, value);
          await recordGenerated(this.ctx.storage, value);
          // The file's glossary terms become concepts without a review step.
          await ingestLearning(this.ctx.storage, value).catch((error) =>
            console.error('Concept creation after preparation failed', error),
          );
          return json({ ok: true });
        }
        const value = await this.ctx.storage.get<Learning>(`learning:${id}`);
        if (!value || learningMatch[1] === 'internal') return json(value || null);
        // Readers see the latest saved version of the artifact, edited or generated.
        const latest = await latestArtifact(this.ctx.storage, value);
        return json(
          publicLearning(
            latest
              ? { ...value, synthesis: { ...value.synthesis, artifact: latest.artifact } }
              : value,
          ),
        );
      }
      const studyMatch = path.match(/^\/api\/artifacts\/([a-f0-9-]+)\/study$/);
      if (studyMatch && request.method === 'GET')
        return json(await artifactStudySnapshot(this.ctx.storage, studyMatch[1]));
      if (studyMatch && request.method === 'POST') {
        const settings = await this.settings();
        return json(
          await startArtifactStudy(this.ctx.storage, studyMatch[1], {
            owner: this.executionId,
            start: (task) => this.ctx.waitUntil(task),
            generate: async (learning, chapters) => {
              const key = await this.apiKey();
              if (!key) throw new ApiError('Add a Meta API key in Settings', 409);
              return generateArtifactStudy(
                key,
                settings.model,
                learning,
                chapters,
                bridgedFetch(this.env),
              );
            },
          }),
          202,
        );
      }
      const revisionsMatch = path.match(/^\/api\/artifacts\/([a-f0-9-]+)\/revisions(?:\/(\d+))?$/);
      if (revisionsMatch) {
        const [, sourceId, revision] = revisionsMatch;
        if (revision && request.method === 'GET')
          return json(await getRevision(this.ctx.storage, sourceId, Number(revision)));
        if (!revision && request.method === 'GET')
          return json(await listRevisions(this.ctx.storage, sourceId));
        if (!revision && request.method === 'POST')
          return json(await saveEdit(this.ctx.storage, sourceId, await boundedJson(request)), 201);
      }
      if (path === '/api/artifacts' && request.method === 'GET') {
        const records = await this.ctx.storage.list<Learning>({ prefix: 'learning:' });
        const items: Array<{
          id: string;
          origin: 'source' | 'reinforcement' | 'tutor';
          sourceId: string;
          sessionId?: string;
          title: string;
          kind: string;
          revision: number;
          createdAt: string;
        }> = [];
        for (const value of records.values()) {
          const latest = await latestArtifact(this.ctx.storage, value);
          if (latest)
            items.push({
              id: `source:${value.sourceId}`,
              origin: 'source',
              sourceId: value.sourceId,
              title: latest.artifact.title,
              kind: latest.artifact.kind,
              revision: latest.revision,
              createdAt: value.createdAt,
            });
        }
        // Review artifacts belong to the session that created them.
        const reviews = await this.ctx.storage.list<Reinforcement>({ prefix: 'reinforcement:' });
        for (const value of reviews.values())
          if (value.status === 'ready' && value.plan?.artifact)
            items.push({
              id: `reinforcement:${value.id}`,
              origin: 'reinforcement',
              sourceId: value.sourceId,
              sessionId: value.sessionId,
              title: value.plan.artifact.title,
              kind: value.plan.artifact.kind,
              revision: 1,
              createdAt: value.createdAt,
            });
        // Tutor artifacts are files of their own, listed with their latest version.
        const { files } = await this.ctx.storage.transaction((storage) =>
          this.directorySnapshot(storage),
        );
        for (const file of files)
          if (file.kind === 'artifact' && !file.trashed)
            items.push({
              id: `tutor:${file.id}`,
              origin: 'tutor',
              sourceId: file.id,
              title: file.name.replace(/\.artifact$/, ''),
              kind: 'document',
              revision: file.version,
              createdAt: file.createdAt,
            });
        items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return json(items);
      }
      const cardsMatch = path.match(/^\/api\/flashcards\/([a-f0-9-]+)$/);
      if (path === '/api/reinforcements' && request.method === 'GET')
        return json(await reinforcementSnapshot(this.ctx.storage, this.executionId));
      if (path === '/api/reinforcements' && request.method === 'POST')
        return json(
          await startReinforcement(this.ctx.storage, await boundedJson(request), {
            owner: this.executionId,
            settings: await this.settings(),
            start: (task) => this.ctx.waitUntil(task),
            generate: async (context, locale, model) => {
              const key = await this.apiKey();
              if (!key) throw new ApiError('Add a Meta API key in Settings', 409);
              return generateReinforcement(key, model, context, locale, bridgedFetch(this.env));
            },
          }),
          202,
        );
      if (cardsMatch && request.method === 'GET')
        return json(await cardSnapshot(this.ctx.storage, cardsMatch[1], this.executionId));
      if (cardsMatch && request.method === 'POST') {
        const settings = await this.settings();
        return json(
          await startCardDecks(this.ctx.storage, cardsMatch[1], await boundedJson(request), {
            owner: this.executionId,
            settings,
            start: (task) => this.ctx.waitUntil(task),
            generate: async (learning, chapterId) => {
              const key = await this.apiKey();
              if (!key) throw new ApiError('Add a Meta API key in Settings', 409);
              return generateCards(
                key,
                settings.model,
                learning,
                chapterId,
                bridgedFetch(this.env),
              );
            },
          }),
          202,
        );
      }
      const cardReviewMatch = path.match(/^\/api\/flashcards\/([a-f0-9-]+)\/review$/);
      if (cardReviewMatch && request.method === 'POST') {
        const review = await rateCard(
          this.ctx.storage,
          cardReviewMatch[1],
          await boundedJson(request),
        );
        // A deck counts in the activity graph once all its cards were reviewed that day.
        return withActivity(review, 201, [
          {
            kind: 'deck',
            key: review.deckId,
            part: review.cardId,
            parts: Math.max(1, await deckSize(this.ctx.storage, review.deckId)),
          },
        ]);
      }
      if (path === '/api/attempts' && request.method === 'POST') {
        const input = await boundedJson(request);
        const attempt = await recordAttempt(
          this.ctx.storage,
          input,
          this.executionId,
          async (question, answer, segments) => {
            const key = await this.apiKey();
            if (!key) throw new ApiError('Add a Meta API key in Settings', 409);
            return gradeShortAnswer(
              key,
              (await this.settings()).model,
              question,
              answer,
              segments,
              bridgedFetch(this.env),
            );
          },
        );
        // A mini quiz counts in the activity graph once all its questions were answered that day.
        const quiz = await quizOf(this.ctx.storage, input, attempt);
        return withActivity(attempt, 201, [
          {
            kind: 'quiz',
            key: quiz.key,
            part: attempt.questionId,
            parts: Math.max(1, quiz.questions),
          },
        ]);
      }
      const chatMatch = path.match(/^\/api\/assistant\/([a-f0-9-]+)$/);
      if (chatMatch && request.method === 'POST') {
        const value = z
          .object({
            prompt: z.string().trim().min(1).max(8000),
            history: z
              .array(
                z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(16000) }),
              )
              .max(20)
              .default([]),
          })
          .parse(await boundedJson(request));
        const learning = await this.ctx.storage.get<Learning>(`learning:${chatMatch[1]}`);
        if (!learning) throw new ApiError('Prepare this source first', 409);
        const key = await this.apiKey();
        if (!key) throw new ApiError('Add a Meta API key in Settings', 409);
        const attempts = [
          ...(await this.ctx.storage.list<Attempt>({ prefix: 'attempt:' })).values(),
        ].filter((a) => a.sourceId === chatMatch[1]);
        return json(
          await runAssistant(
            key,
            (await this.settings()).model,
            value.prompt,
            value.history,
            learning,
            reviewSummary(attempts),
            bridgedFetch(this.env),
          ),
        );
      }
      const attachmentResponse = await attachmentRoute(request, this.env, this.ctx.storage, () =>
        boundedJson(request),
      );
      if (attachmentResponse) return attachmentResponse;
      const conversationResponse = await conversationRoute({
        request,
        env: this.env,
        storage: this.ctx.storage,
        executionId: this.executionId,
        project: this.project,
        body: () => boundedJson(request),
        settings: () => this.settings(),
      });
      if (conversationResponse) return conversationResponse;
      const glossaryResponse = await glossaryRoute(request, this.ctx.storage, () =>
        boundedJson(request),
      );
      if (glossaryResponse) return glossaryResponse;
      const captureResponse = await captureRoute(request, this.env, this.ctx.storage, () =>
        boundedJson(request),
      );
      if (captureResponse) return captureResponse;
      const annotationResponse = await annotationRoute(request, this.env, this.ctx.storage, () =>
        boundedJson(request),
      );
      if (annotationResponse) return annotationResponse;
      throw new ApiError('Not found', 404);
    } catch (error) {
      if (
        error instanceof ApiError ||
        error instanceof DirectoryError ||
        error instanceof AnnotationError ||
        error instanceof CaptureError ||
        error instanceof AttachmentError ||
        error instanceof GlossaryError ||
        error instanceof CardError ||
        error instanceof ArtifactRevisionError ||
        error instanceof TutorArtifactError ||
        error instanceof TutorActionError ||
        error instanceof ReinforcementError ||
        error instanceof AssessmentError ||
        error instanceof TutorJournalError ||
        error instanceof PracticeError
      )
        return json({ error: error.message }, error.status);
      if (error instanceof MetaError)
        return json({ error: error.message }, error.retryable ? 503 : 422);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return json({ error: 'Invalid request' }, 400);
      throw error;
    }
  }
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    // The few routes whose interaction is named in the body are read before the library uses it.
    const body = activityBodyRoute(request.method, url.pathname)
      ? await request
          .clone()
          .json()
          .catch(() => null)
      : null;
    const response = await serve(request, env, url);
    if (!response.ok) return response;
    const deleted =
      request.method === 'DELETE' && url.pathname.match(/^\/api\/projects\/([\w-]+)$/);
    if (deleted) knownProjects.delete(deleted[1] as ProjectId);
    // Scored interactions go to the activity log per local day, with those the library reports.
    const events: ActivityEvent[] = [
      ...classifyActivity(request.method, url.pathname, body),
      ...reportedActivity(response.headers.get('X-Activity')),
    ];
    if (events.length) {
      const day = activityDaySchema.safeParse(request.headers.get('X-Local-Day'));
      ctx.waitUntil(
        internal(env, '/internal/activity', {
          project: requestProject(request, url),
          day: day.success ? day.data : new Date().toISOString().slice(0, 10),
          events,
        }).catch(() => {}),
      );
    }
    return response;
  },
} satisfies ExportedHandler<Env>;
function reportedActivity(header: string | null): ActivityEvent[] {
  if (!header) return [];
  try {
    return z
      .array(activityEventSchema)
      .max(50)
      .parse(JSON.parse(decodeURIComponent(header)));
  } catch {
    return [];
  }
}
async function serve(request: Request, env: Env, url: URL): Promise<Response> {
  {
    try {
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        throw new ApiError('Local access only', 403);
      const origin = request.headers.get('Origin');
      if (
        origin &&
        ![
          'http://127.0.0.1:9876',
          'http://localhost:9876',
          'http://127.0.0.1:5173',
          'http://localhost:5173',
        ].includes(origin)
      )
        throw new ApiError('Foreign origin rejected', 403);
      if (request.headers.get('Sec-Fetch-Site') === 'cross-site')
        throw new ApiError('Cross-site access rejected', 403);
      if (request.method === 'OPTIONS') return new Response(null, { status: 403 });
      if (url.pathname === '/api/health')
        return json({ ok: true, runtime: 'workerd', version: '0.1.0' });
      const project = appRoute(url.pathname)
        ? 'default'
        : await existingProject(env, requestProject(request, url));
      const call = <T>(path: string, body?: unknown) => internal<T>(env, path, body, project);
      const toolsMatch = url.pathname.match(
        /^\/api\/tutor-tools\/([a-f0-9-]{36})\/([a-f0-9]{64})$/,
      );
      if (toolsMatch) {
        // The agent host serving a reply calls the tutor's tools here, as a minimal MCP server.
        if (request.method !== 'POST') return new Response(null, { status: 405 });
        const token = request.headers.get('Authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        if (!token) throw new ApiError('Unauthorized', 401);
        const body: unknown = await request.json();
        const conversation = env.TUTOR.getByName(toolsMatch[1]);
        const replies: unknown[] = [];
        for (const message of Array.isArray(body) ? body : [body]) {
          const result = await conversation.tools(toolsMatch[2], token, message);
          if (!result.ok) throw new ApiError(result.error, result.status);
          if (result.value) replies.push(result.value);
        }
        if (!replies.length) return new Response(null, { status: 202 });
        return json(Array.isArray(body) ? replies : replies[0]);
      }
      if (url.pathname === '/api/files' && request.method === 'POST') {
        const name = decodeURIComponent(request.headers.get('X-File-Name') || '');
        const inputFolder = decodeURIComponent(request.headers.get('X-File-Folder') || '');
        const directoryId = request.headers.get('X-Directory-Id') || undefined;
        const { folder } = await call<{ folder: string }>('/internal/destination', {
          folder: inputFolder,
          directoryId,
        });
        const kind = kindFor(name),
          size = Number(request.headers.get('Content-Length'));
        if (
          !kind ||
          kind === 'artifact' ||
          !name.trim() ||
          name.length > 240 ||
          folder.length > 240
        )
          throw new ApiError('Unsupported file or invalid name');
        if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES)
          throw new ApiError('File must be between 1 byte and 2 GB', 413);
        if (!request.body) throw new ApiError('Missing file');
        const file: Source = {
          id: crypto.randomUUID(),
          version: 1,
          name,
          folder,
          kind,
          mime: request.headers.get('Content-Type') || 'application/octet-stream',
          size,
          archived: false,
          reviewed: false,
          createdAt: new Date().toISOString(),
        };
        try {
          await env.FILES.put(`original/${file.id}/1`, request.body, {
            httpMetadata: { contentType: file.mime },
          });
        } catch (error) {
          // A cancelled upload ends the body early; drop anything partially stored.
          await env.FILES.delete(`original/${file.id}/1`).catch(() => {});
          throw error;
        }
        try {
          const stored = await call<Source>('/internal/file', { ...file, directoryId });
          return json(stored, 201);
        } catch (error) {
          await env.FILES.delete(`original/${file.id}/1`);
          throw error;
        }
      }
      const contentMatch = url.pathname.match(/^\/api\/files\/([a-f0-9-]+)\/content$/);
      if (contentMatch) {
        const file = await call<Source>(`/api/files/${contentMatch[1]}`);
        if (url.searchParams.has('version')) {
          const expected = z.coerce
            .number()
            .int()
            .positive()
            .parse(url.searchParams.get('version'));
          if (expected !== file.version)
            throw new ApiError('This source version changed. Choose the file again.', 409);
        }
        const object = await env.FILES.get(`original/${file.id}/${file.version}`, {
          range: request.headers,
        });
        if (!object) throw new ApiError('Original missing', 404);
        const headers = new Headers({
          'Content-Type': file.mime,
          'Accept-Ranges': 'bytes',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': 'sandbox',
          'Cache-Control': 'no-store',
          'X-Source-Version': String(file.version),
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        });
        let status = 200;
        if (object.range && 'offset' in object.range && object.range.offset !== undefined) {
          const length =
            'length' in object.range ? object.range.length : object.size - object.range.offset;
          if (length !== undefined) {
            headers.set(
              'Content-Range',
              `bytes ${object.range.offset}-${object.range.offset + length - 1}/${object.size}`,
            );
            headers.set('Content-Length', String(length));
            status = 206;
          }
        }
        return new Response(request.method === 'HEAD' ? null : object.body, { status, headers });
      }
      const jobMatch = url.pathname.match(/^\/api\/jobs\/([a-f0-9-]+-v\d+-(?:en|es))$/);
      if (jobMatch) {
        return env.JOBS.get(env.JOBS.idFromName(jobMatch[1])).fetch(request);
      }
      // The preparation queue: every library file with its job in one language, if any.
      if (
        (url.pathname === '/api/jobs' && request.method === 'GET') ||
        (url.pathname === '/api/jobs/batch' && request.method === 'POST')
      ) {
        const locale = localeSchema.parse(
          request.method === 'GET'
            ? url.searchParams.get('locale')
            : (await boundedJson(request)).locale,
        );
        const catalog = await call<{ files: Source[]; directories: Directory[] }>('/api/catalog');
        // Tutor artifacts are written, not prepared.
        const files = catalog.files.filter(
          (file) => sourceState(file, catalog.directories) === 'files' && file.kind !== 'artifact',
        );
        const prepared = new Set(await call<string[]>('/internal/prepared'));
        const items = await Promise.all(
          files.map(async (file) => {
            const id = `${file.id}-v${file.version}-${locale}`;
            const response = await env.JOBS.get(env.JOBS.idFromName(id)).fetch(
              `http://internal/status?summary`,
            );
            return {
              file,
              prepared: prepared.has(file.id),
              job: await response.json<Job | null>(),
            };
          }),
        );
        if (request.method === 'GET')
          return json(
            items.map(({ file, prepared, job }) => ({ sourceId: file.id, prepared, job })),
          );
        // Pending files were never prepared, in any language, and have no job in this one.
        const pending = items.filter(({ prepared, job }) => !prepared && !job);
        if (pending.length) {
          const { key } = await call<{ key: string | null }>('/internal/key');
          if (!key) throw new ApiError('Add a Meta API key in Settings', 409);
        }
        for (const { file } of pending) await startJob(env, file, locale, project);
        return json({ queued: pending.map(({ file }) => file.id) });
      }
      if (url.pathname === '/api/jobs' && request.method === 'POST') {
        const data = z
          .object({ sourceId: z.string().uuid(), locale: localeSchema })
          .parse(await boundedJson(request));
        const file = await call<Source>(`/api/files/${data.sourceId}`),
          { key } = await call<{ key: string | null }>('/internal/key');
        if (file.kind === 'artifact') throw new ApiError('Tutor artifacts are not prepared', 400);
        if (!key) throw new ApiError('Add a Meta API key in Settings', 409);
        return startJob(env, file, data.locale, project);
      }
      const visualMatch = url.pathname.match(/^\/api\/visuals\/([a-f0-9-]+)\/(\d+)\/([^/]+)$/);
      if (visualMatch && request.method === 'GET') {
        const object = await env.FILES.get(
          visualKey(visualMatch[1], Number(visualMatch[2]), decodeURIComponent(visualMatch[3])),
        );
        if (!object) throw new ApiError('Picture not available', 404);
        return new Response(object.body, {
          headers: {
            'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
            'Cache-Control': 'private, max-age=3600',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      const trackMatch = url.pathname.match(
        /^\/api\/captions\/([a-f0-9-]+)\/(original|translated)\.(vtt|srt)$/,
      );
      if (trackMatch) {
        const object = await env.FILES.get(
          `captions/${trackMatch[1]}/${trackMatch[2]}.${trackMatch[3]}`,
        );
        if (!object) throw new ApiError('Captions not available', 404);
        return new Response(object.body, {
          headers: {
            'Content-Type':
              trackMatch[3] === 'vtt'
                ? 'text/vtt; charset=utf-8'
                : 'application/x-subrip; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        });
      }
      if (
        request.method === 'DELETE' &&
        /^\/api\/(files|directories)\/[a-f0-9-]+$/.test(url.pathname)
      ) {
        const response = await library(env, project).fetch(request);
        if (!response.ok) return response;
        const removed = await response.json<{
          files: Array<{ id: string; version: number }>;
          directories: number;
        }>();
        // Stored bytes go after the records, so a failure here never leaves a visible file without content.
        await purgeStoredFiles(env, removed.files);
        return json(removed);
      }
      return library(env, project).fetch(request);
    } catch (error) {
      if (error instanceof ApiError) return json({ error: error.message }, error.status);
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return json({ error: 'Invalid request' }, 400);
      console.error(
        JSON.stringify({
          event: 'request_failed',
          path: url.pathname,
          errorType: error instanceof Error ? error.name : 'unknown',
        }),
      );
      return json(
        { error: 'Local operation failed. Check that the companion process is running.' },
        500,
      );
    }
  }
}
