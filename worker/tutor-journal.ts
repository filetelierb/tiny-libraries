import {
  chatMessageSchema,
  conversationMessageSources,
  type ChatMessage,
  type Conversation,
} from '../shared/conversations';
import {
  tutorFingerprint,
  turnInputFingerprint,
  turnSteeringCompatible,
  type TurnAction,
  type TurnIntent,
  type TurnRecord,
  type TurnView,
} from '../shared/tutor-turns';
import type { GlossaryStore } from './glossary';

export type JournalTransaction = GlossaryStore & {
  setAlarm(time: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
};
export type JournalStorage = GlossaryStore & {
  transaction<T>(callback: (tx: JournalTransaction) => Promise<T>): Promise<T>;
};
export type JournalObjects = {
  read(key: string): Promise<string | null>;
  write(key: string, text: string): Promise<void>;
};
export class TutorJournalError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
type Meta = {
  conversationId: string;
  sequence: number;
  ordinal: number;
  queueOrdinal: number;
  baseObject: string;
  baseCount: number;
  messageCount: number;
  latestPreview: string;
  updatedAt: string;
  activeId?: string;
};
type MessageIndex = {
  object: string;
  messageId: string;
  turnId: string;
  attempt: number;
  sources?: string[];
};
const order = (n: number) => String(n).padStart(16, '0');
const queued = (record: TurnRecord) => ['queued', 'editing'].includes(record.status);
const retryable = (record: TurnRecord) =>
  ['failed', 'interrupted', 'stopped', 'cancelled'].includes(record.status);
const queueKey = (record: TurnRecord) => `queue:${order(record.queueOrdinal!)}`;
const turnKey = (id: string) => `turn:${id}`;
const messageKey = (n: number) => `message:${order(n)}`;
const now = () => new Date().toISOString();

/** Immutable large values live outside the coordinator's bounded metadata records. */
export class TutorObjects {
  constructor(
    private readonly objects: JournalObjects,
    private readonly conversationId: string,
  ) {}
  async put(value: unknown) {
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > 32 * 1024 * 1024)
      throw new TutorJournalError('Conversation context exceeds 32 MB', 413);
    const key = `tutor/${encodeURIComponent(this.conversationId)}/objects/${await tutorFingerprint(value)}.json`;
    await this.objects.write(key, text);
    return key;
  }
  async get<T>(key: string): Promise<T> {
    const prefix = `tutor/${encodeURIComponent(this.conversationId)}/objects/`;
    if (!key.startsWith(prefix) || !/^[a-f0-9]{64}\.json$/.test(key.slice(prefix.length)))
      throw new TutorJournalError('Invalid saved conversation object', 500);
    const text = await this.objects.read(key);
    if (text == null) throw new TutorJournalError('Saved conversation context is unavailable', 500);
    if (new TextEncoder().encode(text).length > 32 * 1024 * 1024)
      throw new TutorJournalError('Saved conversation object exceeds its limit', 500);
    const value = JSON.parse(text);
    if (key !== `${prefix}${await tutorFingerprint(value)}.json`)
      throw new TutorJournalError('Saved conversation context failed its integrity check', 500);
    return value;
  }
}

/** Every accepted input, queue mutation and wakeup commits in the same transaction. */
export class TutorJournal {
  readonly objects: TutorObjects;
  constructor(
    private readonly storage: JournalStorage,
    objects: JournalObjects,
    readonly conversationId: string,
  ) {
    this.objects = new TutorObjects(objects, conversationId);
  }

