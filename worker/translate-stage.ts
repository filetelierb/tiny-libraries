import { PARALLEL_CALLS, runAtOnce } from '../shared/parallel';
import type { Segment } from '../shared/domain';

const BATCH_SEGMENTS = 80;
export const translationKey = (start: number) => `translation:${start}`;

export type TranslationStore = {
  get(key: string): Promise<Segment[] | undefined>;
  put(key: string, value: Segment[]): Promise<void>;
};

/**
 * One step of the translation stage: translates the next batches together, saving each as it
 * finishes so a retry repeats only what is missing. Stopping between steps lets the job renew
 * its turn. Returns every translated segment in source order, or null while batches remain.
 */
export async function translateStep<Usage>(
  segments: Segment[],
  store: TranslationStore,
  translate: (batch: Segment[]) => Promise<{ translated: Segment[]; usage?: Usage }>,
  onBatch: (completed: number, total: number, usage?: Usage) => Promise<void>,
) {
  const starts: number[] = [];
  for (let start = 0; start < segments.length; start += BATCH_SEGMENTS) starts.push(start);
  const saved = await Promise.all(starts.map((start) => store.get(translationKey(start))));
  const missing = starts.filter((_, index) => !saved[index]);
  let completed = starts.length - missing.length;
  await runAtOnce(missing.slice(0, PARALLEL_CALLS), PARALLEL_CALLS, async (start) => {
    const { translated, usage } = await translate(segments.slice(start, start + BATCH_SEGMENTS));
    await store.put(translationKey(start), translated);
    await onBatch(++completed, starts.length, usage);
  });
  if (missing.length > PARALLEL_CALLS) return null;
  const batches = await Promise.all(starts.map((start) => store.get(translationKey(start))));
  return batches.flatMap((batch) => batch!);
}
