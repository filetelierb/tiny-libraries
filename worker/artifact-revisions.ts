import type { Learning } from '../shared/domain';
import {
  artifactEditSchema,
  editedArtifact,
  revisionKey,
  revisionPrefix,
  revisionSummary,
  type ArtifactRevision,
} from '../shared/artifact-revisions';
import type { GlossaryStorage, GlossaryStore } from './glossary';

export class ArtifactRevisionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Artifacts prepared before revisions existed count as an implicit first, generated revision. */
async function stored(tx: GlossaryStore, sourceId: string) {
  const revisions = [
    ...(await tx.list<ArtifactRevision>({ prefix: revisionPrefix(sourceId) })).values(),
  ];
  if (revisions.length) return revisions;
  const learning = await tx.get<Learning>(`learning:${sourceId}`);
  return learning?.synthesis.artifact
    ? [
        {
          sourceId,
          sourceVersion: learning.sourceVersion,
          revision: 1,
          origin: 'generated',
          createdAt: learning.createdAt,
          artifact: learning.synthesis.artifact,
        } satisfies ArtifactRevision,
      ]
    : [];
}

export async function latestArtifact(tx: GlossaryStore, learning: Learning) {
  if (!learning.synthesis.artifact) return null;
  return (await stored(tx, learning.sourceId)).at(-1)!;
}

export async function listRevisions(tx: GlossaryStore, sourceId: string) {
  return (await stored(tx, sourceId)).map(revisionSummary).reverse();
}

export async function getRevision(tx: GlossaryStore, sourceId: string, revision: number) {
  const value = (await stored(tx, sourceId)).find((item) => item.revision === revision);
  if (!value) throw new ArtifactRevisionError('Artifact version not found', 404);
  return value;
}

/** A new preparation becomes the next version, so earlier edits stay in the history. */
export async function recordGenerated(tx: GlossaryStore, learning: Learning) {
  if (!learning.synthesis.artifact) return;
  const existing = await tx.list<ArtifactRevision>({ prefix: revisionPrefix(learning.sourceId) });
  const revision = existing.size + 1;
  await tx.put(revisionKey(learning.sourceId, revision), {
    sourceId: learning.sourceId,
    sourceVersion: learning.sourceVersion,
    revision,
    origin: 'generated',
    createdAt: learning.createdAt,
    artifact: learning.synthesis.artifact,
  } satisfies ArtifactRevision);
}

export async function saveEdit(storage: GlossaryStorage, sourceId: string, body: unknown) {
  const input = artifactEditSchema.parse(body);
  return storage.transaction(async (tx) => {
    const learning = await tx.get<Learning>(`learning:${sourceId}`);
    if (!learning?.synthesis.artifact)
      throw new ArtifactRevisionError('This source has no artifact to edit', 404);
    const revisions = await stored(tx, sourceId),
      head = revisions.at(-1)!;
    if (head.revision !== input.expectedRevision)
      throw new ArtifactRevisionError(
        'A newer version of this artifact was saved. Reload it before saving again.',
        409,
      );
    let artifact;
    try {
      artifact = editedArtifact(
        head.artifact,
        input.artifact,
        learning.segments.map((segment) => segment.id),
      );
    } catch (error) {
      throw new ArtifactRevisionError((error as Error).message, 422);
    }
    // Materialize the implicit first version so history survives the edit.
    for (const item of revisions) await tx.put(revisionKey(sourceId, item.revision), item);
    const saved: ArtifactRevision = {
      sourceId,
      sourceVersion: learning.sourceVersion,
      revision: head.revision + 1,
      origin: 'edited',
      createdAt: new Date().toISOString(),
      artifact,
    };
    await tx.put(revisionKey(sourceId, saved.revision), saved);
    return saved;
  });
}

export async function deleteRevisions(tx: GlossaryStore, sourceId: string) {
  for (const key of (await tx.list({ prefix: revisionPrefix(sourceId) })).keys())
    await tx.delete(key);
}
