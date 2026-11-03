import { z } from 'zod';
import {
  conversationSchema,
  migrateConversations,
  type Conversation,
} from '../shared/conversations';
import { sourceState } from '../shared/directories';
import {
  reviewSummary,
  type StudySession,
  type Source,
  type Directory,
  type Learning,
  type Attempt,
  type Settings,
} from '../shared/domain';
import {
  tutorTurnInputSchema,
  turnActionSchema,
  turnInputFingerprint,
  tutorFingerprint,
  type TutorTurnInput,
  type TurnIntent,
  type ConversationDetail,
} from '../shared/tutor-turns';
import { loadTutorConcepts } from './tutor-context';
import { attachmentMention, attachmentSourceIds } from '../shared/tutor-attachments';
import { readQuestionAttachments, attachmentImagesData } from './tutor-attachments';
import { resolveTutorGeneration } from '../shared/tutor-generation';
import { TutorObjects, TutorJournalError } from './tutor-journal';
import type { FrozenTutorContext } from './tutor-runner';
import type { ProjectId } from '../shared/projects';
import { deleteKeys, purgePrefix } from './purge';

export function coordinator(env: Env, id: string) {
  return env.TUTOR.getByName(id);
}
function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: string; status: number },
): T {
  if (!result.ok) throw new TutorJournalError(result.error, result.status);
  return result.value;
}
export async function conversationDetail(
  env: Env,
  conversation: Conversation,
): Promise<ConversationDetail> {
  const snapshot = unwrap(await coordinator(env, conversation.id).snapshot());
  return snapshot
    ? {
        ...conversation,
        ...snapshot,
        updatedAt:
          snapshot.updatedAt > conversation.updatedAt ? snapshot.updatedAt : conversation.updatedAt,
      }
    : { ...conversation, pending: false };
}
export async function conversationSnapshot(
  storage: DurableObjectStorage,
  sessions: StudySession[],
  enrich?: (value: Conversation) => Promise<Conversation>,
) {
  const existing = await storage.list<Conversation>({ prefix: 'conversation:' });
  for (const session of sessions) {
    for (const migrated of migrateConversations(session)) {
      const key = `conversation:${migrated.id}`;
      if (!existing.has(key)) {
        const saved = await storage.transaction(async (transaction) => {
          const current = await transaction.get<Conversation>(key);
          if (current) return current;
          await transaction.put(key, migrated);
          return migrated;
        });
        existing.set(key, saved);
      }
    }
  }
  return Promise.all(
    [...existing.values()].map((value) => {
      const parsed = conversationSchema.parse(value);
      return enrich ? enrich(parsed) : parsed;
    }),
  );
}

/**
 * Deletes a conversation for good: its journal, its stored replies, and the actions and
 * artifact requests it made. Artifacts it already added to the library stay. A conversation
 * still answering a question is kept until that reply stops.
 */
export async function deleteConversation(
  env: Env,
  storage: DurableObjectStorage,
  conversation: Conversation,
) {
  if ((await conversationDetail(env, conversation)).pending)
    throw new TutorJournalError(`Stop the reply in "${conversation.name}" before deleting it`);
  const owned = async (prefix: string) =>
    [...(await storage.list<{ conversationId?: string }>({ prefix })).entries()]
      .filter(([, value]) => value.conversationId === conversation.id)
      .map(([key]) => key);
  await deleteKeys(storage, [
    ...(await owned('tutor-action:')),
    ...(await owned('tutor-artifact-job:')),
  ]);
  await coordinator(env, conversation.id).purge();
  await purgePrefix(env, `tutor/${encodeURIComponent(conversation.id)}/`);
  await storage.delete(`conversation:${conversation.id}`);
}

export async function assessmentConversations(
  env: Env,
  storage: DurableObjectStorage,
  sessionId: string,
  sourceIds: string[],
) {
  const headers = [
    ...(await storage.list<Conversation>({ prefix: 'conversation:' })).values(),
  ].filter((value) => value.sessionId === sessionId);
  return Promise.all(
    headers.map(async (header) => {
      const snapshot = unwrap(
        await coordinator(env, header.id).linkedMessages(sourceIds, header.sourceIds),
      );
      return snapshot ? { ...header, ...snapshot } : header;
    }),
  );
}

