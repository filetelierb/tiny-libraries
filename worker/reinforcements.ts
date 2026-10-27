import { z } from 'zod';
import {
  fold,
  publicLearning,
  type Attempt,
  type Directory,
  type Learning,
  type Settings,
  type Source,
  type StudySession,
} from '../shared/domain';
import { sourceState } from '../shared/directories';
import { stableAnnotationId } from '../shared/annotations';
import {
  publicReinforcement,
  validateReinforcement,
  type Reinforcement,
  type ReinforcementContext,
  type ReinforcementPlan,
} from '../shared/review';
import type { GlossaryStorage, GlossaryStore } from './glossary';

export class ReinforcementError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
type Stored = Reinforcement & {
  fingerprint: string;
  owner: string;
  operation: string;
  until: number;
};
const recordKey = (id: string) => `reinforcement:${id}`;
async function available(tx: GlossaryStore, id: string, version?: number) {
  const source = await tx.get<Source>(`file:${id}`),
    directories = [...(await tx.list<Directory>({ prefix: 'directory:' })).values()];
  if (
    !source ||
    (version && source.version !== version) ||
    sourceState(source, directories) === 'trash'
  )
    throw new ReinforcementError(
      'This source is unavailable. Restore it before requesting reinforcement.',
      409,
    );
  return source;
}
async function observedContext(
  tx: GlossaryStore,
  sourceId: string,
  attemptIds: string[],
): Promise<ReinforcementContext> {
  const source = await available(tx, sourceId),
    learning = await tx.get<Learning>(`learning:${sourceId}`);
  if (!learning || learning.sourceVersion !== source.version)
    throw new ReinforcementError('Prepare this source before requesting reinforcement.', 409);
  const attempts: Attempt[] = [];
  for (const id of attemptIds) {
    const attempt = await tx.get<Attempt>(`attempt:${id}`);
    if (
      !attempt ||
      attempt.sourceId !== sourceId ||
      attempt.sourceVersion !== source.version ||
      attempt.learningVersion !== learning.createdAt ||
      attempt.correct ||
      attempt.pendingReview
    )
      throw new ReinforcementError(
        'Choose recorded incorrect answers from the current source preparation. Earlier or ambiguous results remain available in history.',
        409,
      );
    const question =
      attempt.question ||
      publicLearning(learning)
        .synthesis.chapters.flatMap((c) => c.questions)
        .find((q) => q.id === attempt.questionId);
    if (!question)
      throw new ReinforcementError('The recorded question is unavailable for this attempt.', 409);
    attempts.push({ ...attempt, question });
  }
  if (new Set(attempts.map((a) => fold(a.concept))).size !== 1)
    throw new ReinforcementError('Choose attempts for one concept at a time.');
  const ids = new Set(attempts.flatMap((a) => a.segmentIds)),
    segments = learning.segments.filter((s) => ids.has(s.id));
  if (segments.length !== ids.size || !segments.length)
    throw new ReinforcementError('Recorded source evidence is unavailable.', 409);
  const context = {
    sourceId,
    sourceVersion: source.version,
    sourceName: source.name,
    learningVersion: learning.createdAt,
    concept: attempts[0].concept,
    attempts,
    segments,
  };
  if (JSON.stringify(context).length > 75000)
    throw new ReinforcementError(
      'Select fewer attempts with smaller source excerpts for one reinforcement.',
      413,
    );
  return context;
}
export async function reinforcementSnapshot(storage: GlossaryStorage, owner: string) {
  return storage.transaction(async (tx) => {
    const values = [...(await tx.list<Stored>({ prefix: 'reinforcement:' })).values()];
    const result = [];
    for (let record of values) {
      if (record.status === 'running' && (record.owner !== owner || record.until < Date.now())) {
        record = {
          ...record,
          status: 'interrupted',
          error: 'Reinforcement creation was interrupted. Retry to recover it.',
        };
        await tx.put(recordKey(record.id), record);
      }
      const { fingerprint: _f, owner: _o, operation: _p, until: _u, ...value } = record;
      result.push(publicReinforcement(value));
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  });
}
export async function startReinforcement(
  storage: GlossaryStorage,
  raw: unknown,
  options: {
    owner: string;
    settings: Settings;
    start: (task: Promise<void>) => void;
    generate: (
      context: ReinforcementContext,
      locale: Settings['locale'],
      model: string,
    ) => Promise<ReinforcementPlan>;
  },
) {
  const input = z
    .object({
      requestId: z.string().uuid(),
      sessionId: z.string().uuid(),
      sourceId: z.string().uuid(),
      attemptIds: z.array(z.string().uuid()).min(1).max(20),
    })
    .parse(raw);
  if (new Set(input.attemptIds).size !== input.attemptIds.length)
    throw new ReinforcementError('Remove duplicate attempts.');
  const fingerprint = JSON.stringify({ ...input, attemptIds: [...input.attemptIds].sort() });
  const groupId = await stableAnnotationId(
    `reinforcement:${input.sourceId}:${fold((await storage.get<Attempt>(`attempt:${input.attemptIds[0]}`))?.concept || '')}`,
  );
  const reserved = await storage.transaction(async (tx) => {
    const previous = await tx.get<Stored>(recordKey(input.requestId));
    if (previous && previous.fingerprint !== fingerprint)
      throw new ReinforcementError(
        'This request ID already belongs to different reinforcement evidence.',
        409,
      );
    if (
      previous?.status === 'ready' ||
      (previous?.status === 'running' &&
        previous.owner === options.owner &&
        previous.until > Date.now())
    )
      return null;
    if (!options.settings.configured)
      throw new ReinforcementError('Add a Meta API key in Settings to create reinforcement.', 409);
    if (!(await tx.get<StudySession>(`session:${input.sessionId}`)))
      throw new ReinforcementError('Study session not found.', 404);
    const context = previous || (await observedContext(tx, input.sourceId, input.attemptIds));
    await available(tx, context.sourceId, context.sourceVersion);
    const existing = [...(await tx.list<Stored>({ prefix: 'reinforcement:' })).values()].filter(
      (r) => r.groupId === groupId,
    );
    if (
      !previous &&
      existing.some(
        (r) => r.status === 'running' && r.owner === options.owner && r.until > Date.now(),
      )
    )
      throw new ReinforcementError(
        'A reinforcement for this concept is still being created. Open it from the saved list.',
        409,
      );
    const record: Stored = {
      ...context,
      id: input.requestId,
      sessionId: input.sessionId,
      groupId: previous?.groupId || groupId,
      version: previous?.version || Math.max(0, ...existing.map((r) => r.version)) + 1,
      createdAt: previous?.createdAt || new Date().toISOString(),
      locale: previous?.locale || options.settings.locale,
      model: previous?.model || options.settings.model,
      status: 'running',
      plan: null,
      fingerprint,
      owner: options.owner,
      operation: crypto.randomUUID(),
      until: Date.now() + 600000,
    };
    delete record.error;
    await tx.put(recordKey(record.id), record);
    return record;
  });
  if (reserved)
    options.start(
      (async () => {
        try {
          const plan = validateReinforcement(
            await options.generate(reserved, reserved.locale, reserved.model),
            reserved,
          );
          plan.questions = plan.questions.map((q) => ({
            ...q,
            id: `${reserved.id}:v${reserved.version}:${q.id}`,
          }));
          const ready: Stored = { ...reserved, status: 'ready', plan };
          if (new TextEncoder().encode(JSON.stringify(ready)).length > 120000)
            throw new ReinforcementError(
              'The generated reinforcement exceeds its saved-result limit. Retry with fewer attempts.',
              413,
            );
          await storage.transaction(async (tx) => {
            await available(tx, reserved.sourceId, reserved.sourceVersion);
            const current = await tx.get<Stored>(recordKey(reserved.id));
            if (current?.operation === reserved.operation && current.status === 'running')
              await tx.put(recordKey(ready.id), ready);
          });
        } catch (error) {
          await storage.transaction(async (tx) => {
            const current = await tx.get<Stored>(recordKey(reserved.id));
            if (current?.operation === reserved.operation && current.status === 'running')
              await tx.put(recordKey(current.id), {
                ...current,
                status: 'failed',
                error:
                  error instanceof Error
                    ? error.message.slice(0, 500)
                    : 'Reinforcement creation failed. Retry to continue.',
              });
          });
        }
      })(),
    );
  return (await reinforcementSnapshot(storage, options.owner)).find(
    (r) => r.id === input.requestId,
  )!;
}
