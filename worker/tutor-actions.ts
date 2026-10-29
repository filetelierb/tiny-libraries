import type { Annotation, AnnotationSummary } from '../shared/annotations';
import { kindFor, type Directory, type Source } from '../shared/domain';
import { directoryState, sourceState } from '../shared/directories';
import type { GlossaryEntry } from '../shared/glossary';
import {
  actionState,
  confirmedOps,
  markdownDocument,
  type TutorAction,
  type TutorActionRecord,
} from '../shared/tutor-actions';
import type { GlossaryStorage } from './glossary';

export class TutorActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
/** A request to one of the library's own routes, answered as the app would be. */
export type LibraryCall = (method: string, path: string, body?: unknown) => Promise<unknown>;
const recordKey = (id: string) => `tutor-action:${id}`;

async function snapshot(storage: GlossaryStorage) {
  const [files, directories] = await Promise.all([
    storage.list<Source>({ prefix: 'file:' }),
    storage.list<Directory>({ prefix: 'directory:' }),
  ]);
  return { files: [...files.values()], directories: [...directories.values()] };
}
const join = (parent: string, name: string) => [parent, name].filter(Boolean).join('/');
const display = (path: string) => path || '/';

/** The record an action targets, checked before anything changes. */
async function item(storage: GlossaryStorage, type: 'file' | 'folder', id: string) {
  if (type === 'file') {
    const file = await storage.get<Source>(`file:${id}`);
    if (!file) throw new TutorActionError('File not found; call browse_library for its id', 404);
    return { file, label: join(file.folder, file.name) };
  }
  const folder = await storage.get<Directory>(`directory:${id}`);
  if (!folder) throw new TutorActionError('Folder not found; call browse_library for its id', 404);
  return { folder, label: folder.path };
}
async function note(storage: GlossaryStorage, id: string, sessionId: string) {
  const value = await storage.get<Annotation>(`annotation:${id}`);
  if (!value || value.sessionId !== sessionId)
    throw new TutorActionError('Note not found in this session; call list_notes for its id', 404);
  return value;
}
async function concept(storage: GlossaryStorage, id: string) {
  const entry = await storage.get<GlossaryEntry>(`concept-entry:${id}`);
  if (!entry) throw new TutorActionError('Concept not found; call search_glossary', 404);
  return entry;
}

/** The action as it will run, with the names the student sees in the chat. */
async function prepare(
  storage: GlossaryStorage,
  action: TutorAction,
  sessionId: string,
): Promise<{ action: TutorAction; subject: string; detail?: string }> {
  switch (action.op) {
    case 'folder.create':
      return { action, subject: join(action.parentPath, action.name) };
    case 'item.rename': {
      const target = await item(storage, action.type, action.id);
      // A renamed file keeps its extension, as in the app.
      const extension = target.file?.name.match(/\.[^.]+$/)?.[0] || '';
      const name =
        target.file && kindFor(action.name) !== target.file.kind
          ? `${action.name}${extension}`
          : action.name;
      return { action: { ...action, name }, subject: target.label, detail: name };
    }
    case 'item.move': {
      const target = await item(storage, action.type, action.id);
      return { action, subject: target.label, detail: display(action.destination) };
    }
    case 'item.archive':
    case 'item.unarchive':
    case 'item.trash':
    case 'item.restore':
    case 'item.delete':
      return { action, subject: (await item(storage, action.type, action.id)).label };
    case 'note.create':
      if (action.kind === 'bookmark' && !action.segment)
        throw new TutorActionError('A bookmark needs a passage of a selected reference');
      return { action, subject: action.title };
    case 'note.update': {
      const current = await note(storage, action.id, sessionId);
      return {
        action,
        subject: current.title || current.text.slice(0, 80),
        ...(action.title && action.title !== current.title ? { detail: action.title } : {}),
      };
    }
    case 'note.delete': {
      const current = await note(storage, action.id, sessionId);
      return { action, subject: current.title || current.text.slice(0, 80) };
    }
    case 'concept.merge': {
      if (action.sourceId === action.targetId)
        throw new TutorActionError('Choose two different concepts');
      const [source, target] = await Promise.all([
        concept(storage, action.sourceId),
        concept(storage, action.targetId),
      ]);
      return { action, subject: source.term, detail: target.term };
    }
    case 'test.start': {
      const names: string[] = [];
      for (const id of action.sourceIds) {
        const file = await storage.get<Source>(`file:${id}`);
        if (!file) throw new TutorActionError('File not found; call browse_library', 404);
        names.push(file.name);
      }
      return {
        action,
        subject: names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : ''),
        detail: `${action.count} · ${action.difficulty}`,
      };
    }
  }
}

