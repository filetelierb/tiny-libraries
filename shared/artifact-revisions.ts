import { z } from 'zod';
import { artifactSchema, type Artifact } from './domain';

export type ArtifactRevision = {
  sourceId: string;
  sourceVersion: number;
  revision: number;
  origin: 'generated' | 'edited';
  createdAt: string;
  artifact: Artifact;
};
export type ArtifactRevisionSummary = Omit<ArtifactRevision, 'artifact'> & { title: string };
export const artifactEditSchema = z.object({
  expectedRevision: z.number().int().positive(),
  artifact: artifactSchema,
});

export const revisionPrefix = (sourceId: string) => `artifact-revision:${sourceId}:`;
// Zero padding keeps storage listing order equal to revision order.
export const revisionKey = (sourceId: string, revision: number) =>
  `${revisionPrefix(sourceId)}${String(revision).padStart(6, '0')}`;

export function revisionSummary({ artifact, ...revision }: ArtifactRevision) {
  return { ...revision, title: artifact.title } satisfies ArtifactRevisionSummary;
}

/**
 * Students may reword and restructure an artifact, but not change what it is or cite
 * evidence its source does not contain; generated parameters stay as generated.
 */
export function editedArtifact(base: Artifact, next: Artifact, segmentIds: string[]): Artifact {
  if (next.kind !== base.kind) throw new Error('An edit cannot change the artifact type.');
  if (!next.title.trim() || !next.explanation.trim())
    throw new Error('Give the artifact a title and some content.');
  const known = new Set(segmentIds);
  if (next.segmentIds.some((id) => !known.has(id)))
    throw new Error('An edit can only cite passages from its source.');
  return {
    ...base,
    title: next.title.trim(),
    explanation: next.explanation.trim(),
    segmentIds: next.segmentIds,
  } as Artifact;
}
