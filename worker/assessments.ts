import { z } from 'zod';
import {
  assessmentConfigSchema,
  assessmentAnswerSchema,
  publicAssessmentPlan,
  validAssessmentResponse,
  gradeAssessmentQuestion,
  compileAssessmentReport,
  validateAssessmentBatch,
  type AssessmentSummary,
  type AssessmentConfig,
  type AssessmentContext,
  type AssessmentBatch,
  type AssessmentPlan,
  type AssessmentQuestion,
  type AssessmentAnswer,
  type AssessmentGrade,
  type AssessmentReport,
  type AssessmentDetail,
  type AssessmentSource,
  type AssessmentAnalysis,
} from '../shared/assessments';
import type { Segment, Settings, Source, Directory } from '../shared/domain';
import {
  annotationSummary,
  annotationScopeKey,
  plainDocument,
  stableAnnotationId,
  type Annotation,
} from '../shared/annotations';
import { sourceState } from '../shared/directories';
import type { GlossaryStore, GlossaryStorage } from './glossary';
import { captureAssessmentContext, AssessmentError } from './assessment-context';
export { AssessmentError } from './assessment-context';

type Stored = AssessmentSummary & {
  fingerprint: string;
  owner: string;
  operation: string;
  until: number;
};
type SourceRecord = Omit<AssessmentSource, 'segments'> & { segmentIds: string[] };
type BatchRecord = Omit<AssessmentBatch, 'questions'> & { questionIds: string[] };
type Operations = {
  owner: string;
  settings: Settings;
  start: (task: Promise<void>) => void;
  generate: (
    context: AssessmentContext,
    config: AssessmentConfig,
    previous: string[],
    batch: number,
    locale: Settings['locale'],
    model: string,
  ) => Promise<AssessmentBatch>;
  analyze: (
    context: AssessmentContext,
    plan: AssessmentPlan,
    grades: AssessmentGrade[],
    locale: Settings['locale'],
    model: string,
  ) => Promise<AssessmentAnalysis>;
};
const key = (id: string) => `assessment:${id}`,
  pad = (n: number) => String(n).padStart(6, '0');
