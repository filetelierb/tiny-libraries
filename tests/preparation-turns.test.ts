import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimTurn,
  noTurns,
  PREPARATION_TURNS,
  releaseTurn,
  TURN_LEASE_MS,
  type Turns,
} from '../shared/preparation-turns';

test('up to PREPARATION_TURNS jobs prepare at once and the rest wait in order', () => {
  let turns: Turns = noTurns();
  const ask = (id: string, now: number) => {
    const result = claimTurn(turns, id, now);
    turns = result.turns;
    return result.granted ? 'turn' : result.position;
  };
  for (let i = 0; i < PREPARATION_TURNS; i++) assert.equal(ask(`active-${i}`, i), 'turn');
  // The next two asks line up behind the active set in arrival order.
  const first = PREPARATION_TURNS;
  assert.equal(ask(`waiter-0`, first), 1);
  assert.equal(ask(`waiter-1`, first + 1), 2);
  assert.equal(ask(`active-0`, first + 2), 'turn', 'a job keeps its turn while it renews it');
  turns = releaseTurn(turns, 'active-0', first + 3);
  assert.equal(ask(`waiter-1`, first + 4), 2, 'a later job does not pass one that waited longer');
  assert.equal(ask(`waiter-0`, first + 5), 'turn');
  assert.equal(ask(`waiter-1`, first + 6), 1);
});

test('a turn nobody renews frees up', () => {
  let turns: Turns = noTurns();
  for (let i = 0; i < PREPARATION_TURNS; i++)
    turns = claimTurn(turns, `active-${i}`, 0).turns;
  assert.equal(claimTurn(turns, 'waiter', 1000).granted, false);
  assert.equal(claimTurn(turns, 'waiter', TURN_LEASE_MS + 1).granted, true);
});
