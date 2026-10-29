import { DurableObject } from 'cloudflare:workers';
import type { Conversation } from '../shared/conversations';
import { turnActionSchema, type TurnIntent, type TurnAction } from '../shared/tutor-turns';
import { transportSnapshotSchema } from '../shared/tutor-transport';
import { z } from 'zod';
import { TutorJournal, TutorJournalError } from './tutor-journal';
import { TutorRunner, type TutorRunnerServices } from './tutor-runner';
import { tutorMcp } from './tutor-mcp';
import { ToolRejection } from './tutor-agent';
import type { GlossaryEntry } from '../shared/glossary';

/** A UUID-shaped identity derived from a stable name. */
async function stableId(name: string) {
  const hex = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(name))),
  ]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** A reply's tool token, derivable only with the bridge secret. */
async function toolToken(secret: string, conversationId: string, providerId: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`tutor-tools:${conversationId}:${providerId}`),
  );
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A conversation's queue and recovery alarm have an identity independent of the browser. */
export class TutorConversation extends DurableObject<Env> {
  private stepping?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  /** Runner steps and agent tool calls take turns, so each sees the latest checkpoint. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(run);
    this.queue = next;
    return next;
  }
  private journal() {
    const id = this.ctx.id.name;
    if (!id) throw new Error('A conversation coordinator requires a named identity');
    return new TutorJournal(
      this.ctx.storage,
      {
        read: async (key) => (await this.env.FILES.get(key))?.text() || null,
        write: async (key, text) => {
          await this.env.FILES.put(key, text, {
            httpMetadata: { contentType: 'application/json' },
          });
        },
      },
      id,
    );
  }
  private async checked<T>(run: () => Promise<T>) {
    try {
      return { ok: true as const, value: await run() };
    } catch (error) {
      if (error instanceof TutorJournalError || error instanceof z.ZodError)
        return {
          ok: false as const,
          error: error instanceof z.ZodError ? 'Invalid question change' : error.message,
          status: error instanceof TutorJournalError ? error.status : 400,
        };
      throw error;
    }
  }
  async seed(conversation: Conversation) {
    return this.checked(() => this.journal().seed(conversation));
  }
  async receipt(id: string, fingerprint: string) {
    return this.checked(() => this.journal().receipt(id, fingerprint));
  }
  async turn(id: string) {
    return this.checked(async () => {
      const journal = this.journal(),
        record = await journal.get(id);
      return record
        ? {
            turn: await journal.view(record, await journal.active()),
            acceptanceFingerprint: record.acceptanceFingerprint,
          }
        : null;
    });
  }
  async accept(intent: TurnIntent, fingerprint: string) {
    return this.checked(() => this.journal().accept(intent, fingerprint));
  }
  async snapshot() {
    return this.checked(() => this.journal().snapshot());
  }
  async history(before?: number) {
    return this.checked(() => this.journal().history(before));
  }
  async linkedMessages(sourceIds: string[], fallback: string[]) {
    return this.checked(() => this.journal().linkedMessages(sourceIds, fallback));
  }
  async turns(before?: number) {
    return this.checked(async () => {
      const journal = this.journal(),
        page = await journal.turns(before),
        active = await journal.active();
      return {
        items: await Promise.all(page.items.map((record) => journal.view(record, active))),
        cursor: page.cursor,
      };
    });
  }
  async attempts(id: string, before?: number) {
    return this.checked(async () => {
      const journal = this.journal(),
        page = await journal.attempts(id, before);
      return {
        items: await Promise.all(page.items.map((record) => journal.view(record))),
        cursor: page.cursor,
      };
    });
  }
  async action(id: string, value: TurnAction) {
    return this.checked(async () => {
      const journal = this.journal();
      const record = await journal.action(id, turnActionSchema.parse(value));
      // The committed alarm retries cancellation if the sidecar is temporarily unavailable.
      if (record.stopRequested && record.providerId)
        await this.services()
          .cancel(record.providerId)
          .catch(() => {});
      for (const provider of record.retiredProviders || [])
        await this.services()
          .cancel(provider)
          .catch(() => {});
      return journal.view(record, await journal.active());
    });
  }
  private async library<T>(path: string, body?: unknown): Promise<T> {
    const response = await this.env.LIBRARY.getByName('local-user').fetch(
      new Request(`http://internal${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      }),
    );
    if (!response.ok) {
      const value = await response.json<{ error?: string }>();
      const message = value.error || 'Library operation failed';
      // Refusals the agent can correct come back to it; anything else interrupts the reply.
      throw response.status < 500 ? new ToolRejection(message) : new Error(message);
    }
    return response.json<T>();
  }
  /** One JSON-RPC message from the agent host serving this conversation's active reply. */
  async tools(providerId: string, token: string, message: unknown) {
    const id = this.ctx.id.name!;
    const expected = await toolToken(this.env.MEDIA_BRIDGE_TOKEN, id, providerId);
    let difference = expected.length ^ token.length;
    for (let i = 0; i < expected.length; i++)
      difference |= expected.charCodeAt(i) ^ (token.charCodeAt(i) || 0);
    if (difference) return { ok: false as const, error: 'Unauthorized', status: 401 };
    return {
      ok: true as const,
      value: await this.exclusive(() =>
        tutorMcp(this.journal(), this.services(), providerId, message as never),
      ),
    };
  }
  private services(): TutorRunnerServices {
    const bridge = async (id: string, method = 'GET', body?: unknown, cancel = false) => {
      const key = body ? (await this.library<{ key: string | null }>('/internal/key')).key : null;
      if (body && !key)
        throw new Error('Add a Meta API key in Settings, then retry this question.');
      const response = await fetch(
        `${this.env.MEDIA_BRIDGE_URL}/tutor-requests/${id}${cancel ? '/cancel' : ''}`,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.env.MEDIA_BRIDGE_TOKEN}`,
            ...(body ? { 'Content-Type': 'application/json', 'X-Meta-Key': key! } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(10000),
        },
      );
      if (response.status === 404 && method === 'GET') return null;
      if (!response.ok)
        throw new Error(
          `Local model transport returned HTTP ${response.status}. Saved progress is retained.`,
        );
      return transportSnapshotSchema.parse(await response.json());
    };
    return {
      get: (id) => bridge(id),
      start: async (id, body) => (await bridge(id, 'POST', body))!,
      cancel: async (id) => (await bridge(id, 'POST', undefined, true))!,
      bookmark: (record, _intent, value) =>
        this.library('/internal/tutor-bookmark', {
          ...value,
          conversationId: record.conversationId,
          requestId: `${record.id}:r${record.intentRevision}`,
        }),
      artifact: (record, _intent, value) =>
        this.library('/internal/tutor-artifact', {
          ...value,
          conversationId: record.conversationId,
          requestId: `${record.id}:r${record.intentRevision}`,
        }),
      concept: async (record, _intent, { callId, ...value }) =>
        this.library('/internal/tutor-concept', {
          ...value,
          conversationId: record.conversationId,
          // A retried call repeats its change instead of applying it twice.
          mutationId: await stableId(`${record.id}:r${record.intentRevision}:${callId}`),
        }),
      generate: async (record, _intent, { callId, request }) =>
        this.library('/internal/tutor-artifact-job', {
          // A retried call returns the generation it already started.
          id: await stableId(`${record.id}:r${record.intentRevision}:${callId}`),
          conversationId: record.conversationId,
          model: record.generation.model,
          request,
        }),
      act: async (record, _intent, { callId, action }) =>
        this.library('/internal/tutor-action', {
          // A retried call returns what the first one did.
          id: await stableId(`${record.id}:r${record.intentRevision}:${callId}`),
          conversationId: record.conversationId,
          action,
        }),
      look: (record, query) =>
        this.library('/internal/tutor-library', {
          ...query,
          conversationId: record.conversationId,
        }),
      glossary: async (query) =>
        (
          await this.library<{ entries: GlossaryEntry[] }>('/internal/tutor-glossary-search', {
            query,
          })
        ).entries,
      muse: async (providerId) => {
        const id = this.ctx.id.name!;
        return {
          url: `${this.env.APP_URL}/api/tutor-tools/${id}/${providerId}`,
          token: await toolToken(this.env.MEDIA_BRIDGE_TOKEN, id, providerId),
        };
      },
    };
  }
  private async run() {
    const journal = this.journal();
    await this.ctx.storage.setAlarm(Date.now() + 15000);
    try {
      await this.exclusive(() => new TutorRunner(journal, this.services()).step());
    } finally {
      await journal.schedule();
    }
  }
  async alarm() {
    if (this.stepping) return this.stepping;
    this.stepping = this.run();
    try {
      await this.stepping;
    } finally {
      this.stepping = undefined;
    }
  }
}
