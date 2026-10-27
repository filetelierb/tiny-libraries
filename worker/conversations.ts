import { z } from 'zod';
import {
  conversationSchema,
  questionContextSchema,
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
import { runAssistant, bridgedFetch } from './meta';
import { createSuggestedBookmark } from './annotations';
import { conceptReferencesSchema } from '../shared/tutor-context';
import { loadTutorConcepts } from './tutor-context';
import { attachmentIdsSchema, attachmentMention } from '../shared/tutor-attachments';
import { readQuestionAttachments, attachmentImageData } from './tutor-attachments';

export async function conversationSnapshot(
  storage: DurableObjectStorage,
  sessions: StudySession[],
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
  return [...existing.values()].map((value) => conversationSchema.parse(value));
}

export async function conversationRoute({
  request,
  env,
  storage,
  body,
  settings,
  executionId,
}: {
  request: Request;
  env: Env;
  storage: DurableObjectStorage;
  body: () => Promise<unknown>;
  settings: () => Promise<Settings>;
  executionId: string;
}): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const sessionMatch = path.match(/^\/api\/sessions\/([a-f0-9-]+)\/conversations$/);
  const match = path.match(/^\/api\/conversations\/([\w-]+)(\/turns)?$/);
  if (!sessionMatch && !match) return null;
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  if (sessionMatch) {
    const session = await storage.get<StudySession>(`session:${sessionMatch[1]}`);
    if (!session) return json({ error: 'Session not found' }, 404);
    const threads = await conversationSnapshot(storage, [session]);
    if (request.method === 'GET')
      return json(threads.filter((item) => item.sessionId === session.id));
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const input = z
      .object({
        name: z.string().trim().min(1).max(160),
        sourceIds: z.array(z.string().uuid()).max(20).default([]),
      })
      .parse(await body());
    if (threads.filter((item) => item.sessionId === session.id).length >= 100)
      return json({ error: 'Conversation limit reached for this session (100)' }, 409);
    const created = conversationSchema.parse({
      ...input,
      id: crypto.randomUUID(),
      sessionId: session.id,
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    for (const id of created.sourceIds)
      if (!(await storage.get(`file:${id}`))) return json({ error: 'Reference not found' }, 404);
    await storage.put(`conversation:${created.id}`, created);
    return json(created, 201);
  }
  const key = `conversation:${match![1]}`;
  const conversation = await storage.get<Conversation>(key);
  if (!conversation) return json({ error: 'Conversation not found' }, 404);
  if (!match![2]) {
    if (request.method === 'GET') {
      const pending = await storage.get<{ until: number; owner: string }>(
        `conversation-run:${conversation.id}`,
      );
      return json({
        ...conversation,
        pending: !!pending && pending.owner === executionId && pending.until > Date.now(),
      });
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
      })
      .parse(await body());
    for (const id of input.sourceIds || [])
      if (!(await storage.get(`file:${id}`))) return json({ error: 'Reference not found' }, 404);
    const next = await storage.transaction(async (transaction) => {
      const current = (await transaction.get<Conversation>(key))!;
      const value = { ...current, ...input, updatedAt: new Date().toISOString() };
      await transaction.put(key, value);
      return value;
    });
    return json(next);
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const input = z
    .object({
      prompt: z.string().trim().min(1).max(8000),
      requestId: z.string().uuid(),
      context: questionContextSchema.optional(),
      concepts: conceptReferencesSchema.default([]),
      attachments: attachmentIdsSchema.default([]),
    })
    .parse(await body());
  const requestFingerprint = [
    ...new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(
          JSON.stringify({
            prompt: input.prompt,
            context: input.context,
            concepts: input.concepts,
            attachments: input.attachments,
          }),
        ),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const runKey = `conversation-run:${conversation.id}`;
  const reservation = await storage.transaction(async (transaction) => {
    const current = (await transaction.get<Conversation>(key))!;
    if (
      current.messages.some(
        (message) => message.role === 'assistant' && message.requestId === input.requestId,
      )
    ) {
      const original = current.messages.find(
        (message) => message.role === 'user' && message.requestId === input.requestId,
      );
      if (original?.requestFingerprint && original.requestFingerprint !== requestFingerprint)
        return { kind: 'different' as const, current };
      return { kind: 'complete' as const, current };
    }
    const pending = await transaction.get<{ requestId: string; until: number; owner: string }>(
      runKey,
    );
    if (pending && pending.owner === executionId && pending.until > Date.now())
      return { kind: 'busy' as const, current };
    await transaction.put(runKey, {
      requestId: input.requestId,
      until: Date.now() + 10 * 60 * 1000,
      owner: executionId,
    });
    return { kind: 'reserved' as const, current };
  });
  if (reservation.kind === 'complete') return json(reservation.current);
  if (reservation.kind === 'different')
    return json(
      {
        error: 'This request ID was already used for a different question or attachment selection',
      },
      409,
    );
  if (reservation.kind === 'busy')
    return json(
      {
        error:
          'A reply is already running in this conversation. Reopen it shortly to retrieve the result.',
      },
      409,
    );
  try {
    if (new TextEncoder().encode(JSON.stringify(reservation.current)).length > 80000)
      return json(
        {
          error: 'This conversation is full. Start a new conversation to keep this history intact.',
        },
        409,
      );
    const apiKey = await storage.get<string>('apiKey');
    if (!apiKey) return json({ error: 'Add a Meta API key in Settings' }, 409);
    const directories = [...(await storage.list<Directory>({ prefix: 'directory:' })).values()];
    const materials: Learning[] = [];
    for (const id of reservation.current.sourceIds) {
      const source = await storage.get<Source>(`file:${id}`);
      if (!source || sourceState(source, directories) === 'trash')
        return json({ error: 'Restore or remove a deleted reference before sending' }, 409);
      const learning = await storage.get<Learning>(`learning:${id}`);
      if (
        (!learning || learning.sourceVersion !== source.version) &&
        input.context?.sourceId === id &&
        input.context.location.quote
      )
        continue;
      if (!learning || learning.sourceVersion !== source.version)
        return json({ error: `Prepare the reference first: ${source.name}` }, 409);
      materials.push(learning);
    }
    let context = input.context;
    const sourceIds = [...reservation.current.sourceIds];
    if (context) {
      const source = await storage.get<Source>(`file:${context.sourceId}`);
      if (
        !source ||
        sourceState(source, directories) === 'trash' ||
        source.version !== context.sourceVersion
      )
        return json(
          { error: 'The question source changed or is unavailable. Select the passage again.' },
          409,
        );
      context = { ...context, sourceName: source.name };
      if (!sourceIds.includes(source.id)) {
        if (sourceIds.length >= 20)
          return json(
            { error: 'Remove a reference before attaching another question source (20 maximum)' },
            409,
          );
        sourceIds.push(source.id);
      }
      if (!materials.some((material) => material.sourceId === source.id)) {
        const learning = await storage.get<Learning>(`learning:${source.id}`);
        if (learning?.sourceVersion === source.version) materials.push(learning);
        else if (!context.location.quote)
          return json(
            { error: `Select a passage or prepare this source first: ${source.name}` },
            409,
          );
      }
    }
    const glossaryContext = await loadTutorConcepts(storage, input.concepts, materials);
    const attachments = await readQuestionAttachments(
      storage,
      reservation.current.sessionId,
      input.attachments,
    );
    const attachedContent = await Promise.all(
      attachments.map(async (item) => ({
        ...item,
        imageData: await attachmentImageData(env.FILES, item.attachment),
      })),
    );
    for (const { attachment } of attachments) {
      if (attachment.sourceId && !sourceIds.includes(attachment.sourceId))
        sourceIds.push(attachment.sourceId);
    }
    if (sourceIds.length > 20)
      return json(
        {
          error:
            'The question has more than 20 source origins. Remove a reference or attachment before sending.',
        },
        409,
      );
    const userMessage = {
      role: 'user' as const,
      content: input.prompt,
      requestId: input.requestId,
      requestFingerprint,
      sourceIds,
      ...(context ? { context } : {}),
      ...(glossaryContext.mentions.length ? { concepts: glossaryContext.mentions } : {}),
      ...(attachments.length
        ? { attachments: attachments.map((item) => attachmentMention(item.attachment)) }
        : {}),
    };
    if (
      new TextEncoder().encode(
        JSON.stringify({
          ...reservation.current,
          messages: [...reservation.current.messages, userMessage],
        }),
      ).length > 80000
    )
      return json(
        {
          error: 'This conversation is full. Start a new conversation to keep its history intact.',
        },
        409,
      );
    const attempts = [...(await storage.list<Attempt>({ prefix: 'attempt:' })).values()].filter(
      (attempt) => sourceIds.includes(attempt.sourceId),
    );
    const result = await runAssistant(
      apiKey,
      (await settings()).model,
      input.prompt,
      reservation.current.messages.slice(-16),
      materials,
      reviewSummary(attempts),
      bridgedFetch(env),
      context,
      {
        concepts: glossaryContext.concepts,
        attachments: attachedContent,
        createBookmark: ({ sourceId, sourceVersion, segment, label }) =>
          createSuggestedBookmark(storage, {
            sessionId: reservation.current.sessionId,
            sourceId,
            sourceVersion,
            label,
            requestId: input.requestId,
            segmentId: segment.id,
            location: {
              quote: segment.text.slice(0, 8000),
              ...(segment.page ? { page: segment.page } : {}),
              ...(segment.start != null ? { seconds: segment.start } : {}),
            },
          }),
      },
    );
    const completed = await storage.transaction(async (transaction) => {
      const current = (await transaction.get<Conversation>(key))!;
      // Settings and name edits made during generation must survive the reply.
      const next = conversationSchema.parse({
        ...current,
        updatedAt: new Date().toISOString(),
        messages: [
          ...current.messages.slice(-98),
          userMessage,
          {
            role: 'assistant',
            content: result.text,
            tools: result.tools,
            citations: result.citations,
            requestId: input.requestId,
            sourceIds,
          },
        ],
      });
      if (new TextEncoder().encode(JSON.stringify(next)).length > 120000) return null;
      await transaction.put(key, next);
      return next;
    });
    return completed
      ? json(completed)
      : json(
          {
            error:
              'This reply is too large for the conversation. Start a new conversation or ask a shorter question; existing history is intact.',
          },
          409,
        );
  } finally {
    await storage.transaction(async (transaction) => {
      const pending = await transaction.get<{ requestId: string }>(runKey);
      if (pending?.requestId === input.requestId) await transaction.delete(runKey);
    });
  }
}
