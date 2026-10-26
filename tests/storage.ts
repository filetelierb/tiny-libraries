import type { GlossaryStorage } from '../worker/glossary';

export class MemoryStore {
  data = new Map<string, unknown>();
  queue: Promise<unknown> = Promise.resolve();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put(key: string, value: unknown) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    return this.data.delete(key);
  }
  async list<T>(
    options: {
      prefix?: string;
      limit?: number;
      startAfter?: string;
      end?: string;
      reverse?: boolean;
    } = {},
  ) {
    let items = [...this.data.entries()]
      .filter(
        ([key]) =>
          (!options.prefix || key.startsWith(options.prefix)) &&
          (!options.startAfter || key > options.startAfter) &&
          (!options.end || key < options.end),
      )
      .sort(([a], [b]) => a.localeCompare(b));
    if (options.reverse) items.reverse();
    return new Map(
      items.slice(0, options.limit).map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }
  transaction<T>(callback: (tx: this) => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      const snapshot = structuredClone(this.data);
      try {
        return await callback(this);
      } catch (error) {
        this.data = snapshot;
        throw error;
      }
    });
    this.queue = next.catch(() => {});
    return next;
  }
  storage() {
    return this as unknown as GlossaryStorage;
  }
}