async function prepareIntent(
  env: Env,
  storage: DurableObjectStorage,
  conversation: Conversation,
  input: TutorTurnInput,
  requestFingerprint: string,
  settings: Settings,
): Promise<TurnIntent> {
  if (!settings.configured) throw new TutorJournalError('Add a Meta API key in Settings');
  const generation = resolveTutorGeneration(input.generation, settings.model);
  const references = input.references || conversation.sourceIds;
  const directories = [...(await storage.list<Directory>({ prefix: 'directory:' })).values()];
  const materials: Learning[] = [],
    sources = new Map<string, Source>();
  for (const id of references) {
    const source = await storage.get<Source>(`file:${id}`);
    if (!source || sourceState(source, directories) === 'trash')
      throw new TutorJournalError('Restore or remove a deleted reference before sending');
    sources.set(id, source);
    const learning = await storage.get<Learning>(`learning:${id}`);
    if (
      (!learning || learning.sourceVersion !== source.version) &&
      input.context?.sourceId === id &&
      input.context.location.quote
    )
      continue;
    if (!learning || learning.sourceVersion !== source.version)
      throw new TutorJournalError(`Prepare the reference first: ${source.name}`);
    materials.push(learning);
  }
  let context = input.context;
  const sourceIds = [...references];
  if (context) {
    const source = await storage.get<Source>(`file:${context.sourceId}`);
    if (
      !source ||
      sourceState(source, directories) === 'trash' ||
      source.version !== context.sourceVersion
    )
      throw new TutorJournalError(
        'The question source changed or is unavailable. Select the passage again.',
      );
    context = { ...context, sourceName: source.name };
    sources.set(source.id, source);
    if (!sourceIds.includes(source.id)) {
      if (sourceIds.length >= 20)
        throw new TutorJournalError(
          'Remove a reference before attaching another question source (20 maximum)',
        );
      sourceIds.push(source.id);
    }
    if (!materials.some((material) => material.sourceId === source.id)) {
      const learning = await storage.get<Learning>(`learning:${source.id}`);
      if (learning?.sourceVersion === source.version) materials.push(learning);
      else if (!context.location.quote)
        throw new TutorJournalError(
          `Select a passage or prepare this source first: ${source.name}`,
        );
    }
  }
  const glossary = await loadTutorConcepts(storage, input.concepts, materials);
  const attachments = await readQuestionAttachments(
    storage,
    conversation.sessionId,
    input.attachments,
  );
  const attachedContent = await Promise.all(
    attachments.map(async (item) => ({
      ...item,
      imagesData: await attachmentImagesData(env.FILES, item.attachment),
    })),
  );
  for (const { attachment } of attachments)
    for (const id of attachmentSourceIds(attachment))
      if (!sourceIds.includes(id)) sourceIds.push(id);
  if (sourceIds.length > 20)
    throw new TutorJournalError(
      'The question has more than 20 source origins. Remove a reference or attachment before sending.',
    );
  const attempts = [...(await storage.list<Attempt>({ prefix: 'attempt:' })).values()].filter(
    (attempt) => sourceIds.includes(attempt.sourceId),
  );
  const frozen: FrozenTutorContext = {
    model: generation.model,
    reasoningEffort: generation.reasoningEffort,
    learning: materials,
    review: reviewSummary(attempts),
    concepts: glossary.concepts,
    attachments: attachedContent,
    context,
    canCreateBookmark: true,
    canSaveArtifact: true,
    canSaveConcept: true,
    canCreateArtifact: true,
    canManageLibrary: true,
    ...(input.webSearch ? { webSearch: true } : settings.webAuto ? { webAuto: true } : {}),
  };
  const objects = new TutorObjects(
    {
      read: async (key) => (await env.FILES.get(key))?.text() || null,
      write: async (key, text) => {
        await env.FILES.put(key, text, { httpMetadata: { contentType: 'application/json' } });
      },
    },
    conversation.id,
  );
  const contextObject = await objects.put(frozen);
  const scopedSources = await Promise.all(
    [...sources.values()].map(async (source) => ({
      id: source.id,
      version: source.version,
      prepared: await tutorFingerprint({
        learning: materials.find((item) => item.sourceId === source.id) || null,
        concepts: glossary.concepts.filter((item) => item.scope === 'source'),
      }),
    })),
  );
  const permanentReferences = await Promise.all(
    scopedSources
      .filter((source) => references.includes(source.id))
      .map(async (source) => ({
        ...source,
        prepared: await tutorFingerprint({
          learning: materials.find((item) => item.sourceId === source.id) || null,
          concepts: glossary.concepts
            .filter((item) =>
              item.entry.sources.some(
                (origin) =>
                  origin.sourceId === source.id && origin.sourceVersion === source.version,
              ),
            )
            .map((item) => ({ id: item.entry.id, version: item.entry.version }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        }),
      })),
  );
  return {
    input,
    generation,
    contextObject,
    scope: {
      ...(input.webSearch ? { webSearch: true } : {}),
      references: scopedSources,
      permanentReferences,
      context,
      concepts: input.concepts,
      attachments: input.attachments,
      ...(input.mentions && input.mentions.length ? { mentions: input.mentions } : {}),
    },
    userMessage: {
      role: 'user',
      content: input.prompt,
      requestId: input.requestId,
      requestFingerprint,
      generation,
      sourceIds,
      ...(input.webSearch ? { webSearch: true } : {}),
      ...(context ? { context } : {}),
      ...(glossary.mentions.length ? { concepts: glossary.mentions } : {}),
      ...(attachments.length
        ? { attachments: attachments.map((item) => attachmentMention(item.attachment)) }
        : {}),
      ...(input.mentions && input.mentions.length ? { mentions: input.mentions } : {}),
    },
  };
}

export async function conversationRoute({
  request,
  env,
  storage,
  body,
  settings,
  project = 'default',
}: {
  request: Request;
  env: Env;
  storage: DurableObjectStorage;
  body: () => Promise<unknown>;
  settings: () => Promise<Settings>;
  executionId: string;
  project?: ProjectId;
}): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;
  const sessionMatch = path.match(/^\/api\/sessions\/([a-f0-9-]+)\/conversations$/);
  const match = path.match(
    /^\/api\/conversations\/([\w-]+)(\/messages|\/turns(?:\/([a-f0-9-]+)(\/attempts)?)?)?$/,
  );
  if (!sessionMatch && !match) return null;
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  if (sessionMatch) {
    const session = await storage.get<StudySession>(`session:${sessionMatch[1]}`);
    if (!session) return json({ error: 'Session not found' }, 404);
    const threads = await conversationSnapshot(storage, [session], (value) =>
      conversationDetail(env, value),
    );
    if (request.method === 'GET')
      return json(threads.filter((item) => item.sessionId === session.id));
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const input = z
      .object({
        /** The id the app gave the conversation while it was a draft; repeating it is harmless. */
        id: z.string().uuid().optional(),
        name: z.string().trim().min(1).max(160),
        sourceIds: z.array(z.string().uuid()).max(20).default([]),
        pausedSourceIds: z.array(z.string().uuid()).max(20).optional(),
      })
      .parse(await body());
    if (input.id) {
      const existing = await storage.get<Conversation>(`conversation:${input.id}`);
      if (existing?.sessionId === session.id)
        return json(threads.find((item) => item.id === existing.id) || existing);
      if (existing) return json({ error: 'Conversation belongs to another session' }, 409);
    }
    if (threads.filter((item) => item.sessionId === session.id).length >= 100)
      return json({ error: 'Conversation limit reached for this session (100)' }, 409);
    for (const id of input.sourceIds)
      if (!(await storage.get(`file:${id}`))) return json({ error: 'Reference not found' }, 404);
    const created = conversationSchema.parse({
      ...input,
      id: input.id || crypto.randomUUID(),
      sessionId: session.id,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await storage.put(`conversation:${created.id}`, created);
    return json({ ...created, pending: false }, 201);
  }
  const key = `conversation:${match![1]}`,
    conversation = await storage.get<Conversation>(key);
  if (!conversation) return json({ error: 'Conversation not found' }, 404);
  const actor = coordinator(env, conversation.id);
  const before = url.searchParams.has('before')
    ? Number(url.searchParams.get('before'))
    : undefined;
  if (before !== undefined && (!Number.isInteger(before) || before < 1))
    return json({ error: 'Invalid history cursor' }, 400);
  if (match![2] === '/messages' && request.method === 'GET') {
    if (unwrap(await actor.snapshot())) return json(unwrap(await actor.history(before)));
    const end = before ?? conversation.messages.length + 1;
    if (end > conversation.messages.length + 1)
      return json({ error: 'Invalid history cursor' }, 400);
    const start = Math.max(1, end - 50);
    return json({
      messages: conversation.messages.slice(start - 1, end - 1),
      messageCount: conversation.messages.length,
      historyCursor: start > 1 ? String(start) : null,
    });
  }
  if (match![4])
    return request.method === 'GET'
      ? json(unwrap(await actor.attempts(match![3], before)))
      : json({ error: 'Method not allowed' }, 405);
  if (match![3] && request.method === 'GET') {
    const receipt = unwrap(await actor.turn(match![3]));
    if (receipt) return json({ accepted: true, requestId: match![3], ...receipt });
    const original = conversation.messages.find(
      (message) => message.role === 'user' && message.requestId === match![3],
    );
    if (
      original &&
      conversation.messages.some(
        (message) => message.role === 'assistant' && message.requestId === match![3],
      )
    )
      return json({
        accepted: true,
        requestId: match![3],
        acceptanceFingerprint: original.requestFingerprint,
      });
    return json({ error: 'Question not found' }, 404);
  }
  if (match![3] && ['POST', 'PATCH'].includes(request.method)) {
    const action = turnActionSchema.parse(await body());
    return json(unwrap(await actor.action(match![3], action)));
  }
  if (!match![2]) {
    if (request.method === 'GET') return json(await conversationDetail(env, conversation));
    if (request.method === 'DELETE') {
      await deleteConversation(env, storage, conversation);
      // A conversation brought over from an older session record would otherwise come back.
      if (conversation.id.startsWith('history-'))
        await storage.transaction(async (tx) => {
          const session = await tx.get<StudySession>(`session:${conversation.sessionId}`);
          const sourceId = conversation.sourceIds[0];
          if (!session?.conversations?.[sourceId]) return;
          const { [sourceId]: _removed, ...rest } = session.conversations;
          await tx.put(`session:${session.id}`, { ...session, conversations: rest });
        });
      return json({ deleted: true });
    }
    if (request.method !== 'PATCH') return json({ error: 'Method not allowed' }, 405);
    const input = z
      .object({
        name: z.string().trim().min(1).max(160).optional(),
        sourceIds: z
          .array(z.string().uuid())
          .max(20)
          .refine((ids) => new Set(ids).size === ids.length)
          .optional(),
        pausedSourceIds: z.array(z.string().uuid()).max(20).optional(),
      })
      .parse(await body());
    for (const id of input.sourceIds || [])
      if (!(await storage.get(`file:${id}`))) return json({ error: 'Reference not found' }, 404);
    const next = await storage.transaction(async (transaction) => {
      const current = (await transaction.get<Conversation>(key))!;
      const value = { ...current, ...input, updatedAt: new Date().toISOString() };
      // A paused reference must still be one of the conversation's references.
      value.pausedSourceIds = [
        ...new Set((value.pausedSourceIds || []).filter((id) => value.sourceIds.includes(id))),
      ];
      await transaction.put(key, value);
      return value;
    });
    return json(await conversationDetail(env, next));
  }
  if (match![2] !== '/turns') return json({ error: 'Method not allowed' }, 405);
  if (request.method === 'GET') return json(unwrap(await actor.turns(before)));
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const input = tutorTurnInputSchema.parse(await body()),
    fingerprint = await turnInputFingerprint(input);
  const completed = conversation.messages.some(
    (m) => m.role === 'assistant' && m.requestId === input.requestId,
  );
  if (completed) {
    const original = conversation.messages.find(
      (m) => m.role === 'user' && m.requestId === input.requestId,
    );
    if (original?.requestFingerprint && original.requestFingerprint !== fingerprint)
      throw new TutorJournalError(
        'This request ID was already used for different question context or generation settings',
      );
    return json({
      ...(await conversationDetail(env, conversation)),
      acceptedRequestId: input.requestId,
    });
  }
  if (!unwrap(await actor.receipt(input.requestId, fingerprint))) {
    const intent = await prepareIntent(
      env,
      storage,
      conversation,
      input,
      fingerprint,
      await settings(),
    );
    unwrap(await actor.seed(conversation, project));
    unwrap(await actor.accept(intent, fingerprint));
  }
  return json(
    { ...(await conversationDetail(env, conversation)), acceptedRequestId: input.requestId },
    202,
  );
}
