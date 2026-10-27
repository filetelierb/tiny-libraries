import {
  annotationSnapshotSchema,
  plainDocument,
  richDocumentSchema,
  drawingSchema,
  type Annotation,
  type SourceLocation,
} from '../../shared/annotations';
import type { Source } from '../../shared/domain';
import { noteDraftSchema, editorDrafts, browserDraftLane, type NoteDraft } from './draftStore';
import { CaptureWorkspace, locationStamp } from './CaptureWorkspace';

export type EditorRequest = {
  id: string;
  sourceId: string | null;
  location: SourceLocation;
  initial?: Annotation;
  markdown?: string;
  capture?: { blob?: Blob; width: number; height: number; url: string };
  references?: string[];
  origin?: 'manual' | 'tutor';
};
export type EditorSession = {
  key: string;
  previousKey: string;
  legacyKey: string;
  note: NoteDraft;
  workspace: CaptureWorkspace;
  recovered: boolean;
  incomingAdded: boolean;
  incomingSkipped: boolean;
};
const loading = new Map<string, Promise<EditorSession>>();
export function loadEditorSession(
  request: EditorRequest,
  sessionId: string,
  source: Source | null,
) {
  const legacyKey = `tl:annotation-draft:${request.initial?.id || `${sessionId}:${request.sourceId}:${JSON.stringify(request.location)}`}`;
  const version = request.initial?.sourceVersion ?? source?.version ?? null;
  const key = `${legacyKey}:v${version || 0}:${browserDraftLane()}`;
  const pending = loading.get(key);
  if (pending) return pending;
  const work = (async () => {
    const raw = await editorDrafts.get('notes', key),
      parsed = noteDraftSchema.safeParse(raw);
    if (raw !== undefined && !parsed.success)
      throw new Error(
        'This note draft cannot be read by this version. Its local data has been kept.',
      );
    const creator = request.initial?.sessionId || sessionId;
    const previousKey = `tl:note-draft:${sessionId}:${request.sourceId}`;
    let note: NoteDraft,
      recovered = parsed.success;
    if (parsed.success) {
      note = parsed.data;
      if (
        note.context.sessionId !== creator ||
        note.context.sourceId !== request.sourceId ||
        note.context.sourceVersion !== version ||
        (request.initial && note.ownerId !== request.initial.id)
      )
        throw new Error('The recovered note belongs to different source context');
    } else {
      let legacy: {
          title?: string;
          document?: unknown;
          markdown?: string;
          sourceMode?: boolean;
          strokes?: unknown;
        } | null = null,
        previous = '',
        oldRaw: string | null = null;
      try {
        oldRaw = localStorage.getItem(legacyKey);
        legacy = JSON.parse(oldRaw || 'null');
        if (!request.initial && !request.markdown)
          previous = localStorage.getItem(previousKey) || '';
      } catch {}
      const content = richDocumentSchema.safeParse(legacy?.document),
        strokes = drawingSchema.safeParse(legacy?.strokes);
      const document = content.success
        ? content.data
        : request.initial?.document || plainDocument(previous);
      note = noteDraftSchema.parse({
        format: 1,
        ownerId: request.initial?.id || request.id,
        context: { sessionId: creator, sourceId: request.sourceId, sourceVersion: version },
        stamp: crypto.randomUUID(),
        title: legacy?.title ?? request.initial?.title ?? '',
        document,
        markdown: legacy?.markdown || request.markdown || '',
        sourceMode: legacy?.sourceMode === true || !!request.markdown,
        strokes: strokes.success ? strokes.data : request.initial?.strokes || [],
        location: request.initial?.location || request.location,
        references:
          request.references || request.initial?.references || (source ? [source.id] : []),
        ...(request.initial ? { base: annotationSnapshotSchema.parse(request.initial) } : {}),
        ...(legacy ? { unverified: true } : {}),
        migratedDrafts: [
          ...(oldRaw ? [{ key: legacyKey, value: oldRaw }] : []),
          ...(previous ? [{ key: previousKey, value: previous }] : []),
        ],
      });
      recovered = !!legacy || !!previous;
      await editorDrafts.commit([{ table: 'notes', key, value: note }]);
    }
    const workspace = await CaptureWorkspace.load(
      { annotationId: note.ownerId, ...note.context },
      note.base || request.initial,
      source,
      request.location,
    );
    let incomingAdded = false;
    const incomingSkipped = !!request.capture?.blob && workspace.getSnapshot().items.length >= 12;
    if (request.capture?.blob && !incomingSkipped) {
      const before = workspace.getSnapshot().items.length;
      await workspace.add(
        request.capture.blob,
        source?.kind === 'pdf' ? 'pdf_page' : source?.kind === 'video' ? 'video_frame' : 'image',
        '',
        locationStamp(
          source ? { ...source, version: note.context.sourceVersion || source.version } : null,
          request.location,
        ),
        true,
        source
          ? {
              id: source.id,
              version: note.context.sourceVersion || source.version,
              name: source.name,
            }
          : undefined,
      );
      incomingAdded = workspace.getSnapshot().items.length > before;
    }
    return {
      key,
      legacyKey,
      previousKey,
      note,
      workspace,
      recovered,
      incomingAdded,
      incomingSkipped,
    };
  })();
  loading.set(key, work);
  void work
    .finally(() => {
      if (loading.get(key) === work) loading.delete(key);
    })
    .catch(() => {});
  return work;
}
