import type { AnnotationSummary } from '../../shared/annotations';
import { api } from '../api';

export async function listAnnotations(sessionId: string, sourceId?: string) {
  const items: AnnotationSummary[] = [];
  let after: string | null = null;
  do {
    const query = new URLSearchParams({
      sessionId,
      ...(sourceId ? { sourceId } : {}),
      ...(after ? { after } : {}),
    });
    const page = await api<{ items: AnnotationSummary[]; nextCursor: string | null }>(
      `/annotations?${query}`,
    );
    items.push(...page.items);
    after = page.nextCursor;
  } while (after);
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
