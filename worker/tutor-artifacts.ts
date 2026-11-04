import type { Learning, Source } from '../shared/domain';
import {
  artifactMaterials,
  artifactStatus,
  assembleArtifact,
  chapterIssues,
  materialIds,
  type ArtifactMaterial,
  type ArtifactPlan,
  type TutorArtifactDocument,
  type TutorArtifactJob,
  type TutorArtifactRequest,
} from '../shared/tutor-artifacts';
import type { GlossaryStorage } from './glossary';

export class TutorArtifactError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
const jobKey = (id: string) => `tutor-artifact-job:${id}`;
/** How long a running generation may go without saving progress before another run resumes it. */
const LEASE = 4 * 60 * 1000;

export type TutorArtifactServices = {
  owner: string;
  start(task: Promise<unknown>): void;
  plan(
    job: TutorArtifactJob,
    materials: ArtifactMaterial[],
    previous: string | null,
  ): Promise<ArtifactPlan>;
  chapter(
    job: TutorArtifactJob,
    plan: ArtifactPlan,
    index: number,
    materials: ArtifactMaterial[],
    repair?: { markdown: string; issues: string[] },
  ): Promise<string>;
  /** The current document of an existing artifact file, for a new version. */
  previous(fileId: string): Promise<TutorArtifactDocument | null>;
  /** Saves the document as the file's next version and returns that version. */
  save(job: TutorArtifactJob, document: TutorArtifactDocument): Promise<number>;
  /** Fire-and-forget hook so the Agent activity panel can show the generation progress. */
  emit?(
    phase: 'plan' | 'write' | 'chapter' | 'check' | 'ready' | 'failed',
    details: { job: TutorArtifactJob; chapterIndex?: number; error?: string },
  ): void;
};

async function materials(storage: GlossaryStorage, request: TutorArtifactRequest) {
  const files: Array<{ learning: Learning; name: string }> = [];
  for (const sourceId of request.sourceIds) {
    const [learning, file] = await Promise.all([
      storage.get<Learning>(`learning:${sourceId}`),
      storage.get<Source>(`file:${sourceId}`),
    ]);
    if (!learning || !file || file.version !== learning.sourceVersion)
      throw new TutorArtifactError(`${file?.name || 'A selected file'} is not prepared yet.`, 409);
    files.push({ learning, name: file.name });
  }
  return artifactMaterials(files);
}

/**
 * Starts generating an artifact, or returns the generation already started for the same call.
 * The tool returns at once; the student follows the stages in the chat.
 */
export async function startTutorArtifact(
  storage: GlossaryStorage,
  input: {
    id: string;
    conversationId: string;
    turnId?: string;
    sessionId?: string;
    request: TutorArtifactRequest;
    locale: 'en' | 'es';
    model: string;
  },
  services: TutorArtifactServices,
) {
  const existing = await storage.get<TutorArtifactJob>(jobKey(input.id));
  if (existing) return resumeTutorArtifact(storage, input.id, services);
  if (input.request.artifactId) {
    const file = await storage.get<Source>(`file:${input.request.artifactId}`);
    if (!file || file.kind !== 'artifact' || file.trashed)
      throw new TutorArtifactError('That artifact is not in the library.', 404);
  }
  await materials(storage, input.request);
  const now = new Date().toISOString();
  const job: TutorArtifactJob = {
    id: input.id,
    fileId: input.request.artifactId || crypto.randomUUID(),
    conversationId: input.conversationId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    request: input.request,
    locale: input.locale,
    model: input.model,
    status: 'planning',
    chapters: [],
    owner: services.owner,
    until: Date.now() + LEASE,
    createdAt: now,
    updatedAt: now,
  };
  await storage.put(jobKey(job.id), job);
  services.start(run(storage, job, services));
  return artifactStatus(job);
}

export async function tutorArtifactStatus(storage: GlossaryStorage, id: string) {
  const job = await storage.get<TutorArtifactJob>(jobKey(id));
  if (!job) throw new TutorArtifactError('Artifact generation not found', 404);
  return artifactStatus(job);
}

