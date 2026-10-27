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
} from '../shared/domain';
export { ProcessingJob } from './jobs';
export { TutorConversation } from './tutor-conversation';
import {
  runAssistant,
  bridgedFetch,
  gradeShortAnswer,
  analyzeConcepts,
  generateCards,
  generateReinforcement,
  generateAssessmentBatch,
  analyzeAssessment,
  MetaError,
} from './meta';
import { cardSnapshot, startCardDecks, rateCard, CardError } from './flashcards';
import { reinforcementSnapshot, startReinforcement, ReinforcementError } from './reinforcements';
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
import { conceptSuggestionsRoute } from './concept-suggestions';
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
import { recordAttempt, PracticeError } from './practice';
import {
  annotationRoute,
  AnnotationError,
  ensureSharedAnnotations,
  createSuggestedBookmark,
} from './annotations';
import { glossaryRoute, glossarySnapshot, GlossaryError } from './glossary';
import {
  changeDirectory,
  ensureDirectories,
  normalizePath,
  assertWritableDirectory,
  directoryState,
  DirectoryError,
} from '../shared/directories';

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
export function library(env: Env) {
  return env.LIBRARY.get(env.LIBRARY.idFromName('local-user'));
}
export async function internal<T>(env: Env, path: string, body?: unknown): Promise<T> {
  const response = await library(env).fetch(
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
  async settings(): Promise<Settings> {
    const key = await this.ctx.storage.get<string>('apiKey');
    return {
      configured: !!key,
      locale: (await this.ctx.storage.get<'en' | 'es'>('locale')) || 'en',
      model: (await this.ctx.storage.get<string>('model')) || 'muse-spark-1.3',
      ...(key ? { keySuffix: key.slice(-4) } : {}),
    };
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url),
      path = url.pathname;
    try {
      if (path === '/internal/key')
        return json({ key: (await this.ctx.storage.get<string>('apiKey')) || null });
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
          })
          .parse(await boundedJson(request));
        if (value.removeKey) await this.ctx.storage.delete('apiKey');
        else if (value.apiKey) await this.ctx.storage.put('apiKey', value.apiKey);
        if (value.locale) await this.ctx.storage.put('locale', value.locale);
        if (value.model) await this.ctx.storage.put('model', value.model);
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
        await this.ctx.storage.transaction(async (tx) => {
          const previous = await tx.get<StudySession>(`session:${value.id}`);
          if (!previous) throw new ApiError('Session not found', 404);
          await captureStudyProgress(tx, previous, value);
          await tx.put(`session:${value.id}`, value);
        });
        return json(value);
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
            const key = await this.ctx.storage.get<string>('apiKey');
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
            const key = await this.ctx.storage.get<string>('apiKey');
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
          return json({ ok: true });
        }
        const value = await this.ctx.storage.get<Learning>(`learning:${id}`);
        return json(
          value ? (learningMatch[1] === 'internal' ? value : publicLearning(value)) : null,
        );
      }
      if (path === '/api/artifacts' && request.method === 'GET') {
        const records = await this.ctx.storage.list<Learning>({ prefix: 'learning:' });
        const items = [];
        for (const value of records.values())
          if (value.synthesis.artifact)
            items.push({
              sourceId: value.sourceId,
              title: value.synthesis.artifact.title,
              kind: value.synthesis.artifact.kind,
              createdAt: value.createdAt,
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
              const key = await this.ctx.storage.get<string>('apiKey');
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
              const key = await this.ctx.storage.get<string>('apiKey');
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
      if (cardReviewMatch && request.method === 'POST')
        return json(
          await rateCard(this.ctx.storage, cardReviewMatch[1], await boundedJson(request)),
          201,
        );
      if (path === '/api/attempts' && request.method === 'POST') {
        const attempt = await recordAttempt(
          this.ctx.storage,
          await boundedJson(request),
          this.executionId,
          async (question, answer, segments) => {
            const key = await this.ctx.storage.get<string>('apiKey');
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
        return json(attempt, 201);
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
        const key = await this.ctx.storage.get<string>('apiKey');
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
        body: () => boundedJson(request),
        settings: () => this.settings(),
      });
      if (conversationResponse) return conversationResponse;
      const suggestionsResponse = await conceptSuggestionsRoute({
        request,
        storage: this.ctx.storage,
        executionId: this.executionId,
        body: () => boundedJson(request),
        settings: () => this.settings(),
        start: (task) => this.ctx.waitUntil(task),
        analyze: async (learning, known, locale, model) => {
          const key = await this.ctx.storage.get<string>('apiKey');
          if (!key) throw new ApiError('Add a Meta API key in Settings', 409);
          return analyzeConcepts(key, model, learning, known, locale, bridgedFetch(this.env));
        },
      });
      if (suggestionsResponse) return suggestionsResponse;
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
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
        return json({ ok: true, runtime: 'celld', version: '0.1.0' });
      if (url.pathname === '/api/files' && request.method === 'POST') {
        const name = decodeURIComponent(request.headers.get('X-File-Name') || '');
        const inputFolder = decodeURIComponent(request.headers.get('X-File-Folder') || '');
        const directoryId = request.headers.get('X-Directory-Id') || undefined;
        const { folder } = await internal<{ folder: string }>(env, '/internal/destination', {
          folder: inputFolder,
          directoryId,
        });
        const kind = kindFor(name),
          size = Number(request.headers.get('Content-Length'));
        if (!kind || !name.trim() || name.length > 240 || folder.length > 240)
          throw new ApiError('Unsupported file or invalid name');
        if (!Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES)
          throw new ApiError('File must be between 1 byte and 512 MB', 413);
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
          const stored = await internal<Source>(env, '/internal/file', { ...file, directoryId });
          return json(stored, 201);
        } catch (error) {
          await env.FILES.delete(`original/${file.id}/1`);
          throw error;
        }
      }
      const contentMatch = url.pathname.match(/^\/api\/files\/([a-f0-9-]+)\/content$/);
      if (contentMatch) {
        const file = await internal<Source>(env, `/api/files/${contentMatch[1]}`);
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
      if (url.pathname === '/api/jobs' && request.method === 'POST') {
        const data = z
          .object({ sourceId: z.string().uuid(), locale: localeSchema })
          .parse(await boundedJson(request));
        const file = await internal<Source>(env, `/api/files/${data.sourceId}`),
          { key } = await internal<{ key: string | null }>(env, '/internal/key');
        if (!key) throw new ApiError('Add a Meta API key in Settings', 409);
        const id = `${file.id}-v${file.version}-${data.locale}`;
        return env.JOBS.get(env.JOBS.idFromName(id)).fetch(
          new Request('http://internal/start', {
            method: 'POST',
            body: JSON.stringify({ id, file, locale: data.locale }),
          }),
        );
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
      if (url.pathname.startsWith('/api/code/')) {
        const response = await fetch(`${env.MEDIA_BRIDGE_URL}${url.pathname}`, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${env.MEDIA_BRIDGE_TOKEN}`,
            'Content-Type': 'application/json',
          },
          ...(request.method === 'POST'
            ? { body: JSON.stringify(await boundedJson(request)) }
            : {}),
        });
        return new Response(response.body, {
          status: response.status,
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        });
      }
      return library(env).fetch(request);
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
  },
} satisfies ExportedHandler<Env>;
