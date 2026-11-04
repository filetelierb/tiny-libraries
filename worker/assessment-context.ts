import type { AnnotationSummary } from '../shared/annotations';
import { conversationMessageSources, type Conversation } from '../shared/conversations';
import type { Attempt, Directory, Learning, Source, StudySession } from '../shared/domain';
import type {
  AssessmentConfig,
  AssessmentContext,
  AssessmentGrade,
  AssessmentOption,
  AssessmentSource,
  AssessmentSummary,
} from '../shared/assessments';
import type { CardReview, CardSchedule, Flashcard } from '../shared/flashcards';
import { sourceState } from '../shared/directories';
import { validateAssessmentCitation } from '../shared/assessments';
import { readQuestionAttachments } from './tutor-attachments';
import type { GlossaryStore } from './glossary';

export class AssessmentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export async function captureStudyProgress(
  tx: GlossaryStore,
  previous: StudySession,
  incoming: StudySession,
) {
  for (const id of new Set([
    ...Object.keys(previous.positions),
    ...Object.keys(incoming.positions),
  ])) {
    const file = await tx.get<Source>(`file:${id}`);
    if (!file) continue;
    const key = `study-highwater:${id}:v${file.version}`,
      old = (await tx.get<number>(key)) ?? 0,
      next = Math.max(old, previous.positions[id] || 0, incoming.positions[id] || 0);
    if (next > old) await tx.put(key, next);
  }
}
async function sourceEvidence(
  tx: GlossaryStore,
  source: Source,
  sessions: StudySession[],
  gaps: string[] = [],
): Promise<AssessmentSource | null> {
  const learning = await tx.get<Learning>(`learning:${source.id}`);
  if (!learning || learning.sourceVersion !== source.version) return null;
  const allNotes = [
    ...(
      await tx.list<AnnotationSummary>({ prefix: `annotation-source-summary:${source.id}:` })
    ).values(),
  ].filter((n) => !n.deleted && n.sourceVersion === source.version);
  const highwater = Math.max(
    (await tx.get<number>(`study-highwater:${source.id}:v${source.version}`)) || 0,
    ...sessions.map((s) => s.positions[source.id] || 0),
  );
  const media = ['audio', 'video'].includes(source.kind),
    pdf = source.kind === 'pdf';
  const textLimit = Math.max(
    Math.floor(highwater),
    ...allNotes.map((n) =>
      n.location.quote
        ? learning.segments.findIndex((s) => s.text.includes(n.location.quote!))
        : -1,
    ),
  );
  const limit =
    source.reviewed || source.kind === 'image'
      ? null
      : media
        ? Math.max(highwater, ...allNotes.map((n) => n.location.seconds || 0))
        : pdf
          ? Math.max(1, highwater, ...allNotes.map((n) => n.location.page || 0))
          : textLimit;
  const segments = learning.segments.filter(
    (s, index) =>
      limit === null ||
      (media
        ? s.end != null && s.end <= limit
        : pdf
          ? s.page != null && s.page <= limit
          : index <= limit),
  );
  const visibleNotes = allNotes
    .filter(
      (n) =>
        limit === null ||
        (media ? (n.location.seconds || 0) <= limit : pdf ? (n.location.page || 1) <= limit : true),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (visibleNotes.length > 10)
    gaps.push(
      `${source.name}: included the ten most recently updated notes/bookmarks of ${visibleNotes.length}.`,
    );
  const notes = visibleNotes.slice(0, 10).map((n) => {
    if (n.text.length > 1200 || (n.location.quote?.length || 0) > 1200)
      gaps.push(`${source.name}: note ${n.id} is an excerpt.`);
    if (n.capture || n.strokeCount || n.captures?.length)
      gaps.push(
        `${source.name}: note ${n.id} includes images/drawings. Pixels are included only when explicitly selected as saved evidence; note text alone does not include them.`,
      );
    return {
      id: n.id,
      revision: n.revision,
      title: n.title,
      text: n.text.slice(0, 1200),
      quote: (n.location.quote || '').slice(0, 1200),
    };
  });
  return {
    id: source.id,
    version: source.version,
    name: source.name,
    kind: source.kind,
    learningVersion: learning.createdAt,
    reviewed: source.reviewed,
    limit,
    preparedCount: learning.segments.length,
    studiedCount: segments.length,
    segments,
    notes,
  };
}
export async function assessmentOptions(
  tx: GlossaryStore,
  sessionId: string,
): Promise<AssessmentOption[]> {
  const session = await tx.get<StudySession>(`session:${sessionId}`);
  if (!session) throw new AssessmentError('Study session not found.', 404);
  const files = [...(await tx.list<Source>({ prefix: 'file:' })).values()],
    directories = [...(await tx.list<Directory>({ prefix: 'directory:' })).values()],
    sessions = [...(await tx.list<StudySession>({ prefix: 'session:' })).values()],
    conversations = [...(await tx.list<Conversation>({ prefix: 'conversation:' })).values()].filter(
      (c) => c.sessionId === sessionId,
    );
  // A new test starts from the files open in the session; with none open, from what was studied.
  const open = session.resourceTabs?.flatMap((t) => t.sources) || session.tabs;
  const selected = new Set(
    open.length
      ? open
      : [
          ...session.notes.map((n) => n.sourceId),
          ...session.bookmarks.map((b) => b.sourceId),
          ...conversations.flatMap((c) => c.sourceIds),
        ],
  );
  return Promise.all(
    files
      .filter((f) => sourceState(f, directories) !== 'trash')
      .map(async (file) => {
        const evidence = await sourceEvidence(tx, file, sessions);
        return {
          sourceId: file.id,
          prepared: !!evidence,
          suggested: selected.has(file.id),
          noteCount: evidence?.notes.length || 0,
          studiedCount: evidence?.studiedCount || 0,
          preparedCount: evidence?.preparedCount || 0,
          limit: evidence?.limit ?? null,
        };
      }),
  );
}
function sampleSegments(source: AssessmentSource, budget: number, gaps: string[]) {
  if (JSON.stringify(source.segments).length <= budget) return source;
  const chosen = new Map<number, AssessmentSource['segments'][number]>();
  let size = 0;
  const count = Math.min(source.segments.length, Math.max(1, Math.floor(budget / 2000)));
  for (let i = 0; i < count; i++) {
    const index = count === 1 ? 0 : Math.round((i * (source.segments.length - 1)) / (count - 1)),
      segment = source.segments[index],
      length = JSON.stringify(segment).length;
    if (size + length <= budget || !chosen.size) {
      chosen.set(index, segment);
      size += length;
    }
  }
  const segments = [...chosen.entries()].sort(([a], [b]) => a - b).map(([, s]) => s);
  gaps.push(
    `${source.name}: assessment samples ${segments.length} of ${source.studiedCount} whole studied evidence segments. It does not cover every passage.`,
  );
  return { ...source, segments };
}
export async function captureAssessmentContext(
  tx: GlossaryStore,
  sessionId: string,
  config: AssessmentConfig,
  linkedConversations?: Conversation[],
): Promise<AssessmentContext> {
  const session = await tx.get<StudySession>(`session:${sessionId}`);
  if (!session) throw new AssessmentError('Study session not found.', 404);
  const directories = [...(await tx.list<Directory>({ prefix: 'directory:' })).values()],
    sessions = [...(await tx.list<StudySession>({ prefix: 'session:' })).values()],
    gaps: string[] = [],
    sources: AssessmentSource[] = [];
  for (const id of config.sourceIds) {
    const file = await tx.get<Source>(`file:${id}`);
    if (!file || sourceState(file, directories) === 'trash')
      throw new AssessmentError('Restore the selected source before preparing an assessment.', 409);
    const value = await sourceEvidence(tx, file, sessions, gaps);
    if (!value)
      throw new AssessmentError(`Prepare ${file.name} before including it in an assessment.`, 409);
    if (!value.segments.length)
      throw new AssessmentError(
        `${file.name} has no complete studied segment yet. Continue studying or mark the source reviewed.`,
        409,
      );
    if (value.studiedCount < value.preparedCount)
      gaps.push(
        `${file.name}: limited to saved reading progress and note/bookmark locations; ${value.studiedCount} of ${value.preparedCount} prepared segments are eligible.`,
      );
    sources.push(sampleSegments(value, Math.floor(240000 / config.sourceIds.length), gaps));
  }
  const attachments =
    config.attachmentIds === undefined
      ? undefined
      : await readQuestionAttachments(tx, sessionId, config.attachmentIds);
  const selected = new Set(config.sourceIds),
    conversation: AssessmentContext['conversation'] = [];
  const prior: AssessmentContext['prior'] = [];
  for (const id of config.priorReportIds) {
    const record = await tx.get<AssessmentSummary>(`assessment:${id}`);
    if (!record || record.sessionId !== sessionId || record.status !== 'completed')
      throw new AssessmentError('Choose a completed report from this study session.', 409);
    const grades = [
      ...(await tx.list<AssessmentGrade>({ prefix: `assessment-grade:${id}:` })).values(),
    ];
    const priorSources = [
      ...(
        await tx.list<{ id: string; version: number }>({ prefix: `assessment-source:${id}:` })
      ).values(),
    ];
    for (const grade of grades) {
      if (
        grade.citations.some((c) => {
          if ('attachmentId' in c) {
            try {
              validateAssessmentCitation(c, { sources, attachments });
              return false;
            } catch {
              return true;
            }
          }
          return (
            !selected.has(c.sourceId) ||
            !sources.some(
              (s) =>
                s.id === c.sourceId &&
                priorSources.some((old) => old.id === s.id && old.version === s.version) &&
                s.segments.some(
                  (segment) => segment.id === c.segmentId && segment.text.includes(c.quote),
                ),
            )
          );
        })
      ) {
        gaps.push(
          'Some prior report results are outside the currently selected source versions or evidence excerpts and were excluded.',
        );
        continue;
      }
      if (grade.score < 1 || grade.confidence !== 'sure')
        prior.push({
          reportId: id,
          questionId: grade.questionId,
          prompt: grade.prompt,
          responseText: grade.responseText,
          score: grade.score,
          confidence: grade.confidence,
          feedback: grade.feedback,
          citations: grade.citations,
        });
    }
  }
  const studyHistory = await captureStudyHistory(tx, config.sourceIds, sources);
  const context = {
    sources,
    ...(attachments !== undefined ? { attachments } : {}),
    conversation: conversation.slice(-20),
    gaps: [...new Set(gaps)],
    prior: prior.slice(0, 60),
    ...(studyHistory.length ? { studyHistory } : {}),
    capturedAt: new Date().toISOString(),
  };
  if (prior.length > 60)
    context.gaps.push(
      'Follow-up context includes the first 60 eligible results with uncertainty or an incorrect response.',
    );
  if (JSON.stringify(context).length > 600000)
    throw new AssessmentError(
      'Selected context is too large for one assessment. Choose fewer files or prior reports.',
      413,
    );
  return context;
}
/**
 * Mini-quiz attempts and flashcard reviews tied to each selected source — turned into weak
 * concept counts and struggling card snippets so the Librarian can bias questions toward the
 * learner's weak spots. Keeps the output bounded so it stays small enough to fit in the
 * generation prompt.
 */
async function captureStudyHistory(
  tx: GlossaryStore,
  sourceIds: string[],
  sources: AssessmentSource[],
): Promise<NonNullable<AssessmentContext['studyHistory']>> {
  const selected = new Set(sourceIds);
  const attempts = [...(await tx.list<Attempt>({ prefix: 'attempt:' })).values()].filter(
    (attempt) => selected.has(attempt.sourceId),
  );
  const decks = [
    ...(
      await tx.list<{
        id: string;
        sourceId: string;
        sourceVersion: number;
        status: string;
        cards: Flashcard[];
      }>({ prefix: 'card-deck:' })
    ).values(),
  ].filter((deck) => selected.has(deck.sourceId) && deck.status === 'ready');
  const reviewsByCard = new Map<string, CardReview[]>();
  for (const review of (await tx.list<CardReview>({ prefix: 'card-review:' })).values()) {
    const list = reviewsByCard.get(review.cardId) || [];
    list.push(review);
    reviewsByCard.set(review.cardId, list);
  }
  const history: NonNullable<AssessmentContext['studyHistory']> = [];
  for (const sourceId of sourceIds) {
    const file = sources.find((s) => s.id === sourceId);
    if (!file) continue;
    const sourceAttempts = attempts.filter((a) => a.sourceId === sourceId);
    const grouped = new Map<string, { concept: string; wrong: number; total: number }>();
    for (const a of sourceAttempts) {
      const key = a.concept.toLowerCase();
      const entry = grouped.get(key) || { concept: a.concept, wrong: 0, total: 0 };
      entry.total++;
      if (!a.correct) entry.wrong++;
      grouped.set(key, entry);
    }
    const weakConcepts = [...grouped.values()]
      .filter((g) => g.wrong > 0)
      .sort((a, b) => b.wrong / Math.max(b.total, 1) - a.wrong / Math.max(a.total, 1))
      .slice(0, 8);
    const sourceCards = decks.flatMap((d) => d.cards);
    const struggling: NonNullable<AssessmentContext['studyHistory']>[number]['strugglingCards'] =
      [];
    for (const card of sourceCards) {
      const schedule = await tx.get<CardSchedule>(`card-schedule:${card.id}`);
      if (!schedule) continue;
      const reviews = (reviewsByCard.get(card.id) || []).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      const last = reviews.at(-1);
      // Treat a card as "struggling" if the learner lapsed at least once OR their most recent
      // rating was "again" or "hard" — the AI is looking for topics they still stumble on.
      if (schedule.lapses === 0 && last && last.grade !== 'again' && last.grade !== 'hard')
        continue;
      struggling.push({
        front: card.front.slice(0, 180),
        lastGrade: last?.grade || 'none',
        lapses: schedule.lapses,
      });
    }
    struggling.sort((a, b) => b.lapses - a.lapses);
    if (weakConcepts.length || struggling.length)
      history.push({
        sourceId,
        sourceName: file.name,
        weakConcepts,
        strugglingCards: struggling.slice(0, 10),
      });
  }
  return history;
}