/** Runs the action through the library's routes; the same checks as the app apply. */
async function perform(
  storage: GlossaryStorage,
  call: LibraryCall,
  record: TutorActionRecord,
  sessionId: string,
): Promise<{ testId?: string }> {
  const action = record.action;
  const target = (type: 'file' | 'folder', id: string) =>
    type === 'file' ? `/api/files/${id}` : `/api/directories/${id}`;
  switch (action.op) {
    case 'folder.create':
      await call('POST', '/api/directories', { parentPath: action.parentPath, name: action.name });
      return {};
    case 'item.rename':
      await call(
        'PATCH',
        target(action.type, action.id),
        action.type === 'file' ? { name: action.name } : { action: 'rename', name: action.name },
      );
      return {};
    case 'item.move':
      await call(
        'PATCH',
        target(action.type, action.id),
        action.type === 'file'
          ? { folder: action.destination }
          : { action: 'move', parentPath: action.destination },
      );
      return {};
    case 'item.archive':
    case 'item.unarchive':
    case 'item.trash':
    case 'item.restore': {
      const verb = action.op.slice('item.'.length) as 'archive' | 'unarchive' | 'trash' | 'restore';
      await call(
        'PATCH',
        target(action.type, action.id),
        action.type === 'folder'
          ? { action: verb }
          : verb === 'archive' || verb === 'unarchive'
            ? { archived: verb === 'archive' }
            : { trashed: verb === 'trash' },
      );
      return {};
    }
    case 'item.delete':
      await call('DELETE', target(action.type, action.id));
      return {};
    case 'note.create':
      await call('PUT', `/api/annotations/${record.id}`, {
        id: record.id,
        kind: action.kind,
        sessionId,
        sourceId: action.sourceId,
        sourceVersion: action.sourceVersion,
        title: action.title,
        document: markdownDocument(action.text || action.title),
        location: action.segment
          ? {
              quote: action.segment.text.slice(0, 8000),
              ...(action.segment.page ? { page: action.segment.page } : {}),
              ...(action.segment.start != null ? { seconds: action.segment.start } : {}),
            }
          : {},
        strokes: [],
        origin: 'tutor',
        references: action.sourceId ? [action.sourceId] : [],
        expectedRevision: 0,
        mutationId: record.id,
      });
      return {};
    case 'note.update': {
      const current = await note(storage, action.id, sessionId);
      if (current.captures?.length || current.capture || current.stamps?.length)
        throw new TutorActionError('This note has captures; edit it in the app');
      await call('PUT', `/api/annotations/${current.id}`, {
        id: current.id,
        kind: current.kind || 'annotation',
        sessionId: current.sessionId,
        sourceId: current.sourceId,
        sourceVersion: current.sourceVersion,
        title: action.title ?? current.title,
        document: action.text === undefined ? current.document : markdownDocument(action.text),
        location: current.location,
        strokes: current.strokes,
        origin: current.origin,
        references: current.references,
        expectedRevision: current.revision,
        mutationId: record.id,
      });
      return {};
    }
    case 'note.delete': {
      const current = await note(storage, action.id, sessionId);
      if (!current.deleted)
        await call('PATCH', `/api/annotations/${current.id}`, {
          deleted: true,
          expectedRevision: current.revision,
        });
      return {};
    }
    case 'concept.merge': {
      const [source, target] = await Promise.all([
        concept(storage, action.sourceId),
        concept(storage, action.targetId),
      ]);
      await call('POST', '/api/glossary/merge', {
        sourceId: source.id,
        sourceVersion: source.version,
        targetId: target.id,
        targetVersion: target.version,
        mutationId: record.id,
      });
      return {};
    }
    case 'test.start':
      await call('POST', '/api/assessments', {
        requestId: record.id,
        sessionId,
        config: {
          sourceIds: action.sourceIds,
          count: action.count,
          difficulty: action.difficulty,
          guidance: action.guidance,
          priorReportIds: [],
        },
      });
      return { testId: record.id };
  }
}

async function execute(
  storage: GlossaryStorage,
  call: LibraryCall,
  record: TutorActionRecord,
  sessionId: string,
) {
  try {
    const { testId } = await perform(storage, call, record, sessionId);
    const done: TutorActionRecord = {
      ...record,
      state: 'done',
      ...(testId ? { testId, sessionId } : {}),
      updatedAt: new Date().toISOString(),
    };
    delete done.error;
    await storage.put(recordKey(record.id), done);
    return done;
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'Library action failed').slice(
      0,
      500,
    );
    await storage.put(recordKey(record.id), {
      ...record,
      state: 'failed',
      error: message,
      updatedAt: new Date().toISOString(),
    });
    throw error instanceof TutorActionError ? error : new TutorActionError(message, 409);
  }
}