  async seed(conversation: Conversation) {
    if (conversation.id !== this.conversationId)
      throw new TutorJournalError('Conversation identity mismatch');
    if (await this.storage.get('meta')) return;
    const baseObject = await this.objects.put(conversation.messages);
    await this.storage.transaction(async (tx) => {
      if (await tx.get('meta')) return;
      await tx.put<Meta>('meta', {
        conversationId: this.conversationId,
        sequence: 0,
        ordinal: 0,
        queueOrdinal: 0,
        baseObject,
        baseCount: conversation.messages.length,
        messageCount: conversation.messages.length,
        latestPreview: conversation.messages.at(-1)?.content.slice(0, 240) || '',
        updatedAt: conversation.updatedAt,
      });
    });
  }
  get(id: string) {
    return this.storage.get<TurnRecord>(turnKey(id));
  }
  async receipt(id: string, fingerprint: string) {
    const record = await this.get(id);
    if (record && record.acceptanceFingerprint !== fingerprint)
      throw new TutorJournalError(
        'This request ID was already used for different question context or generation settings',
      );
    return record;
  }
  async accept(intent: TurnIntent, fingerprint: string) {
    const id = intent.input.requestId;
    const known = await this.receipt(id, fingerprint);
    if (known) return known;
    const intentObject = await this.objects.put(intent);
    return this.storage.transaction(async (tx) => {
      const previous = await tx.get<TurnRecord>(turnKey(id));
      if (previous) {
        if (previous.acceptanceFingerprint !== fingerprint)
          throw new TutorJournalError(
            'This request ID was already used for different question context or generation settings',
          );
        return previous;
      }
      const meta = await this.meta(tx);
      if ((await tx.list({ prefix: 'queue:', limit: 20 })).size >= 20)
        throw new TutorJournalError(
          'The conversation queue is full (20 questions). Finish or cancel a queued question first.',
        );
      const time = now();
      const record: TurnRecord = {
        id,
        conversationId: this.conversationId,
        ordinal: ++meta.ordinal,
        revision: 1,
        intentRevision: 1,
        acceptanceFingerprint: fingerprint,
        intentObject,
        generation: intent.generation,
        status: 'queued',
        queueOrdinal: ++meta.queueOrdinal,
        attempt: 0,
        workVersion: 0,
        modelCalls: 0,
        partial: '',
        toolNames: [],
        stopRequested: false,
        steering: [],
        appliedSteers: 0,
        blocking: false,
        createdAt: time,
        updatedAt: time,
      };
      await tx.put(turnKey(id), record);
      await tx.put(`turn-order:${order(record.ordinal)}`, id);
      await tx.put(queueKey(record), id);
      await this.changed(tx, meta, time);
      return record;
    });
  }
  async intent(record: TurnRecord) {
    return this.objects.get<TurnIntent>(record.intentObject);
  }
  private async meta(tx: GlossaryStore) {
    const value = await tx.get<Meta>('meta');
    if (!value || value.conversationId !== this.conversationId)
      throw new TutorJournalError('Conversation history has not been initialized', 500);
    return value;
  }
  private async changed(tx: JournalTransaction, meta: Meta, time = now()) {
    meta.sequence++;
    meta.updatedAt = time;
    await tx.put('meta', meta);
    await tx.setAlarm(Date.now() + 100);
  }
  private async append(
    tx: JournalTransaction,
    meta: Meta,
    index: MessageIndex,
    message: ChatMessage,
  ) {
    const receipt = `message-id:${index.messageId}`;
    if (await tx.get(receipt)) return;
    await tx.put(messageKey(++meta.messageCount), {
      ...index,
      sources: conversationMessageSources(message, []),
    });
    await tx.put(receipt, meta.messageCount);
    meta.latestPreview = message.content.slice(0, 240);
  }
  /** Claim only the head; an entry being edited pauses the FIFO queue. */
  async claim() {
    const active = await this.active();
    if (active) return active;
    const head = [...(await this.storage.list<string>({ prefix: 'queue:', limit: 1 })).values()][0];
    if (!head) return null;
    const candidate = await this.get(head);
    if (!candidate || candidate.status !== 'queued' || candidate.blocking) return null;
    const intent = await this.intent(candidate);
    const user = chatMessageSchema.parse({
      ...intent.userMessage,
      messageId: `${candidate.id}:a${candidate.attempt + 1}:user`,
    });
    const object = await this.objects.put(user);
    return this.storage.transaction(async (tx) => {
      const meta = await this.meta(tx);
      if (meta.activeId) return (await tx.get<TurnRecord>(turnKey(meta.activeId)))!;
      const first = [...(await tx.list<string>({ prefix: 'queue:', limit: 1 })).values()][0];
      const record = await tx.get<TurnRecord>(turnKey(head));
      if (
        first !== head ||
        !record ||
        record.status !== 'queued' ||
        record.blocking ||
        record.revision !== candidate.revision ||
        record.workVersion !== candidate.workVersion
      )
        return null;
      record.attempt++;
      record.status = 'running';
      record.phase = record.checkpointObject ? 'tools' : 'initialize';
      record.startedAt = now();
      record.deadline = Date.now() + 2 * 60 * 60 * 1000;
      record.updatedAt = record.startedAt;
      record.workVersion++;
      await tx.delete(queueKey(record));
      delete record.queueOrdinal;
      meta.activeId = record.id;
      await this.append(
        tx,
        meta,
        {
          object,
          messageId: user.messageId!,
          turnId: record.id,
          attempt: record.attempt,
        },
        user,
      );
      await tx.put(turnKey(record.id), record);
      await this.changed(tx, meta, record.updatedAt);
      return record;
    });
  }
  async active() {
    const meta = await this.storage.get<Meta>('meta');
    return meta?.activeId ? (await this.get(meta.activeId)) || null : null;
  }
  /** CAS stale I/O, while preserving controls admitted while that I/O was pending. */
  async progress(
    record: TurnRecord,
    patch: Partial<
      Pick<
        TurnRecord,
        | 'phase'
        | 'initialObject'
        | 'checkpointObject'
        | 'providerId'
        | 'providerSequence'
        | 'providerStart'
        | 'retiredProviders'
        | 'appliedSteers'
        | 'modelCalls'
        | 'partial'
        | 'toolNames'
      >
    >,
  ) {
    return this.storage.transaction(async (tx) => {
      const current = await tx.get<TurnRecord>(turnKey(record.id));
      if (!current || current.status !== 'running' || current.workVersion !== record.workVersion)
        return null;
      const next = { ...current, ...patch, workVersion: current.workVersion + 1, updatedAt: now() };
      next.partial = next.partial.slice(0, 16000);
      next.toolNames = [...new Set(next.toolNames)].slice(-40).map((name) => name.slice(0, 160));
      await tx.put(turnKey(next.id), next);
      await this.changed(tx, await this.meta(tx), next.updatedAt);
      return next;
    });
  }
  async finish(
    record: TurnRecord,
    status: 'completed' | 'stopped' | 'failed' | 'interrupted',
    message?: ChatMessage,
    error?: string,
  ) {
    const saved = message
      ? chatMessageSchema.parse({
          ...message,
          messageId: `${record.id}:a${record.attempt}:assistant`,
          ...(status === 'completed' ? {} : { status }),
        })
      : null;
    const object = saved ? await this.objects.put(saved) : null;
    return this.storage.transaction(async (tx) => {
      const current = await tx.get<TurnRecord>(turnKey(record.id));
      if (!current || current.status !== 'running' || current.workVersion !== record.workVersion)
        return null;
      if (status === 'completed' && (current.stopRequested || current.steering.length)) return null;
      const meta = await this.meta(tx);
      current.status = status;
      current.error = error?.slice(0, 500);
      current.updatedAt = now();
      current.workVersion++;
      if (saved && object)
        await this.append(
          tx,
          meta,
          {
            object,
            messageId: saved.messageId!,
            turnId: current.id,
            attempt: current.attempt,
          },
          saved,
        );
      // A steering instruction not applied before termination remains a queued question.
      for (const id of current.steering) {
        const child = await tx.get<TurnRecord>(turnKey(id));
        if (!child || child.status !== 'steering') continue;
        child.status = 'queued';
        child.queueOrdinal = ++meta.queueOrdinal;
        delete child.parentId;
        delete child.effectiveGeneration;
        await tx.put(turnKey(id), child);
        await tx.put(queueKey(child), id);
      }
      current.steering = [];
      await tx.put(turnKey(current.id), current);
      await tx.put(`attempt:${current.id}:${order(current.attempt)}`, current);
      if (status !== 'completed') await tx.put(`attention:${order(current.ordinal)}`, current.id);
      delete meta.activeId;
      await this.changed(tx, meta, current.updatedAt);
      return current;
    });
  }
  async action(id: string, action: TurnAction) {
    const fingerprint = await tutorFingerprint({ id, ...action });
    const receiptKey = `operation:${action.operationId}`;
    const oldReceipt = await this.storage.get<string>(receiptKey);
    if (oldReceipt) {
      if (oldReceipt !== fingerprint)
        throw new TutorJournalError('This operation ID was used for a different change');
      return (await this.get(id))!;
    }
    const previous = await this.get(id);
    if (!previous) throw new TutorJournalError('Question not found', 404);
    const intent = await this.intent(previous);
    let intentObject = previous.intentObject;
    if (action.action === 'save') {
      if (!action.prompt) throw new TutorJournalError('A saved question needs text', 400);
      intent.input.prompt = action.prompt;
      intent.generation = action.generation || previous.generation;
      intent.input.generation = intent.generation;
      intent.userMessage = {
        ...intent.userMessage,
        content: action.prompt,
        generation: intent.generation,
        requestFingerprint: await turnInputFingerprint(intent.input),
      };
      intentObject = await this.objects.put(intent);
    }
    const active = action.action === 'steer' ? await this.active() : null;
    const activeIntent = active ? await this.intent(active) : null;
    return this.storage.transaction(async (tx) => {
      const receipt = await tx.get<string>(receiptKey);
      if (receipt) {
        if (receipt !== fingerprint)
          throw new TutorJournalError('This operation ID was used for a different change');
        return (await tx.get<TurnRecord>(turnKey(id)))!;
      }
      const record = await tx.get<TurnRecord>(turnKey(id));
      if (
        !record ||
        record.revision !== action.revision ||
        record.intentObject !== previous.intentObject
      )
        throw new TutorJournalError('The question changed. Refresh it before editing.');
      const meta = await this.meta(tx);
      switch (action.action) {
        case 'edit':
          if (!queued(record)) throw new TutorJournalError('Only queued questions can be edited');
          record.status = 'editing';
          break;
        case 'save':
          if (!queued(record)) throw new TutorJournalError('Only queued questions can be edited');
          record.intentObject = intentObject;
          record.generation = intent.generation;
          record.intentRevision++;
          record.modelCalls = 0;
          record.appliedSteers = 0;
          record.toolNames = [];
          record.status = 'queued';
          record.blocking = false;
          delete record.initialObject;
          delete record.checkpointObject;
          break;
        case 'resume':
          if (record.status !== 'editing')
            throw new TutorJournalError('This question is not being edited');
          record.status = 'queued';
          break;
        case 'cancel':
          if (!queued(record))
            throw new TutorJournalError('Only queued questions can be cancelled');
          await tx.delete(queueKey(record));
          delete record.queueOrdinal;
          record.status = 'cancelled';
          await tx.put(`attention:${order(record.ordinal)}`, id);
          break;
        case 'retry':
          if (!retryable(record)) throw new TutorJournalError('This question cannot be retried');
          if ((await tx.list({ prefix: 'queue:', limit: 20 })).size >= 20)
            throw new TutorJournalError('The conversation queue is full (20 questions).');
          if (record.providerId)
            record.retiredProviders = [
              ...new Set([...(record.retiredProviders || []), record.providerId]),
            ];
          record.status = 'queued';
          record.queueOrdinal = ++meta.queueOrdinal;
          record.stopRequested = false;
          record.error = undefined;
          record.partial = '';
          record.providerId = undefined;
          record.providerSequence = undefined;
          record.providerStart = undefined;
          await tx.put(queueKey(record), id);
          await tx.delete(`attention:${order(record.ordinal)}`);
          break;
        case 'stop':
          if (record.status !== 'running')
            throw new TutorJournalError('This question is not running');
          record.stopRequested = true;
          break;
        case 'steer': {
          const running = active && (await tx.get<TurnRecord>(turnKey(active.id)));
          if (
            record.status !== 'queued' ||
            !running ||
            running.status !== 'running' ||
            running.stopRequested ||
            running.intentObject !== active!.intentObject ||
            running.modelCalls >= 20 ||
            (running.appliedSteers || 0) + running.steering.length >= 20 ||
            !activeIntent ||
            !turnSteeringCompatible(intent.scope, activeIntent.scope)
          )
            throw new TutorJournalError(
              'This question cannot steer the active reply. Keep it queued.',
            );
          await tx.delete(queueKey(record));
          delete record.queueOrdinal;
          record.status = 'steering';
          record.parentId = running.id;
          record.effectiveGeneration = running.generation;
          running.steering.push(id);
          await tx.put(turnKey(running.id), running);
          break;
        }
      }
      record.revision++;
      record.updatedAt = now();
      // Control changes do not invalidate a model result already in flight.
      await tx.put(turnKey(id), record);
      await tx.put(receiptKey, fingerprint);
      await this.changed(tx, meta, record.updatedAt);
      return record;
    });
  }
  async appliedSteering(record: TurnRecord, childId: string, checkpointObject: string) {
    const child = await this.get(childId);
    if (!child) throw new TutorJournalError('Steering question is unavailable', 500);
    const intent = await this.intent(child);
    const activeIntent = await this.intent(record);
    const user = chatMessageSchema.parse({
      ...intent.userMessage,
      sourceIds: activeIntent.userMessage.sourceIds,
      context: intent.userMessage.context || activeIntent.userMessage.context,
      generation: record.generation,
      messageId: `${childId}:steer`,
      turnKind: 'steering',
    });
    const object = await this.objects.put(user);
    return this.storage.transaction(async (tx) => {
      const current = await tx.get<TurnRecord>(turnKey(record.id));
      const steering = await tx.get<TurnRecord>(turnKey(childId));
      if (
        !current ||
        current.status !== 'running' ||
        current.stopRequested ||
        current.workVersion !== record.workVersion ||
        current.steering[0] !== childId ||
        steering?.status !== 'steering'
      )
        return null;
      const meta = await this.meta(tx);
      await this.append(
        tx,
        meta,
        { object, messageId: user.messageId!, turnId: childId, attempt: current.attempt },
        user,
      );
      current.steering.shift();
      current.appliedSteers = (current.appliedSteers || 0) + 1;
      current.checkpointObject = checkpointObject;
      current.providerId = undefined;
      current.providerSequence = undefined;
      current.providerStart = undefined;
      current.partial = '';
      current.phase = 'tools';
      current.workVersion++;
      current.updatedAt = now();
      steering.status = 'steered';
      steering.updatedAt = current.updatedAt;
      await tx.put(turnKey(current.id), current);
      await tx.put(turnKey(childId), steering);
      await this.changed(tx, meta, current.updatedAt);
      return current;
    });
  }
  async releaseSteering(record: TurnRecord) {
    return this.storage.transaction(async (tx) => {
      const current = await tx.get<TurnRecord>(turnKey(record.id));
      if (!current || current.status !== 'running' || current.workVersion !== record.workVersion)
        return null;
      const meta = await this.meta(tx);
      for (const id of current.steering) {
        const child = await tx.get<TurnRecord>(turnKey(id));
        if (!child || child.status !== 'steering') continue;
        child.status = 'queued';
        child.queueOrdinal = ++meta.queueOrdinal;
        delete child.parentId;
        delete child.effectiveGeneration;
        await tx.put(turnKey(id), child);
        await tx.put(queueKey(child), id);
      }
      current.steering = [];
      current.workVersion++;
      current.updatedAt = now();
      await tx.put(turnKey(current.id), current);
      await this.changed(tx, meta, current.updatedAt);
      return current;
    });
  }
  async history(before?: number, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new TutorJournalError('History page size must be between 1 and 50', 400);
    const meta = await this.meta(this.storage);
    const end = before ?? meta.messageCount + 1;
    if (!Number.isInteger(end) || end < 1 || end > meta.messageCount + 1)
      throw new TutorJournalError('Invalid conversation history cursor', 400);
    const start = Math.max(1, end - limit),
      messages: ChatMessage[] = [];
    if (start <= meta.baseCount) {
      const base = await this.objects.get<ChatMessage[]>(meta.baseObject);
      messages.push(...base.slice(start - 1, Math.min(end - 1, meta.baseCount)));
    }
    const entries = await this.storage.list<MessageIndex>({
      prefix: 'message:',
      startAfter: messageKey(Math.max(meta.baseCount, start - 1)),
      end: messageKey(end),
      limit,
    });
    for (const index of entries.values())
      messages.push(chatMessageSchema.parse(await this.objects.get(index.object)));
    return {
      messages,
      messageCount: meta.messageCount,
      historyCursor: start > 1 ? String(start) : null,
      latestPreview: meta.latestPreview,
      updatedAt: meta.updatedAt,
    };
  }
  async turns(before?: number, limit = 20) {
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (before !== undefined && (!Number.isInteger(before) || before < 1))
    )
      throw new TutorJournalError('Invalid question history page', 400);
    const entries = await this.storage.list<string>({
      prefix: 'turn-order:',
      reverse: true,
      limit,
      ...(before ? { end: `turn-order:${order(before)}` } : {}),
    });
    const items = await Promise.all([...entries.values()].map(async (id) => (await this.get(id))!));
    return { items, cursor: items.length === limit ? String(items.at(-1)!.ordinal) : null };
  }
  async linkedMessages(sourceIds: string[], fallback: string[]) {
    const meta = await this.storage.get<Meta>('meta');
    if (!meta) return null;
    const selected = new Set(sourceIds),
      messages: ChatMessage[] = [];
    const eligible = (ids: string[]) => ids.length > 0 && ids.every((id) => selected.has(id));
    let end: string | undefined;
    while (messages.length < 20) {
      const entries = await this.storage.list<MessageIndex>({
        prefix: 'message:',
        reverse: true,
        limit: 200,
        ...(end ? { end } : {}),
      });
      if (!entries.size) break;
      for (const index of entries.values()) {
        if (index.sources && !eligible(index.sources)) continue;
        const message = chatMessageSchema.parse(await this.objects.get(index.object));
        if (eligible(conversationMessageSources(message, fallback))) messages.unshift(message);
        if (messages.length === 20) break;
      }
      end = [...entries.keys()].at(-1)!;
    }
    if (messages.length < 20) {
      const base = await this.objects.get<ChatMessage[]>(meta.baseObject);
      for (const message of [...base].reverse()) {
        if (eligible(conversationMessageSources(message, fallback))) messages.unshift(message);
        if (messages.length === 20) break;
      }
    }
    return { messages, messageCount: meta.messageCount };
  }
  async attempts(id: string, before?: number) {
    const entries = await this.storage.list<TurnRecord>({
      prefix: `attempt:${id}:`,
      limit: 20,
      reverse: true,
      ...(before ? { end: `attempt:${id}:${order(before)}` } : {}),
    });
    const items = [...entries.values()];
    return { items, cursor: items.length === 20 ? String(items.at(-1)!.attempt) : null };
  }
  async view(record: TurnRecord, active?: TurnRecord | null): Promise<TurnView> {
    const intent = await this.intent(record);
    const activeIntent = active ? await this.intent(active) : null;
    return {
      id: record.id,
      status: record.status,
      revision: record.revision,
      prompt: intent.input.prompt,
      generation: record.generation,
      effectiveGeneration: record.effectiveGeneration,
      attachments: intent.userMessage.attachments,
      context: intent.userMessage.context,
      references: intent.scope.references.map(({ id, version }) => ({ id, version })),
      phase: record.phase,
      attempt: record.attempt,
      partial: record.partial,
      toolNames: record.toolNames,
      stopRequested: record.stopRequested,
      error: record.error,
      canEdit: queued(record),
      canRetry: retryable(record),
      canSteer:
        !!active &&
        active.id !== record.id &&
        record.status === 'queued' &&
        !active.stopRequested &&
        active.modelCalls < 20 &&
        (active.appliedSteers || 0) + active.steering.length < 20 &&
        !!activeIntent &&
        turnSteeringCompatible(intent.scope, activeIntent.scope),
    };
  }
  async snapshot() {
    const captured = await this.storage.transaction(async (tx) => {
      const meta = await tx.get<Meta>('meta');
      if (!meta) return null;
      const active = meta.activeId ? (await tx.get<TurnRecord>(turnKey(meta.activeId)))! : null;
      const ids = [...(await tx.list<string>({ prefix: 'queue:', limit: 20 })).values()];
      const attention = await tx.list<string>({ prefix: 'attention:', limit: 20, reverse: true });
      const records: TurnRecord[] = [];
      for (const id of new Set([...ids, ...attention.values(), ...(active?.steering || [])]))
        records.push((await tx.get<TurnRecord>(turnKey(id)))!);
      return { meta, active, records };
    });
    if (!captured) return null;
    const { meta, active, records } = captured;
    // Append-only messages can be read outside the transaction at the captured upper bound.
    const history = await this.history(meta.messageCount + 1);
    return {
      ...history,
      messageCount: meta.messageCount,
      latestPreview: meta.latestPreview,
      updatedAt: meta.updatedAt,
      pending: !!active,
      ...(active ? { pendingGeneration: active.generation } : {}),
      runState: {
        sequence: meta.sequence,
        active: active ? await this.view(active) : null,
        outbox: await Promise.all(records.map((record) => this.view(record, active))),
      },
    };
  }
  async schedule() {
    await this.storage.transaction(async (tx) => {
      const meta = await tx.get<Meta>('meta');
      const head = [...(await tx.list<string>({ prefix: 'queue:', limit: 1 })).values()][0];
      const record = head ? await tx.get<TurnRecord>(turnKey(head)) : null;
      if (meta?.activeId || (record?.status === 'queued' && !record.blocking))
        await tx.setAlarm(Date.now() + 750);
      else await tx.deleteAlarm();
    });
  }
}
