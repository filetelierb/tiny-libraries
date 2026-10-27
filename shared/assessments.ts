import { z } from 'zod';
import type { Kind, Locale, Segment } from './domain';
import {
  attachmentIdsSchema,
  attachmentImages,
  imageEvidenceSegments,
  type AttachmentContent,
  type AttachmentImage,
} from './tutor-attachments';

export const assessmentCounts = [12, 24, 36, 48, 60] as const;
export const difficulties = ['mixed', 'easy', 'medium', 'hard'] as const;
export const assessmentSetupSchema = z.object({
  sourceIds: z
    .array(z.string().uuid())
    .max(40)
    .refine((v) => new Set(v).size === v.length),
  count: z.number().refine((v) => assessmentCounts.includes(v as 12)),
  difficulty: z.enum(difficulties),
  guidance: z.string().trim().max(4000),
  priorReportIds: z
    .array(z.string().uuid())
    .max(10)
    .refine((v) => new Set(v).size === v.length),
  attachmentIds: attachmentIdsSchema.optional(),
});
export const assessmentConfigSchema = assessmentSetupSchema.refine(
  (value) => value.sourceIds.length > 0 || !!value.attachmentIds?.length,
  'Choose studied sources or saved evidence for this assessment',
);
export type AssessmentConfig = z.infer<typeof assessmentConfigSchema>;
const id = z.string().regex(/^[a-zA-Z0-9:_-]{1,80}$/),
  savedId = z.string().regex(/^[a-zA-Z0-9:_-]{1,120}$/),
  text = z.string().trim().min(1).max(1800);
const sourceAssessmentCitationSchema = z
  .object({
    sourceId: z.string().uuid(),
    segmentId: z.string().min(1).max(240),
    quote: z.string().trim().min(1).max(1200),
  })
  .strict();
export const assessmentCitationSchema = z.union([
  z
    .object({
      kind: z.literal('attachment'),
      attachmentId: z.string().uuid(),
      segmentId: z.string().min(1).max(240),
      imageId: z.string().uuid().nullable(),
      quote: z.string().trim().max(1200),
    })
    .strict()
    .refine((value) => !!value.imageId || !!value.quote, 'Text evidence requires a literal quote'),
  sourceAssessmentCitationSchema,
]);
export type AssessmentCitation = z.infer<typeof assessmentCitationSchema>;
export const assessmentQuestionSchema = z.object({
  id,
  topicId: id,
  type: z.enum(['choice', 'true_false', 'fill_blank', 'matching']),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  difficultyReason: text,
  prompt: text,
  options: z
    .array(z.object({ id, text: z.string().trim().min(1).max(500) }))
    .min(2)
    .max(7),
  correctOptionId: id.nullable(),
  acceptedAnswers: z.array(z.string().trim().min(1).max(300)).max(8),
  prompts: z
    .array(
      z.object({
        id,
        text: z.string().trim().min(1).max(700),
        citations: z.array(assessmentCitationSchema).min(1).max(4),
      }),
    )
    .max(5),
  matches: z.array(z.object({ promptId: id, optionId: id, explanation: text })).max(5),
  explanation: text,
  citations: z.array(assessmentCitationSchema).min(1).max(8),
});
export type AssessmentQuestion = z.infer<typeof assessmentQuestionSchema>;
export type PublicAssessmentQuestion = Omit<
  AssessmentQuestion,
  'correctOptionId' | 'acceptedAnswers' | 'matches' | 'explanation' | 'difficultyReason'