/**
 * Runs an action the tutor asked for, or records it as a proposal when it deletes or merges.
 * A repeated call with the same id returns what the first one did.
 */
export async function requestTutorAction(
  storage: GlossaryStorage,
  call: LibraryCall,
  input: { id: string; conversationId: string; sessionId: string; action: TutorAction },
) {
  const existing = await storage.get<TutorActionRecord>(recordKey(input.id));
  if (existing) {
    if (existing.state === 'failed' && existing.status === 'done')
      throw new TutorActionError(existing.error || 'Library action failed', 409);
    return existing;
  }
  const prepared = await prepare(storage, input.action, input.sessionId);
  const now = new Date().toISOString();
  const proposed = confirmedOps.has(input.action.op);
  const record: TutorActionRecord = {
    id: input.id,
    conversationId: input.conversationId,
    op: input.action.op,
    action: prepared.action,
    subject: prepared.subject.slice(0, 300),
    ...(prepared.detail ? { detail: prepared.detail.slice(0, 300) } : {}),
    status: proposed ? 'proposed' : 'done',
    state: proposed ? 'proposed' : 'running',
    createdAt: now,
    updatedAt: now,
  };
  await storage.put(recordKey(record.id), record);
  return proposed ? record : execute(storage, call, record, input.sessionId);
}

export async function tutorActionStatus(storage: GlossaryStorage, id: string) {
  const record = await storage.get<TutorActionRecord>(recordKey(id));
  if (!record) throw new TutorActionError('Action not found', 404);
  return actionState(record);
}

/** The student's answer to a proposal. Only a pending or failed proposal can run. */
export async function decideTutorAction(
  storage: GlossaryStorage,
  call: LibraryCall,
  id: string,
  decision: 'confirm' | 'cancel',
  sessionId: (conversationId: string) => Promise<string>,
) {
  const claimed = await storage.transaction(async (tx) => {
    const record = await tx.get<TutorActionRecord>(recordKey(id));
    if (!record || record.status !== 'proposed')
      throw new TutorActionError('Proposal not found', 404);
    if (record.state !== 'proposed' && record.state !== 'failed') return { record, run: false };
    const next: TutorActionRecord = {
      ...record,
      state: decision === 'confirm' ? 'running' : 'cancelled',
      updatedAt: new Date().toISOString(),
    };
    await tx.put(recordKey(id), next);
    return { record: next, run: decision === 'confirm' };
  });
  if (!claimed.run) return actionState(claimed.record);
  try {
    return actionState(
      await execute(storage, call, claimed.record, await sessionId(claimed.record.conversationId)),
    );
  } catch {
    return tutorActionStatus(storage, id);
  }
}

/** What the tutor reads to find records: the library's folders and files, or the session's notes. */
export async function readLibrary(
  storage: GlossaryStorage,
  call: LibraryCall,
  input:
    | { view: 'library'; query?: string }
    | { view: 'notes'; kind: 'annotation' | 'bookmark'; sourceId?: string },
  sessionId: string,
) {
  const { files, directories } = await snapshot(storage);
  if (input.view === 'notes') {
    const params = new URLSearchParams({ sessionId, kind: input.kind });
    if (input.sourceId) params.set('sourceId', input.sourceId);
    const { items } = (await call('GET', `/api/annotations?${params}`)) as {
      items: AnnotationSummary[];
    };
    const names = new Map(files.map((file) => [file.id, file.name]));
    return items.map((item) => ({
      id: item.id,
      title: item.title,
      text: item.text.slice(0, 400),
      source: item.sourceId ? names.get(item.sourceId) || null : null,
      sourceId: item.sourceId,
      location: item.location,
      deleted: item.deleted,
      origin: item.origin,
    }));
  }
  const prepared = new Set(
    [...(await storage.list({ prefix: 'learning:' })).keys()].map((key) =>
      key.slice('learning:'.length),
    ),
  );
  const needle = input.query?.trim().toLocaleLowerCase();
  const matches = (text: string) => !needle || text.toLocaleLowerCase().includes(needle);
  const shown = files
    .filter((file) => matches(join(file.folder, file.name)))
    .sort((a, b) => join(a.folder, a.name).localeCompare(join(b.folder, b.name)));
  return {
    folders: directories
      .filter((folder) => matches(folder.path))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, 200)
      .map((folder) => ({
        id: folder.id,
        path: folder.path,
        state: directoryState(folder.path, directories),
      })),
    files: shown.slice(0, 200).map((file) => ({
      id: file.id,
      name: file.name,
      folder: display(file.folder),
      kind: file.kind,
      state: sourceState(file, directories),
      prepared: file.kind !== 'artifact' && prepared.has(file.id),
    })),
    ...(shown.length > 200 ? { omittedFiles: shown.length - 200 } : {}),
  };
}
