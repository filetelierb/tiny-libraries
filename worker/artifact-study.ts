import type { Learning } from '../shared/domain';
import {
  artifactChapters,
  artifactStudyKey,
  publicArtifactStudy,
  validateArtifactStudy,
  type ArtifactStudy,
  type ArtifactStudyPlan,
  type ArtifactStudySnapshot,
} from '../shared/artifact-study';
import { latestArtifact } from './artifact-revisions';
import type { GlossaryStorage, GlossaryStore } from './glossary';

const LEASE = 5 * 60 * 1000;

async function current(tx: GlossaryStore, sourceId: string) {
  const learning = await tx.get<Learning>(`learning:${sourceId}`);
  const latest = learning && (await latestArtifact(tx, learning));
  return learning && latest ? { learning, latest } : null;
}

/** The study material of the artifact's latest version; older generations count as pending. */
export async function artifactStudySnapshot(
  tx: GlossaryStore,
  sourceId: string,
): Promise<ArtifactStudySnapshot> {
  const material = await current(tx, sourceId);
  if (!material || !artifactChapters(material.latest.artifact.explanation).length)
    return { status: 'unavailable', revision: material?.latest.revision ?? null };
  const record = await tx.get<ArtifactStudy>(artifactStudyKey(sourceId));
  if (!record || record.revision !== material.latest.revision)
    return { status: 'pending', revision: material.latest.revision };
  if (record.status === 'generating' && (record.until || 0) < Date.now())
    return {
      ...publicArtifactStudy(record),
      status: 'failed',
      error: 'Generation was interrupted.',
    };
  return publicArtifactStudy(record);
}

/** Generates (or retries) chapter questions and cards for the latest artifact version. */
export async function startArtifactStudy(
  storage: GlossaryStorage,
  sourceId: string,
  options: {
    owner: string;
    start: (task: Promise<unknown>) => void;
    generate: (
      learning: Learning,
      chapters: ReturnType<typeof artifactChapters>,
    ) => Promise<ArtifactStudyPlan>;
  },
) {
  const claimed = await storage.transaction(async (tx) => {
    const material = await current(tx, sourceId);
    const chapters = material ? artifactChapters(material.latest.artifact.explanation) : [];
    if (!material || !chapters.length) return null;
    const existing = await tx.get<ArtifactStudy>(artifactStudyKey(sourceId));
    if (
      existing?.revision === material.latest.revision &&
      (existing.status === 'ready' ||
        (existing.status === 'generating' && (existing.until || 0) > Date.now()))
    )
      return null;
    const record: ArtifactStudy = {
      sourceId,
      revision: material.latest.revision,
      status: 'generating',
      version: `artifact:${material.latest.revision}:${crypto.randomUUID()}`,
      chapters: [],
      owner: options.owner,
      until: Date.now() + LEASE,
    };
    await tx.put(artifactStudyKey(sourceId), record);
    return { record, learning: material.learning, chapters };
  });
  if (claimed) {
    const { record, learning, chapters } = claimed;
    options.start(
      (async () => {
        let next: ArtifactStudy;
        try {
          const plan = await options.generate(learning, chapters);
          next = {
            ...record,
            status: 'ready',
            chapters: validateArtifactStudy(plan, chapters, learning.segments, record.revision),
          };
        } catch (error) {
          next = {
            ...record,
            status: 'failed',
            error: error instanceof Error ? error.message : 'Generation failed.',
          };
        }
        delete next.owner;
        delete next.until;
        // A newer generation may have replaced this one meanwhile; never overwrite it.
        await storage.transaction(async (tx) => {
          const saved = await tx.get<ArtifactStudy>(artifactStudyKey(sourceId));
          if (saved?.version === record.version) await tx.put(artifactStudyKey(sourceId), next);
        });
      })(),
    );
  }
  return artifactStudySnapshot(storage, sourceId);
}

/** The stored question an artifact chapter attempt answers, with its grading context. */
export async function artifactQuestion(
  tx: GlossaryStore,
  sourceId: string,
  input: { chapterId?: string; questionId: string; learningVersion?: string },
) {
  const material = await current(tx, sourceId),
    record = await tx.get<ArtifactStudy>(artifactStudyKey(sourceId));
  const chapter = record?.chapters.find((item) => item.id === input.chapterId);
  const question = chapter?.questions.find((item) => item.id === input.questionId);
  if (
    !material ||
    !record ||
    record.status !== 'ready' ||
    record.revision !== material.latest.revision ||
    (input.learningVersion && input.learningVersion !== record.version) ||
    !chapter ||
    !question
  )
    return null;
  return {
    question,
    chapter: { id: chapter.id },
    learning: {
      sourceVersion: material.learning.sourceVersion,
      createdAt: record.version,
      segments: material.learning.segments,
    },
  };
}

export async function deleteArtifactStudy(tx: GlossaryStore, sourceId: string) {
  await tx.delete(artifactStudyKey(sourceId));
}
