import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { newProjectFolder } from '../server/disk';

test('a new project folder uses a safe name under projects/ and avoids duplicates', async () => {
  const base = await mkdtemp(join(tmpdir(), 'tl-data-'));
  await mkdir(join(base, 'projects'), { recursive: true });
  const first = newProjectFolder(base, 'CS223A – Introduction to Robotics', []);
  assert.equal(dirname(first), join(base, 'projects'));
  assert.equal(basename(first), 'CS223A – Introduction to Robotics');
  const second = newProjectFolder(base, 'CS223A – Introduction to Robotics', [first]);
  assert.equal(basename(second), 'CS223A – Introduction to Robotics (2)');
  const stripped = newProjectFolder(base, 'My / project *', []);
  assert.equal(basename(stripped), 'My project');
  const empty = newProjectFolder(base, '   ', []);
  assert.equal(basename(empty), 'project');
});
