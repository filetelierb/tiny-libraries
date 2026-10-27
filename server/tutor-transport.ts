import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, chmod, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  tutorCompletionSchema,
  transportSnapshotSchema,
  transportTerminal,
  type TransportSnapshot,
  type TutorCompletion,
} from '../shared/tutor-transport';
import { TutorStream } from './tutor-stream';

export class TutorTransportError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
type Saved = TransportSnapshot & { owner: string };
type Active = { controller: AbortController; stream: TutorStream; task?: Promise<void> };
export type TutorProvider = (url: string, options: RequestInit) => Promise<Response>;
class ProviderRejection extends Error {}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

async function saveJson(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } catch (error) {
    if (
      !['EINVAL', 'EPERM', 'EISDIR', 'ENOTSUP'].includes(
        (error as NodeJS.ErrnoException).code || '',
      )
    )
      throw error;
  } finally {
    await directory.close();
  }
}

/** A browser connection never owns a provider request's lifetime. */
export class TutorTransport {
  private readonly owner = randomUUID();
  private readonly active = new Map<string, Active>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly faults = new Set<string>();
  private closing = false;
  private stopping?: Promise<void>;
  constructor(
    private readonly root: string,
    private readonly provider: TutorProvider = fetch,
    private readonly timeoutMs = 20 * 60 * 1000,
  ) {}

  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
  }
  private path(id: string, file: string) {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new TutorTransportError('Invalid stream request identity');
    return join(this.root, id, file);
  }
  private async read(id: string): Promise<Saved | null> {
    const path = this.path(id, 'status.json');
    try {
      if ((await stat(path)).size > 4 * 1024 * 1024)
        throw new TutorTransportError('Local stream state exceeds its limit', 500);
      const value = JSON.parse(await readFile(path, 'utf8'));
      const snapshot = transportSnapshotSchema.parse(value);
      if (snapshot.id !== id || typeof value.owner !== 'string')
        throw new TutorTransportError('Invalid local stream state', 500);
      return { ...snapshot, owner: value.owner };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }
  private exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const pending = (this.locks.get(id) || Promise.resolve()).catch(() => {}).then(operation);
    this.locks.set(id, pending);
    const cleanup = () => {
      if (this.locks.get(id) === pending) this.locks.delete(id);
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }
  private async publish(value: Saved) {
    await saveJson(this.path(value.id, 'status.json'), value);
    return transportSnapshotSchema.parse(value);
  }
  private async recover(value: Saved) {
    if (
      !transportTerminal(value.status) &&
      (value.owner !== this.owner || !this.active.has(value.id))
    ) {
      value = {
        ...value,
        status: 'interrupted',
        sequence: value.sequence + 1,
        updatedAt: new Date().toISOString(),
        error:
          'The local provider process stopped. Partial text is retained; retry explicitly to continue.',
      };
      await this.publish(value);
    }
    return value;
  }
  async get(id: string): Promise<TransportSnapshot | null> {
    return this.exclusive(id, async () => {
      if (this.faults.has(id))
        throw new TutorTransportError(
          'Unable to save local stream state. Check available disk space.',
          507,
        );
      const value = await this.read(id);
      return value ? transportSnapshotSchema.parse(await this.recover(value)) : null;
    });
  }
  async start(id: string, credential: string, input: unknown) {
    const body = tutorCompletionSchema.parse(input),
      serialized = JSON.stringify(body),
      fingerprint = hash(serialized);
    if (Buffer.byteLength(serialized) > 32 * 1024 * 1024)
      throw new TutorTransportError('Model request exceeds 32 MB', 413);
    if (!credential || credential.length > 1024)
      throw new TutorTransportError('Meta credential is missing');
    return this.exclusive(id, async () => {
      if (this.closing)
        throw new TutorTransportError('The local provider process is stopping', 503);
      let previous = await this.read(id);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new TutorTransportError(
            'Stream retry used different context or generation settings',
            409,
          );
        previous = await this.recover(previous);
        return transportSnapshotSchema.parse(previous);
      }
      const directory = dirname(this.path(id, 'request.json'));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryInfo = await lstat(directory);
      if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink())
        throw new TutorTransportError('Invalid local stream directory', 500);
      await chmod(directory, 0o700);
      // A request file without a status cannot have reached the provider.
      try {
        const original = await readFile(this.path(id, 'request.json'), 'utf8');
        if (hash(original) !== fingerprint)
          throw new TutorTransportError('Stream identity already contains different input', 409);
      } catch (error) {
        if (!isMissing(error)) throw error;
        await saveJson(this.path(id, 'request.json'), body);
      }
      const now = new Date().toISOString();
      const accepted: Saved = {
        id,
        owner: this.owner,
        fingerprint,
        status: 'accepted',
        sequence: 0,
        text: '',
        toolNames: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.publish(accepted);
      const active: Active = { controller: new AbortController(), stream: new TutorStream() };
      this.active.set(id, active);
      active.task = this.run(id, credential, body, active).catch(() => {
        this.faults.add(id);
      });
      return transportSnapshotSchema.parse(accepted);
    });
  }
  private async update(
    id: string,
    active: Active,
    patch: Partial<Pick<TransportSnapshot, 'status' | 'result' | 'error'>> = {},
  ) {
    return this.exclusive(id, async () => {
      const previous = await this.read(id);
      if (!previous) throw new Error('Local stream state is unavailable');
      if (transportTerminal(previous.status)) return transportSnapshotSchema.parse(previous);
      return this.publish({
        ...previous,
        ...patch,
        sequence: previous.sequence + 1,
        text: active.stream.text,
        toolNames: active.stream.toolNames,
        updatedAt: new Date().toISOString(),
      });
    });
  }
  private async run(id: string, credential: string, body: TutorCompletion, active: Active) {
    try {
      await this.update(id, active, { status: 'running' });
      if (active.controller.signal.aborted) return;
      const response = await this.provider('https://api.meta.ai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, stream: true }),
        signal: AbortSignal.any([active.controller.signal, AbortSignal.timeout(this.timeoutMs)]),
      });
      if (!response.ok) {
        let detail = '';
        const reader = response.body?.getReader();
        if (reader) {
          const decoder = new TextDecoder();
          let length = 0;
          try {
            for (;;) {
              const part = await reader.read();
              if (part.done) break;
              length += part.value.length;
              if (length > 16384) break;
              detail += decoder.decode(part.value, { stream: true });
            }
          } finally {
            await reader.cancel();
          }
        }
        let message = '';
        try {
          const data = JSON.parse(detail);
          if (typeof data.error?.message === 'string') message = data.error.message;
        } catch {}
        throw new ProviderRejection(
          response.status === 401
            ? 'Meta rejected the API key. Replace it in Settings.'
            : `Meta returned HTTP ${response.status}.${message ? ` ${message}` : ''}`,
        );
      }
      if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body)
        throw new Error('Meta did not return a token stream');
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let length = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.length;
          if (length > 8 * 1024 * 1024) throw new Error('Meta stream exceeds 8 MB');
          active.stream.push(decoder.decode(part.value, { stream: true }));
          await this.update(id, active);
          if (active.stream.done) break;
        }
        active.stream.push(decoder.decode());
        const result = active.stream.finish();
        await this.update(id, active, { status: 'completed', result });
      } finally {
        await reader.cancel();
      }
    } catch (error) {
      await this.update(id, active, {
        status: error instanceof ProviderRejection ? 'failed' : 'interrupted',
        error: (error instanceof Error ? error.message : 'Model stream interrupted')
          .replaceAll(credential, '[redacted]')
          .slice(0, 500),
      });
    } finally {
      if (this.active.get(id) === active) this.active.delete(id);
    }
  }
  async cancel(id: string) {
    return this.exclusive(id, async () => {
      const previous = await this.read(id);
      if (!previous) return null;
      if (transportTerminal(previous.status)) return transportSnapshotSchema.parse(previous);
      const active = this.active.get(id);
      const value = await this.publish({
        ...previous,
        status: 'cancelled',
        text: active?.stream.text ?? previous.text,
        toolNames: active?.stream.toolNames ?? previous.toolNames,
        sequence: previous.sequence + 1,
        updatedAt: new Date().toISOString(),
        error: 'Stopped locally. Partial text is retained.',
      });
      active?.controller.abort();
      return value;
    });
  }
  shutdown() {
    return (this.stopping ||= this.stop());
  }
  private async stop() {
    this.closing = true;
    const active = [...this.active.entries()];
    for (const [id, value] of active) {
      await this.update(id, value, {
        status: 'interrupted',
        error:
          'The local app stopped during this reply. Partial text is retained; retry explicitly to continue.',
      });
      value.controller.abort();
    }
    await Promise.allSettled(active.map(([, value]) => value.task));
  }
}
