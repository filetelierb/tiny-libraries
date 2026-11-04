/**
 * How many model calls one preparation job, or one file's flashcards, makes at once. It stays
 * under the runtime's six open connections per request; more calls would only wait there.
 */
export const PARALLEL_CALLS = 5;

/**
 * Runs `run` over `items`, at most `limit` at a time, and waits for every started call. After a
 * failure nothing new starts, and the first error is thrown once the calls in flight finish, so
 * a retry never overlaps work that is still running.
 */
export async function runAtOnce<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
) {
  let next = 0,
    failed = false,
    failure: unknown;
  const worker = async () => {
    while (!failed && next < items.length) {
      try {
        await run(items[next++]);
      } catch (error) {
        if (!failed) failure = error;
        failed = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failure;
}
