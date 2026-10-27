/**
 * Unsaved reading positions survive a reload: each change is kept in this browser
 * until the session save that carries it succeeds.
 */
type Drafts = Record<string, { value: number; at: number }>;
const key = (sessionId: string) => `tl:position-drafts:${sessionId}`;

export function readDrafts(sessionId: string, storage: Pick<Storage, 'getItem'> = localStorage) {
  try {
    const value = JSON.parse(storage.getItem(key(sessionId)) || '{}');
    return value && typeof value === 'object' ? (value as Drafts) : {};
  } catch {
    return {};
  }
}
function writeDrafts(sessionId: string, drafts: Drafts, storage: Pick<Storage, 'setItem'>) {
  try {
    storage.setItem(key(sessionId), JSON.stringify(drafts));
  } catch {}
}
export function recordDraft(
  sessionId: string,
  sourceId: string,
  value: number,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
  now = Date.now(),
) {
  writeDrafts(
    sessionId,
    { ...readDrafts(sessionId, storage), [sourceId]: { value, at: now } },
    storage,
  );
}
/** Forget drafts the server now holds; a newer draft for the same source stays. */
export function settleDrafts(
  sessionId: string,
  saved: Record<string, number>,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
) {
  const drafts = readDrafts(sessionId, storage);
  for (const [sourceId, draft] of Object.entries(drafts))
    if (saved[sourceId] === draft.value) delete drafts[sourceId];
  writeDrafts(sessionId, drafts, storage);
}
/** Positions with any unsaved drafts applied, or null when nothing needs recovery. */
export function recoverPositions(
  sessionId: string,
  positions: Record<string, number>,
  storage: Pick<Storage, 'getItem'> = localStorage,
) {
  const drafts = Object.entries(readDrafts(sessionId, storage)).filter(
    ([sourceId, draft]) => Number.isFinite(draft?.value) && positions[sourceId] !== draft.value,
  );
  if (!drafts.length) return null;
  return { ...positions, ...Object.fromEntries(drafts.map(([id, draft]) => [id, draft.value])) };
}