/** A generation whose runner stopped (the app restarted) continues from its last stage. */
export async function resumeTutorArtifact(
  storage: GlossaryStorage,
  id: string,
  services: TutorArtifactServices,
  retry = false,
) {
  const claimed = await storage.transaction(async (tx) => {
    const job = await tx.get<TutorArtifactJob>(jobKey(id));
    if (!job) throw new TutorArtifactError('Artifact generation not found', 404);
    const stalled =
      job.status !== 'ready' && job.status !== 'failed' && (job.until || 0) < Date.now();
    if (!stalled && !(retry && job.status === 'failed')) return { job, start: false };
    const next: TutorArtifactJob = {
      ...job,
      status: job.status === 'failed' ? (job.plan ? 'writing' : 'planning') : job.status,
      owner: services.owner,
      until: Date.now() + LEASE,
      updatedAt: new Date().toISOString(),
    };
    delete next.error;
    await tx.put(jobKey(id), next);
    return { job: next, start: true };
  });
  if (claimed.start) services.start(run(storage, claimed.job, services));
  return artifactStatus(claimed.job);
}

/** Saves progress only while this runner still owns the generation. */
async function progress(
  storage: GlossaryStorage,
  job: TutorArtifactJob,
  patch: Partial<TutorArtifactJob>,
) {
  return storage.transaction(async (tx) => {
    const saved = await tx.get<TutorArtifactJob>(jobKey(job.id));
    if (!saved || saved.owner !== job.owner) return null;
    const next = {
      ...saved,
      ...patch,
      until: Date.now() + LEASE,
      updatedAt: new Date().toISOString(),
    };
    await tx.put(jobKey(job.id), next);
    return next;
  });
}

async function run(
  storage: GlossaryStorage,
  initial: TutorArtifactJob,
  services: TutorArtifactServices,
) {
  let job: TutorArtifactJob | null = initial;
  const fire = (
    phase: 'plan' | 'write' | 'chapter' | 'check' | 'ready' | 'failed',
    chapterIndex?: number,
    error?: string,
  ) => {
    try {
      if (job)
        services.emit?.(phase, {
          job,
          ...(chapterIndex !== undefined ? { chapterIndex } : {}),
          ...(error ? { error } : {}),
        });
    } catch {}
  };
  try {
    const sources = await materials(storage, job.request);
    const previous = job.request.artifactId ? await services.previous(job.fileId) : null;
    if (job.status === 'planning') {
      fire('plan');
      const plan = await services.plan(job, sources, previous?.markdown || null);
      job = await progress(storage, job, {
        plan,
        title: plan.title,
        chapters: plan.chapters.map(() => null),
        status: 'writing',
      });
      if (!job) return;
    }
    const plan = job.plan!;
    if (job.status === 'writing') {
      fire('write');
      // Chapters are written in parallel; each is saved as soon as it is ready.
      await Promise.all(
        plan.chapters.map(async (_, index) => {
          if (job!.chapters[index] !== null) return;
          const markdown = await services.chapter(job!, plan, index, sources);
          await storage.transaction(async (tx) => {
            const saved = await tx.get<TutorArtifactJob>(jobKey(initial.id));
            if (!saved || saved.owner !== initial.owner) return;
            saved.chapters[index] = markdown;
            saved.until = Date.now() + LEASE;
            saved.updatedAt = new Date().toISOString();
            await tx.put(jobKey(initial.id), saved);
          });
          fire('chapter', index);
        }),
      );
      job = await progress(storage, job, { status: 'checking' });
      if (!job) return;
    }
    if (job.status === 'checking') {
      fire('check');
      const ids = materialIds(sources);
      // One repair round for each chapter with problems; whatever remains is cleaned on assembly.
      const chapters = await Promise.all(
        job.chapters.map(async (markdown, index) => {
          const issues = chapterIssues(markdown!, plan.chapters[index].title, ids);
          return issues.length
            ? services
                .chapter(job!, plan, index, sources, { markdown: markdown!, issues })
                .catch(() => markdown!)
            : markdown!;
        }),
      );
      job = await progress(storage, job, { chapters, status: 'saving' });
      if (!job) return;
    }
    if (job.status === 'saving') {
      const document = assembleArtifact(plan, job.chapters as string[], sources, job.request);
      const version = await services.save(job, document);
      job = await progress(storage, job, { status: 'ready', version });
      fire('ready');
    }
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'Artifact generation failed').slice(
      0,
      500,
    );
    if (job) await progress(storage, job, { status: 'failed', error: message });
    fire('failed', undefined, message);
  }
}