>;
export const assessmentBatchSchema = z.object({
  title: z.string().trim().min(1).max(240),
  topics: z
    .array(
      z.object({
        id,
        title: text,
        summary: text,
        concepts: z.array(text).min(1).max(8),
        citations: z.array(assessmentCitationSchema).min(1).max(8),
      }),
    )
    .min(1)
    .max(6),
  questions: z.array(assessmentQuestionSchema).length(12),
  coverageNotes: z.array(text).max(10),
});
export type AssessmentBatch = z.infer<typeof assessmentBatchSchema>;
export type AssessmentPlan = Omit<AssessmentBatch, 'questions'> & {
  questions: AssessmentQuestion[];
};
export type PublicAssessmentPlan = Omit<AssessmentPlan, 'questions'> & {
  questions: PublicAssessmentQuestion[];
};
export type AssessmentSource = {
  id: string;
  version: number;
  name: string;
  kind: Kind;
  learningVersion: string;
  reviewed: boolean;
  limit: number | null;
  preparedCount: number;
  studiedCount: number;
  segments: Segment[];
  notes: Array<{ id: string; revision: number; title: string; text: string; quote: string }>;
};
export type AssessmentContext = {
  sources: AssessmentSource[];
  attachments?: AttachmentContent[];
  conversation: Array<{ role: 'user' | 'assistant'; content: string }>;
  gaps: string[];
  capturedAt: string;
  prior: Array<{
    reportId: string;
    questionId: string;
    prompt: string;
    responseText: string;
    score: number;
    confidence: Confidence;
    feedback: string;
    citations: AssessmentCitation[];
  }>;
};
export type AssessmentImageData = { attachmentId: string; image: AttachmentImage; data: string };
export const assessmentAnswerSchema = z.object({
  response: z.string().max(10000),
  confidence: z.enum(['sure', 'unsure', 'unknown']),
});
export type Confidence = z.infer<typeof assessmentAnswerSchema>['confidence'];
export type AssessmentAnswer = z.infer<typeof assessmentAnswerSchema> & {
  questionId: string;
  revision: number;
  updatedAt: string;
};
export type AssessmentGrade = {
  questionId: string;
  topicId: string;
  prompt: string;
  type: AssessmentQuestion['type'];
  difficulty: AssessmentQuestion['difficulty'];
  responseText: string;
  confidence: Confidence;
  score: number;
  feedback: string;
  correctAnswer: string;
  citations: AssessmentCitation[];
  pairs: Array<{
    prompt: string;
    response: string;
    correctAnswer: string;
    correct: boolean;
    feedback: string;
    citations: AssessmentCitation[];
  }>;
};
export const assessmentAnalysisSchema = z.object({
  analysis: z.string().trim().min(1).max(6000),
  topics: z
    .array(z.object({ topicId: savedId, analysis: z.string().trim().min(1).max(2500) }))
    .max(30),
  recommendations: z
    .array(
      z.object({
        topicId: savedId,
        title: text,
        reason: text,
        citations: z.array(assessmentCitationSchema).min(1).max(4),
      }),
    )
    .max(30),
});
export type AssessmentAnalysis = z.infer<typeof assessmentAnalysisSchema>;
export type AssessmentReport = Omit<AssessmentAnalysis, 'topics' | 'recommendations'> & {
  score: number;
  count: number;
  topics: Array<{
    topicId: string;
    title: string;
    analysis: string;
    count: number;
    score: number;
    sureErrors: number;
    unsureCorrect: number;
    unknown: number;
  }>;
  recommendations: Array<AssessmentAnalysis['recommendations'][number] & { bookmarkId?: string }>;
};
export type AssessmentSummary = {
  id: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  config: AssessmentConfig;
  locale: Locale;
  model: string;
  status: 'preparing' | 'ready' | 'grading' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
  stage: 'prepare' | 'grade';
  completedBatches: number;
  title: string;
  error?: string;
  workActive: boolean;
};
export type AssessmentDetail = AssessmentSummary & {
  context: AssessmentContext;
  plan: PublicAssessmentPlan | null;
  answers: AssessmentAnswer[];
  grades: AssessmentGrade[];
  report: AssessmentReport | null;
};
export type AssessmentOption = {
  sourceId: string;
  prepared: boolean;
  suggested: boolean;
  noteCount: number;
  studiedCount: number;
  preparedCount: number;
  limit: number | null;
};

