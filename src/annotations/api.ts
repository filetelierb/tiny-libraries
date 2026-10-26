import type { AnnotationSummary } from '../../shared/annotations';
import { api } from '../api';

export async function listAnnotations(sessionId: string, sourceId?: string) {
  if (sourceId) return queryAnnotations(sessionId, [sourceId]);
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

export async function queryAnnotations(
  sessionId: string,
  sourceIds: string[],
  includeSession = false,
) {
  const items: AnnotationSummary[] = [];
  let after: string | null = null;
  do {
    const page: { items: AnnotationSummary[]; nextCursor: string | null } = await api(
      '/annotations/query',
      'POST',
      { sessionId, sourceIds, includeSession, after },
    );
    items.push(...page.items);
    after = page.nextCursor;
  } while (after);
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