async function boundedPut(tx: GlossaryStore, key: string, value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 120000)
    throw new AssessmentError(
      'An assessment record exceeds its saved-data limit. Existing results remain unchanged.',
      413,
    );
  await tx.put(key, value);
}
function summary(record: Stored): AssessmentSummary {
  const { fingerprint: _f, owner: _o, operation: _p, until: _u, ...value } = record;
  return value;
}
async function storeContext(tx: GlossaryStore, id: string, context: AssessmentContext) {
  await boundedPut(tx, `assessment-context:${id}`, {
    gaps: context.gaps,
    capturedAt: context.capturedAt,
  });
  for (const source of context.sources) {
    const { segments, ...metadata } = source;
    await boundedPut(tx, `assessment-source:${id}:${source.id}`, {
      ...metadata,
      segmentIds: segments.map((s) => s.id),
    });
    for (const segment of segments)
      await boundedPut(tx, `assessment-segment:${id}:${source.id}:${segment.id}`, segment);
  }
  for (const [i, message] of context.conversation.entries())
    await boundedPut(tx, `assessment-chat:${id}:${pad(i)}`, message);
  for (const [i, prior] of context.prior.entries())
    await boundedPut(tx, `assessment-prior:${id}:${pad(i)}`, prior);
}
async function loadContext(tx: GlossaryStore, record: Stored): Promise<AssessmentContext> {
  const base = await tx.get<Pick<AssessmentContext, 'gaps' | 'capturedAt'>>(
    `assessment-context:${record.id}`,
  );
  if (!base) throw new AssessmentError('Saved assessment context is unavailable.', 409);
  const sources: AssessmentSource[] = [];
  for (const id of record.config.sourceIds) {
    const metadata = await tx.get<SourceRecord>(`assessment-source:${record.id}:${id}`);
    if (!metadata) throw new AssessmentError('Saved source context is unavailable.', 409);
    const { segmentIds, ...source } = metadata;
    const entries = await tx.list<Segment>({ prefix: `assessment-segment:${record.id}:${id}:` });
    const byId = new Map([...entries.values()].map((s) => [s.id, s]));
    if (segmentIds.some((id) => !byId.has(id)))
      throw new AssessmentError('Saved source evidence is incomplete.', 409);
    sources.push({ ...source, segments: segmentIds.map((id) => byId.get(id)!) });
  }
  return {
    ...base,
    sources,
    conversation: [
      ...(
        await tx.list<AssessmentContext['conversation'][number]>({
          prefix: `assessment-chat:${record.id}:`,
        })
      ).values(),
    ],
    prior: [
      ...(
        await tx.list<AssessmentContext['prior'][number]>({
          prefix: `assessment-prior:${record.id}:`,
        })
      ).values(),
    ],
  };
}
async function loadPlan(tx: GlossaryStore, record: Stored): Promise<AssessmentPlan | null> {
  if (!record.completedBatches) return null;
  const topics: AssessmentBatch['topics'] = [],
    questions: AssessmentQuestion[] = [],
    coverageNotes: string[] = [];
  let title = record.title;
  for (let i = 0; i < record.completedBatches; i++) {
    const batch = await tx.get<BatchRecord>(`assessment-batch:${record.id}:${pad(i)}`);
    if (!batch) throw new AssessmentError('Saved question batch is unavailable.', 409);
    if (!i) title = batch.title;
    topics.push(...batch.topics);
    coverageNotes.push(...batch.coverageNotes);
    for (const id of batch.questionIds) {
      const q = await tx.get<AssessmentQuestion>(`assessment-question:${record.id}:${id}`);
      if (!q) throw new AssessmentError('Saved question is unavailable.', 409);
      questions.push(q);
    }
  }
  return { title, topics, questions, coverageNotes: [...new Set(coverageNotes)] };
}
async function recover(tx: GlossaryStore, id: string, owner: string) {
  let record = await tx.get<Stored>(key(id));
  if (!record) throw new AssessmentError('Assessment not found.', 404);
  if (record.workActive && (record.owner !== owner || record.until < Date.now())) {
    record = {
      ...record,
      workActive: false,
      status: ['preparing', 'grading'].includes(record.status) ? 'interrupted' : record.status,
      error: ['preparing', 'grading'].includes(record.status)
        ? 'Assessment work was interrupted. Retry to recover saved steps.'
        : record.error,
    };
    await tx.put(key(id), record);
  }
  return record;
}
export async function assessmentDetail(
  storage: GlossaryStorage,
  id: string,
  owner: string,
): Promise<AssessmentDetail> {
  return storage.transaction(async (tx) => {
    const record = await recover(tx, id, owner),
      context = await loadContext(tx, record),
      plan = await loadPlan(tx, record),
      answers = [
        ...(await tx.list<AssessmentAnswer>({ prefix: `assessment-answer:${id}:` })).values(),
      ],
      complete = record.status === 'completed';
    const order = new Map(plan?.questions.map((q, i) => [q.id, i]) || []);
    const grades = complete
      ? [...(await tx.list<AssessmentGrade>({ prefix: `assessment-grade:${id}:` })).values()].sort(
          (a, b) => (order.get(a.questionId) || 0) - (order.get(b.questionId) || 0),
        )
      : [];
    return {
      ...summary(record),
      context,
      plan: plan ? publicAssessmentPlan(plan) : null,
      answers,
      grades,
      report: complete ? (await tx.get<AssessmentReport>(`assessment-report:${id}`)) || null : null,
    };
  });
}
export async function assessmentSummary(storage: GlossaryStorage, id: string, owner: string) {
  return storage.transaction(async (tx) => summary(await recover(tx, id, owner)));
}
export async function assessmentHistory(
  storage: GlossaryStorage,
  sessionId: string,
  owner: string,
  after?: string,
) {
  return storage.transaction(async (tx) => {
    const records = [...(await tx.list<Stored>({ prefix: 'assessment:' })).values()]
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const start = after ? records.findIndex((r) => r.id === after) + 1 : 0;
    if (after && !start)
      throw new AssessmentError('History cursor changed. Refresh the first page.');
    const page = records.slice(start, start + 30);
    const items = [];
    for (const r of page) items.push(summary(await recover(tx, r.id, owner)));
    return { items, nextCursor: start + page.length < records.length ? page.at(-1)!.id : null };
  });
}
function shuffled<T>(items: T[]) {
  const values = [...items];
  for (let i = values.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}
function finalizeBatch(value: AssessmentBatch, batch: number): AssessmentBatch {
  const prefix = `b${batch + 1}:`;
  return {
    ...value,
    topics: value.topics.map((t) => ({ ...t, id: prefix + t.id })),
    questions: value.questions.map((q) => ({
      ...q,
      id: prefix + q.id,
      topicId: prefix + q.topicId,
      options: q.type === 'true_false' ? q.options : shuffled(q.options),
      prompts: q.type === 'matching' ? shuffled(q.prompts) : q.prompts,
    })),
  };
}
async function saveBookmarks(
  tx: GlossaryStore,
  record: Stored,
  report: AssessmentReport,
  context: AssessmentContext,
) {
  const directories = [...(await tx.list<Directory>({ prefix: 'directory:' })).values()];
  for (const [i, recommendation] of report.recommendations.entries()) {
    const citation = recommendation.citations[0],
      source = context.sources.find((s) => s.id === citation.sourceId)!,
      segment = source.segments.find((s) => s.id === citation.segmentId)!,
      current = await tx.get<Source>(`file:${source.id}`);
    if (
      !current ||
      current.version !== source.version ||
      sourceState(current, directories) === 'trash'
    )
      continue;
    const id = await stableAnnotationId(`assessment:${record.id}:recommendation:${i}`);
    if (!(await tx.get(`annotation:${id}`))) {
      const now = new Date().toISOString(),
        text = `${recommendation.title}\n\n${recommendation.reason}`;
      const note: Annotation = {
        id,
        kind: 'bookmark',
        sessionId: record.sessionId,
        sourceId: source.id,
        sourceVersion: source.version,
        title: recommendation.title.slice(0, 240),
        document: plainDocument(text),
        text,
        location: {
          quote: citation.quote,
          ...(segment.page ? { page: segment.page } : {}),
          ...(segment.start != null ? { seconds: segment.start } : {}),
        },
        strokes: [],
        origin: 'tutor',
        references: [source.id],
        revision: 1,
        deleted: false,
        createdAt: now,
        updatedAt: now,
      };
      await boundedPut(tx, `annotation:${id}`, note);
      await tx.put(`annotation-summary:${record.sessionId}:${id}`, annotationSummary(note));
      await tx.put(annotationScopeKey(note), annotationSummary(note));
    }
    recommendation.bookmarkId = id;
  }
}
async function runAssessment(storage: GlossaryStorage, reserved: Stored, options: Operations) {
  try {
    const context = await loadContext(storage, reserved);
    if (reserved.stage === 'prepare') {
      for (let i = reserved.completedBatches; i < reserved.config.count / 12; i++) {
        const current = await storage.transaction(async (tx) => {
          const current = await tx.get<Stored>(key(reserved.id));
          if (current?.operation !== reserved.operation || current.status !== 'preparing')
            return null;
          await tx.put(key(current.id), { ...current, until: Date.now() + 600000 });
          return current;
        });
        if (!current) return;
        const previous = await loadPlan(storage, current),
          raw = validateAssessmentBatch(
            await options.generate(
              context,
              reserved.config,
              previous?.questions.map((q) => q.prompt) || [],
              i,
              reserved.locale,
              reserved.model,
            ),
            context,
            reserved.config,
            previous?.questions.map((q) => q.prompt) || [],
          ),
          batch = finalizeBatch(raw, i);
        await storage.transaction(async (tx) => {
          const current = await tx.get<Stored>(key(reserved.id));
          if (current?.operation !== reserved.operation || current.status !== 'preparing') return;
          const { questions, ...metadata } = batch;
          for (const q of questions)
            await boundedPut(tx, `assessment-question:${reserved.id}:${q.id}`, q);
          await boundedPut(tx, `assessment-batch:${reserved.id}:${pad(i)}`, {
            ...metadata,
            questionIds: questions.map((q) => q.id),
          });
          const done = i + 1;
          await tx.put(key(reserved.id), {
            ...current,
            completedBatches: done,
            title: i === 0 ? batch.title : current.title,
            status: done === reserved.config.count / 12 ? 'ready' : 'preparing',
            updatedAt: new Date().toISOString(),
          });
        });
      }
    } else {
      const plan = await loadPlan(storage, reserved);
      if (!plan || plan.questions.length !== reserved.config.count)
        throw new AssessmentError('The assessment plan is incomplete.', 409);
      const grades = await storage.transaction(async (tx) => {
        const current = await tx.get<Stored>(key(reserved.id));
        if (current?.operation !== reserved.operation || current.status !== 'grading') return null;
        const values: AssessmentGrade[] = [];
        for (const q of plan.questions) {
          const answer = await tx.get<AssessmentAnswer>(`assessment-answer:${reserved.id}:${q.id}`);
          if (!answer) throw new AssessmentError('Finish saving every answer before grading.', 409);
          const grade = gradeAssessmentQuestion(q, answer);
          await boundedPut(tx, `assessment-grade:${reserved.id}:${q.id}`, grade);
          values.push(grade);
        }
        return values;
      });
      if (!grades) return;
      const analysis = await options.analyze(
          context,
          plan,
          grades,
          reserved.locale,
          reserved.model,
        ),
        report = compileAssessmentReport(analysis, plan, grades, context);
      await storage.transaction(async (tx) => {
        const current = await tx.get<Stored>(key(reserved.id));
        if (current?.operation !== reserved.operation || current.status !== 'grading') return;
        await saveBookmarks(tx, current, report, context);
        await boundedPut(tx, `assessment-report:${reserved.id}`, report);
        await tx.put(key(reserved.id), {
          ...current,
          status: 'completed',
          updatedAt: new Date().toISOString(),
        });
      });
    }
  } catch (error) {
    await storage.transaction(async (tx) => {
      const current = await tx.get<Stored>(key(reserved.id));
      if (
        current?.operation === reserved.operation &&
        ['preparing', 'grading'].includes(current.status)
      )
        await tx.put(key(current.id), {
          ...current,
          status: 'failed',
          error:
            error instanceof Error
              ? error.message.slice(0, 700)
              : 'Assessment work failed. Retry to continue.',
          updatedAt: new Date().toISOString(),
        });
    });
  } finally {
    await storage.transaction(async (tx) => {
      const current = await tx.get<Stored>(key(reserved.id));
      if (current?.operation === reserved.operation)
        await tx.put(key(current.id), { ...current, workActive: false });
    });
  }
}
export async function createAssessment(
  storage: GlossaryStorage,
  raw: unknown,
  options: Operations,
) {
  const input = z
      .object({
        requestId: z.string().uuid(),
        sessionId: z.string().uuid(),
        config: assessmentConfigSchema,
      })
      .parse(raw),
    fingerprint = JSON.stringify({
      ...input,
      config: {
        ...input.config,
        sourceIds: [...input.config.sourceIds].sort(),
        priorReportIds: [...input.config.priorReportIds].sort(),
      },
    });
  const record = await storage.transaction(async (tx) => {
    const previous = await tx.get<Stored>(key(input.requestId));
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new AssessmentError(
          'This request ID already contains a different assessment configuration.',
          409,
        );
      return null;
    }
    if (!options.settings.configured)
      throw new AssessmentError('Add a Meta API key in Settings to prepare an assessment.', 409);
    const existing = [...(await tx.list<Stored>({ prefix: 'assessment:' })).values()].find(
      (r) => r.sessionId === input.sessionId && !['completed', 'cancelled'].includes(r.status),
    );
    if (existing)
      throw new AssessmentError(
        'This session already has an unfinished assessment. Resume, retry or cancel it first.',
        409,
      );
    const context = await captureAssessmentContext(tx, input.sessionId, input.config);
    await storeContext(tx, input.requestId, context);
    const now = new Date().toISOString(),
      record: Stored = {
        id: input.requestId,
        sessionId: input.sessionId,
        config: input.config,
        createdAt: now,
        updatedAt: now,
        status: 'preparing',
        stage: 'prepare',
        completedBatches: 0,
        title: '',
        locale: options.settings.locale,
        model: options.settings.model,
        workActive: true,
        fingerprint,
        owner: options.owner,
        operation: crypto.randomUUID(),
        until: Date.now() + 600000,
      };
    await tx.put(key(record.id), record);
    return record;
  });
  if (record) options.start(runAssessment(storage, record, options));
  return assessmentDetail(storage, input.requestId, options.owner);
}
export async function saveAssessmentAnswer(storage: GlossaryStorage, id: string, raw: unknown) {
  const input = z
    .object({
      requestId: z.string().uuid(),
      questionId: z.string().min(1).max(200),
      expectedRevision: z.number().int().nonnegative(),
      ...assessmentAnswerSchema.shape,
    })
    .parse(raw);
  const fingerprint = JSON.stringify(input);
  return storage.transaction(async (tx) => {
    const receiptKey = `assessment-answer-receipt:${input.requestId}`,
      receipt = await tx.get<{
        assessmentId: string;
        fingerprint: string;
        answer: AssessmentAnswer;
      }>(receiptKey);
    if (receipt) {
      if (receipt.assessmentId !== id || receipt.fingerprint !== fingerprint)
        throw new AssessmentError(
          'This answer operation already contains a different response.',
          409,
        );
      return receipt.answer;
    }
    const record = await tx.get<Stored>(key(id));
    if (!record || record.status !== 'ready')
      throw new AssessmentError('This assessment is not accepting answer changes.', 409);
    const q = await tx.get<AssessmentQuestion>(`assessment-question:${id}:${input.questionId}`);
    if (!q) throw new AssessmentError('Assessment question not found.', 404);
    if (input.confidence !== 'unknown' && !validAssessmentResponse(q, input.response))
      throw new AssessmentError('Choose an available answer or mark it unknown.');
    const old = await tx.get<AssessmentAnswer>(`assessment-answer:${id}:${q.id}`);
    if ((old?.revision || 0) !== input.expectedRevision)
      throw new AssessmentError(
        'This answer changed in another window. Reload its saved answer before changing it.',
        409,
      );
    const answer: AssessmentAnswer = {
      questionId: q.id,
      response: input.confidence === 'unknown' ? '' : input.response,
      confidence: input.confidence,
      revision: input.expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    };
    await boundedPut(tx, `assessment-answer:${id}:${q.id}`, answer);
    await tx.put(receiptKey, { assessmentId: id, fingerprint, answer });
    return answer;
  });
}
export async function assessmentAction(
  storage: GlossaryStorage,
  id: string,
  raw: unknown,
  options: Operations,
) {
  const input = z.object({ action: z.enum(['finish', 'retry', 'cancel']) }).parse(raw);
  const reserved = await storage.transaction(async (tx) => {
    const record = await recover(tx, id, options.owner);
    if (input.action === 'cancel') {
      if (record.status === 'completed')
        throw new AssessmentError('Completed reports are immutable.', 409);
      await tx.put(key(id), {
        ...record,
        status: 'cancelled',
        updatedAt: new Date().toISOString(),
      });
      return null;
    }
    if (input.action === 'finish') {
      if (record.status === 'completed' || record.status === 'grading') return null;
      if (record.status !== 'ready')
        throw new AssessmentError('Complete the saved assessment before finishing.', 409);
      const plan = await loadPlan(tx, record);
      if (!plan || plan.questions.length !== record.config.count)
        throw new AssessmentError('Question generation is incomplete.', 409);
      for (const q of plan.questions)
        if (!(await tx.get(`assessment-answer:${id}:${q.id}`)))
          throw new AssessmentError(
            'Save a response or Unknown for every question before finishing.',
            409,
          );
    } else if (!['failed', 'interrupted'].includes(record.status)) return null;
    if (!options.settings.configured)
      throw new AssessmentError('Add a Meta API key in Settings to continue the assessment.', 409);
    const next: Stored = {
      ...record,
      status:
        input.action === 'finish'
          ? 'grading'
          : record.stage === 'prepare'
            ? 'preparing'
            : 'grading',
      stage: input.action === 'finish' ? 'grade' : record.stage,
      error: undefined,
      owner: options.owner,
      operation: crypto.randomUUID(),
      until: Date.now() + 600000,
      workActive: true,
      updatedAt: new Date().toISOString(),
    };
    await tx.put(key(id), next);
    return next;
  });
  if (reserved) options.start(runAssessment(storage, reserved, options));
  return assessmentDetail(storage, id, options.owner);
}