export const normalizeAssessmentText = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
export function validateAssessmentCitation(
  c: AssessmentCitation,
  context: Pick<AssessmentContext, 'sources' | 'attachments'>,
) {
  if ('attachmentId' in c) {
    const content = context.attachments?.find((item) => item.attachment.id === c.attachmentId),
      segment = content?.segments.find((part) => part.id === c.segmentId),
      image =
        content && c.imageId
          ? attachmentImages(content.attachment).find((item) => item.id === c.imageId)
          : undefined;
    if (
      !content ||
      !segment ||
      (!c.imageId && !c.quote) ||
      (c.quote && !segment.text.includes(c.quote)) ||
      (c.imageId &&
        (!image ||
          !imageEvidenceSegments(image, content.segments).some((part) => part.id === c.segmentId)))
    )
      throw new Error('Assessment citation is outside the selected saved evidence.');
    return { kind: 'attachment' as const, content, segment, image };
  }
  const source = context.sources.find((s) => s.id === c.sourceId),
    segment = source?.segments.find((s) => s.id === c.segmentId);
  if (!segment || !segment.text.includes(c.quote))
    throw new Error('Assessment citation is outside the selected source evidence.');
  return { kind: 'source' as const, source: source!, segment };
}
export function assessmentCitationIdentity(c: AssessmentCitation) {
  return 'attachmentId' in c
    ? `attachment:${c.attachmentId}:${c.imageId || ''}:${c.segmentId}`
    : `source:${c.sourceId}:${c.segmentId}`;
}
export function validateAssessmentBatch(
  raw: unknown,
  context: AssessmentContext,
  config: AssessmentConfig,
  priorPrompts: string[] = [],
) {
  const value = assessmentBatchSchema.parse(raw),
    topics = new Set(value.topics.map((t) => t.id)),
    prompts = new Set(priorPrompts.map(normalizeAssessmentText));
  if (topics.size !== value.topics.length || new Set(value.questions.map((q) => q.id)).size !== 12)
    throw new Error('Assessment identifiers must be unique.');
  for (const topic of value.topics) {
    if (!value.questions.some((q) => q.topicId === topic.id))
      throw new Error('Every topic needs an assessment question.');
    topic.citations.forEach((c) => validateAssessmentCitation(c, context));
  }
  for (const q of value.questions) {
    if (!topics.has(q.topicId) || prompts.has(normalizeAssessmentText(q.prompt)))
      throw new Error('Assessment question repeats a prompt or names an unavailable topic.');
    prompts.add(normalizeAssessmentText(q.prompt));
    q.citations.forEach((c) => validateAssessmentCitation(c, context));
    if (config.difficulty !== 'mixed' && q.difficulty !== config.difficulty)
      throw new Error('Question difficulty does not match the selected difficulty.');
    const options = new Set(q.options.map((o) => o.id));
    if (
      options.size !== q.options.length ||
      new Set(q.options.map((o) => normalizeAssessmentText(o.text))).size !== q.options.length
    )
      throw new Error('Answer options must be distinct.');
    if (q.type === 'matching') {
      const rows = new Set(q.prompts.map((p) => p.id)),
        extra = q.options.length - q.prompts.length;
      if (
        q.correctOptionId !== null ||
        q.acceptedAnswers.length ||
        rows.size !== q.prompts.length ||
        q.prompts.length < 3 ||
        new Set(q.prompts.map((p) => normalizeAssessmentText(p.text))).size !== q.prompts.length ||
        q.matches.length !== q.prompts.length ||
        new Set(q.matches.map((m) => m.promptId)).size !== rows.size ||
        new Set(q.matches.map((m) => m.optionId)).size !== rows.size ||
        q.matches.some((m) => !rows.has(m.promptId) || !options.has(m.optionId))
      )
        throw new Error('Matching pairs must identify a unique answer for each row.');
      if (
        (q.difficulty === 'easy' && (q.prompts.length !== 3 || extra !== 0)) ||
        (q.difficulty === 'medium' && (q.prompts.length !== 4 || extra !== 0)) ||
        (q.difficulty === 'hard' && (q.prompts.length < 4 || extra < 1 || extra > 2))
      )
        throw new Error('Matching rows and distractors do not match the selected difficulty.');
      q.prompts.forEach((p) =>
        p.citations.forEach((c) => {
          validateAssessmentCitation(c, context);
          if (
            !q.citations.some(
              (e) => assessmentCitationIdentity(e) === assessmentCitationIdentity(c),
            )
          )
            throw new Error('Matching evidence must be included in the question.');
        }),
      );
    } else {
      if (
        q.prompts.length ||
        q.matches.length ||
        !q.correctOptionId ||
        !options.has(q.correctOptionId)
      )
        throw new Error('Choice solution does not identify an available option.');
      if (
        q.type === 'true_false'
          ? q.options.length !== 2 || !options.has('true') || !options.has('false')
          : q.options.length !== 4
      )
        throw new Error('Use two true/false options or four choice options.');
      if (q.type === 'fill_blank' && q.prompt.split('____').length !== 2)
        throw new Error('A fill-blank question needs one ____ blank.');
      if (
        q.type === 'fill_blank' &&
        q.difficulty === 'hard' &&
        q.options.find((o) => o.id === q.correctOptionId)!.text.length > 300
      )
        throw new Error('A written fill-blank solution must fit the answer field.');
      if (q.type !== 'fill_blank' && q.acceptedAnswers.length)
        throw new Error('Only fill-blank questions can accept equivalent terms.');
      if (
        q.type === 'fill_blank' &&
        q.acceptedAnswers.some((a) =>
          q.options.some(
            (o) =>
              o.id !== q.correctOptionId &&
              normalizeAssessmentText(o.text) === normalizeAssessmentText(a),
          ),
        )
      )
        throw new Error('An accepted term cannot accept a distractor.');
    }
  }
  if (!config.guidance && new Set(value.questions.map((q) => q.type)).size !== 4)
    throw new Error('The assessment needs all four question types.');
  return value;
}
export function publicAssessmentPlan(plan: AssessmentPlan): PublicAssessmentPlan {
  return {
    ...plan,
    questions: plan.questions.map(
      ({
        correctOptionId: _c,
        acceptedAnswers: _a,
        matches: _m,
        explanation: _e,
        difficultyReason: _r,
        ...q
      }) => q,
    ),
  };
}
export function matchingAssessmentResponse(response: string): Record<string, string> {
  try {
    const value = JSON.parse(response);
    return value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.values(value).every((v) => typeof v === 'string')
      ? value
      : {};
  } catch {
    return {};
  }
}
export function validAssessmentResponse(q: PublicAssessmentQuestion, response: string) {
  if (q.type === 'matching') {
    let value: Record<string, string>;
    try {
      const parsed = JSON.parse(response);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      value = parsed;
    } catch {
      return false;
    }
    const entries = Object.entries(value);
    return (
      entries.some(([, v]) => v !== '') &&
      entries.every(
        ([k, v]) =>
          q.prompts.some((p) => p.id === k) &&
          typeof v === 'string' &&
          (!v || q.options.some((o) => o.id === v)),
      ) &&
      new Set(entries.map(([, v]) => v).filter(Boolean)).size ===
        entries.filter(([, v]) => v).length
    );
  }
  if (q.type === 'fill_blank' && q.difficulty === 'hard')
    return !!response.trim() && response.length <= 300;
  return q.options.some((o) => o.id === response);
}
export function gradeAssessmentQuestion(
  q: AssessmentQuestion,
  answer: AssessmentAnswer,
): AssessmentGrade {
  const unknown = answer.confidence === 'unknown',
    expected = q.options.find((o) => o.id === q.correctOptionId)?.text || '',
    responses = unknown ? {} : matchingAssessmentResponse(answer.response);
  const pairs =
    q.type === 'matching'
      ? q.prompts.map((p) => {
          const solution = q.matches.find((m) => m.promptId === p.id)!;
          return {
            prompt: p.text,
            response: q.options.find((o) => o.id === responses[p.id])?.text || '',
            correctAnswer: q.options.find((o) => o.id === solution.optionId)!.text,
            correct: responses[p.id] === solution.optionId,
            feedback: solution.explanation,
            citations: p.citations,
          };
        })
      : [];
  const typed = q.type === 'fill_blank' && q.difficulty === 'hard';
  const correct = typed
    ? [expected, ...q.acceptedAnswers].some(
        (v) => normalizeAssessmentText(v) === normalizeAssessmentText(answer.response),
      )
    : answer.response === q.correctOptionId;
  return {
    questionId: q.id,
    topicId: q.topicId,
    prompt: q.prompt,
    type: q.type,
    difficulty: q.difficulty,
    confidence: answer.confidence,
    responseText: unknown
      ? ''
      : pairs.length
        ? pairs.map((p) => `${p.prompt}: ${p.response}`).join('\n')
        : typed
          ? answer.response
          : q.options.find((o) => o.id === answer.response)?.text || '',
    score: unknown
      ? 0
      : pairs.length
        ? pairs.filter((p) => p.correct).length / pairs.length
        : correct
          ? 1
          : 0,
    correctAnswer: pairs.length
      ? pairs.map((p) => `${p.prompt}: ${p.correctAnswer}`).join('\n')
      : expected,
    feedback: q.explanation,
    citations: q.citations,
    pairs,
  };
}
export function compileAssessmentReport(
  raw: unknown,
  plan: AssessmentPlan,
  grades: AssessmentGrade[],
  context: AssessmentContext,
): AssessmentReport {
  const value = assessmentAnalysisSchema.parse(raw),
    ids = new Set(plan.topics.map((t) => t.id));
  if (
    grades.length !== plan.questions.length ||
    new Set(grades.map((g) => g.questionId)).size !== grades.length ||
    grades.some(
      (g) =>
        !Number.isFinite(g.score) ||
        g.score < 0 ||
        g.score > 1 ||
        !plan.questions.some((q) => q.id === g.questionId && q.topicId === g.topicId),
    ) ||
    value.topics.some((t) => !ids.has(t.topicId)) ||
    new Set(value.topics.map((t) => t.topicId)).size !== value.topics.length
  )
    throw new Error('Assessment report topics or grades do not match the saved questions.');
  const topics = plan.topics.map((t) => {
    const values = grades.filter((g) => g.topicId === t.id);
    return {
      topicId: t.id,
      title: t.title,
      analysis: value.topics.find((v) => v.topicId === t.id)?.analysis || '',
      count: values.length,
      score: Math.round((values.reduce((n, g) => n + g.score, 0) / values.length) * 100),
      sureErrors: values.filter((g) => g.confidence === 'sure' && g.score < 0.7).length,
      unsureCorrect: values.filter((g) => g.confidence === 'unsure' && g.score >= 0.7).length,
      unknown: values.filter((g) => g.confidence === 'unknown').length,
    };
  });
  if (topics.some((t) => !t.analysis)) throw new Error('Every saved topic needs report analysis.');
  for (const rec of value.recommendations) {
    if (!ids.has(rec.topicId)) throw new Error('Recommendation names an unavailable topic.');
    rec.citations.forEach((c) => validateAssessmentCitation(c, context));
  }
  if (
    topics.some(
      (t) =>
        (t.score < 70 || t.sureErrors || t.unsureCorrect || t.unknown) &&
        !value.recommendations.some((r) => r.topicId === t.topicId),
    )
  )
    throw new Error('A topic with observed uncertainty needs a cited next step.');
  return {
    ...value,
    topics,
    count: grades.length,
    score: Math.round((grades.reduce((n, g) => n + g.score, 0) / grades.length) * 100),
  };
}
export function assessmentMarkdown(detail: AssessmentDetail) {
  if (!detail.report) return '';
  const cite = (c: AssessmentCitation) => {
    const resolved = validateAssessmentCitation(c, detail.context);
    if (resolved.kind === 'attachment') {
      const { content, image } = resolved;
      return `- Saved evidence: ${content.attachment.name} · note revision ${content.attachment.annotationRevision || '—'}${image ? ` · image ${image.capture?.label || image.id} · SHA-256 ${image.digest}` : ''}\n  ${c.quote ? `> ${c.quote.replace(/\n/g, '\n  > ')}` : 'Visual observation of the selected flattened image; no literal source quote.'}`;
    }
    const { source, segment } = resolved;
    return `- ${source.name} (v${source.version}) · ${segment.page ? `page ${segment.page}` : segment.start != null ? `${segment.start}s` : segment.id}\n  > ${c.quote.replace(/\n/g, '\n  > ')}`;
  };
  return [
    `# ${detail.title}`,
    `Assessment ${detail.id}\n${detail.createdAt}\n\nRecorded sample: ${detail.report.score}% · ${detail.report.count} questions.`,
    detail.report.analysis,
    '## Scope and coverage',
    ...detail.context.sources.map(
      (s) =>
        `- ${s.name} (v${s.version}, preparation ${s.learningVersion}): ${s.segments.length}/${s.studiedCount} studied evidence segments used.`,
    ),
    ...(detail.context.attachments || []).flatMap(({ attachment }) => [
      `- Saved evidence: ${attachment.name} · snapshot ${attachment.id} · note revision ${attachment.annotationRevision || '—'} · ${attachment.segmentCount} passages · ${attachmentImages(attachment).length} selected images.`,
      ...attachmentImages(attachment).map(
        (image) =>
          `  - ${image.capture?.label || image.id} · image ${image.id} · SHA-256 ${image.digest}${image.capture ? ` · drawing ${image.capture.drawingDigest}` : ''}`,
      ),
    ]),
    ...detail.context.gaps.map((g) => `- ${g}`),
    '## Topic results',
    ...detail.report.topics.map(
      (t) =>
        `### ${t.title}\n${t.score}% · ${t.count} questions · confident errors (<70%): ${t.sureErrors} · correct with doubts (≥70%): ${t.unsureCorrect} · unknown: ${t.unknown}\n\n${t.analysis}`,
    ),
    '## Answers',
    ...detail.grades.map(
      (g) =>
        `### ${g.prompt}\n${g.type} · ${g.difficulty}\n\nYour answer: ${g.responseText || 'Unknown'}\nConfidence: ${g.confidence}\nScore: ${Math.round(g.score * 100)}%\nCorrect answer: ${g.correctAnswer}\n\n${g.feedback}\n\n${g.pairs.map((p) => `#### ${p.prompt}\n${p.correct ? 'Correct' : 'Incorrect'}\nYour answer: ${p.response || 'Unanswered'}\nCorrect answer: ${p.correctAnswer}\n\n${p.feedback}\n\n${p.citations.map(cite).join('\n')}`).join('\n\n')}\n\n${g.citations.map(cite).join('\n')}`,
    ),
    '## Recommended next steps',
    ...detail.report.recommendations.map(
      (r) => `### ${r.title}\n${r.reason}\n\n${r.citations.map(cite).join('\n')}`,
    ),
  ].join('\n\n');
}
