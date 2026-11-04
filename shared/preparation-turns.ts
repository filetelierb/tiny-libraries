/**
 * Preparation runs a few files at a time across the whole app, so a course of many files does
 * not read every video and call the model for all of them at once. A job holds a turn while
 * it works and renews it at each step; the others wait in line, first come, first served.
 */
export const PREPARATION_TURNS = 6;
/** A turn nobody renews is free again, so a job that stopped cannot keep others waiting. */
export const TURN_LEASE_MS = 6 * 60 * 1000;
/** A job that stops asking leaves the line. */
const WAIT_LEASE_MS = 2 * 60 * 1000;

export type Turns = {
  holders: Record<string, number>;
  waiting: Record<string, { since: number; seen: number }>;
};
export const noTurns = (): Turns => ({ holders: {}, waiting: {} });

/** Expired turns and forgotten places in line are dropped. */
function tidy(turns: Turns, now: number): Turns {
  return {
    holders: Object.fromEntries(Object.entries(turns.holders).filter(([, until]) => until > now)),
    waiting: Object.fromEntries(
      Object.entries(turns.waiting).filter(([, place]) => place.seen + WAIT_LEASE_MS > now),
    ),
  };
}

/**
 * A job asks for a turn: it keeps or gets one while fewer than `PREPARATION_TURNS` are held
 * and nobody before it in line is waiting; otherwise it learns its place in line, from 1.
 */
export function claimTurn(current: Turns, id: string, now: number) {
  const turns = tidy(current, now);
  const since = turns.waiting[id]?.since ?? now;
  // Jobs that started waiting at the same moment go in the order of their ids.
  const ahead = Object.entries(turns.waiting).filter(
    ([other, place]) =>
      other !== id && (place.since < since || (place.since === since && other < id)),
  );
  const free = PREPARATION_TURNS - Object.keys(turns.holders).filter((key) => key !== id).length;
  if (id in turns.holders || ahead.length < free) {
    delete turns.waiting[id];
    turns.holders[id] = now + TURN_LEASE_MS;
    return { turns, granted: true as const };
  }
  turns.waiting[id] = { since, seen: now };
  return { turns, granted: false as const, position: ahead.length + 1 };
}

export function releaseTurn(current: Turns, id: string, now: number): Turns {
  const turns = tidy(current, now);
  delete turns.holders[id];
  delete turns.waiting[id];
  return turns;
}
