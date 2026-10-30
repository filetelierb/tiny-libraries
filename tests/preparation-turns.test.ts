import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimTurn,
  noTurns,
  releaseTurn,
  TURN_LEASE_MS,
  type Turns,
} from '../shared/preparation-turns';

test('two jobs prepare at a time and the rest wait in the order they asked', () => {
  let turns: Turns = noTurns();
  const ask = (id: string, now: number) => {
    const result = claimTurn(turns, id, now);
    turns = result.turns;
    return result.granted ? 'turn' : result.position;
  };
  assert.equal(ask('a', 0), 'turn');
  assert.equal(ask('b', 1), 'turn');
  assert.equal(ask('c', 2), 1);
  assert.equal(ask('d', 3), 2);
  assert.equal(ask('a', 4), 'turn', 'a job keeps its turn while it renews it');
  turns = releaseTurn(turns, 'a', 5);
  assert.equal(ask('d', 6), 2, 'a later job does not pass one that waited longer');
  assert.equal(ask('c', 7), 'turn');
  assert.equal(ask('d', 8), 1);
});

test('a turn nobody renews frees up', () => {
  let turns: Turns = noTurns();
  turns = claimTurn(turns, 'a', 0).turns;
  turns = claimTurn(turns, 'b', 0).turns;
  assert.equal(claimTurn(turns, 'c', 1000).granted, false);
  assert.equal(claimTurn(turns, 'c', TURN_LEASE_MS + 1).granted, true);
});
