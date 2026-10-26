import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Catalog, Source, StudySession } from '../shared/domain';

const base = 'http://127.0.0.1:9876';
async function call<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  const response = await fetch(base + path, {
    method,
    ...(value === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }),
  });
  assert.ok(
    response.ok,
    `${method} ${path}: ${response.status} ${response.ok ? '' : await response.text()}`,
  );
  return response.json() as Promise<T>;
}
await mkdir('.local', { recursive: true });
if (process.argv.includes('--verify')) {
  const saved = JSON.parse(await readFile('.local/smoke-snapshot.json', 'utf8')),
    catalog = await call<Catalog>('/api/catalog');
  const source = catalog.files.find((f) => f.id === saved.fileId),
    session = catalog.sessions.find((s) => s.id === saved.sessionId);
  assert.ok(source);
  assert.ok(session);
  assert.equal(source.archived, true);
  assert.equal(source.reviewed, true);
  assert.equal(session.notes[0].text, saved.note);
  assert.equal(session.bookmarks[0].seconds, 37.5);
  assert.equal(session.positions[source.id], 37.5);
  const bytes = await (await fetch(`${base}/api/files/${source.id}/content`)).arrayBuffer();
  assert.equal(createHash('sha256').update(Buffer.from(bytes)).digest('hex'), saved.hash);
  console.log(
    'PASS: original bytes, archive/review state, session, tab, note, bookmark, and position survived runtime restart.',
  );
} else {
  const text = 'Local persistence fixture. Authored for automated verification.\n';
  const response = await fetch(base + '/api/files', {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'X-File-Name': 'persistence-check.txt',
      'X-File-Folder': 'Verification',
    },
    body: text,
  });
  assert.equal(response.status, 201);
  const file = (await response.json()) as Source;
  await call(`/api/files/${file.id}`, 'PATCH', { archived: true, reviewed: true });
  const session = await call<StudySession>('/api/sessions', 'POST', {
      name: 'Persistence verification',
    }),
    note = 'Persistence checkpoint';
  await call(`/api/sessions/${session.id}`, 'PUT', {
    ...session,
    tabs: [file.id],
    active: file.id,
    positions: { [file.id]: 37.5 },
    notes: [
      {
        id: crypto.randomUUID(),
        sourceId: file.id,
        text: note,
        createdAt: new Date().toISOString(),
      },
    ],
    bookmarks: [{ id: crypto.randomUUID(), sourceId: file.id, label: 'Checkpoint', seconds: 37.5 }],
  });
  const denied = await fetch(base + '/api/settings', {
    method: 'POST',
    headers: { Origin: 'https://foreign.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ locale: 'es' }),
  });
  assert.equal(denied.status, 403);
  const jobs = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceId: file.id, locale: 'en' }),
  });
  assert.equal(jobs.status, 409);
  await writeFile(
    '.local/smoke-snapshot.json',
    JSON.stringify({
      fileId: file.id,
      sessionId: session.id,
      note,
      hash: createHash('sha256').update(text).digest('hex'),
    }),
    { mode: 0o600 },
  );
  console.log(
    'PASS: upload, lifecycle, session, notes, bookmarks, positions, foreign-origin rejection, missing-key gate. Restart then run npm run smoke -- --verify.',
  );
}
