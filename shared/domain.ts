import { z } from 'zod';
import { sanitizeWidgets } from './artifact-widgets';

export const localeSchema = z.enum(['en', 'es']);
export type Locale = z.infer<typeof localeSchema>;
export const kindSchema = z.enum(['video', 'audio', 'pdf', 'image', 'markdown', 'text']);
export type Kind = z.infer<typeof kindSchema>;
export const sourceSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  name: z.string().min(1).max(240),
  folder: z.string().max(240),
  kind: kindSchema,
  mime: z.string(),
  size: z.number().int().nonnegative(),
  archived: z.boolean(),
  trashed: z.boolean().optional(),
  reviewed: z.boolean(),
  createdAt: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;
export const directorySchema = z.object({
  id: z.string().uuid(),
  path: z.string().min(1).max(240),
  archived: z.boolean(),
  trashed: z.boolean(),
  createdAt: z.string(),
});
export type Directory = z.infer<typeof directorySchema>;
export const segmentSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  page: z.number().int().positive().optional(),
  start: z.number().nonnegative().optional(),
  end: z.number().nonnegative().optional(),
});
export type Segment = z.infer<typeof segmentSchema>;
export type NormalizedSource = {
  segments: Segment[];
  chunks: Array<{ index: number; offset: number; duration: number }>;
  imageData?: string;
  visuals?: Array<{ segmentId: string; data: string }>;
};
export const questionSchema = z.object({
  id: z.string(),
  kind: z.enum(['single', 'short']).nullable(),
  prompt: z.string(),
  choices: z.array(z.string()).max(5),
  correctIndex: z.number().int().min(0).max(4).nullable(),
  expectedAnswer: z.string().nullable(),
  rubric: z.string().nullable(),
  explanation: z.string(),
  concept: z.string(),
  segmentIds: z.array(z.string()).min(1),
});
export type Question = z.infer<typeof questionSchema>;
export const artifactSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('signal'),
    title: z.string(),
    explanation: z.string(),
    segmentIds: z.array(z.string()).min(1),
    frequency: z.number().min(1).max(24),
    sampling: z.number().min(2).max(60),
    amplitude: z.number().min(0.1).max(1),
  }),
  z.object({
    kind: z.literal('comparison'),
    title: z.string(),
    explanation: z.string(),
    segmentIds: z.array(z.string()).min(1),
    rows: z
      .array(z.object({ label: z.string(), left: z.string(), right: z.string() }))
      .min(1)
      .max(10),
    leftTitle: z.string(),
    rightTitle: z.string(),
  }),
]);
export type Artifact = z.infer<typeof artifactSchema>;
export const synthesisSchema = z.object({
  title: z.string(),
  chapters: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        summary: z.string(),
        segmentIds: z.array(z.string()).min(1),
        questions: z.array(questionSchema).min(1).max(3),
      }),
    )
    .min(1)
    .max(12),
  glossary: z
    .array(
      z.object({
        term: z.string(),
        definition: z.string(),
        segmentIds: z.array(z.string()).min(1),
      }),
    )
    .max(40),
  artifact: artifactSchema.nullable(),
});
export type Synthesis = z.infer<typeof synthesisSchema>;
export type PublicQuestion = Omit<
  Question,
  'correctIndex' | 'explanation' | 'expectedAnswer' | 'rubric'
>;
export type PublicSynthesis = Omit<Synthesis, 'chapters'> & {
  chapters: Array<
    Omit<Synthesis['chapters'][number], 'questions'> & { questions: PublicQuestion[] }
  >;
};
export type Learning = {
  sourceId: string;
  sourceVersion: number;
  model: string;
  locale: Locale;
  segments: Segment[];
  synthesis: Synthesis;
  createdAt: string;
};
export type PublicLearning = Omit<Learning, 'synthesis'> & { synthesis: PublicSynthesis };
export type Bookmark = {
  id: string;
  sourceId: string;
  label: string;
  seconds?: number;
  page?: number;
};
export type Note = { id: string; sourceId: string; text: string; createdAt: string };
export const MAX_RESOURCE_TABS = 100;
export const resourceTabSchema = z
  .object({
    id: z.string().min(1).max(200),
    sources: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length),
    preview: z.boolean(),
    /** An artifact tab shows the source's generated artifact instead of the source. */
    view: z.literal('artifact').optional(),
    focusedSource: z.string().optional(),
    splitRatio: z.number().min(0.2).max(0.8).optional(),
  })
  .refine((tab) => !tab.focusedSource || tab.sources.includes(tab.focusedSource));
export type ResourceTab = z.infer<typeof resourceTabSchema>;
export const sessionSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(160),
  tabs: z.array(z.string()).max(MAX_RESOURCE_TABS * 2),
  active: z.string().nullable(),
  split: z.string().nullable(),
  resourceTabs: z
    .array(resourceTabSchema)
    .max(MAX_RESOURCE_TABS)
    .refine(
      (values) =>
        new Set(values.map((tab) => tab.id)).size === values.length &&
        values.filter((tab) => tab.preview).length <= 1,
    )
    .optional(),
  activeTabId: z.string().nullable().optional(),
  positions: z.record(z.string(), z.number().nonnegative()),
  notes: z
    .array(
      z.object({
        id: z.string(),
        sourceId: z.string(),
        text: z.string().max(20000),
        createdAt: z.string(),
      }),
    )
    .max(1000),
  bookmarks: z
    .array(
      z.object({
        id: z.string(),
        sourceId: z.string(),
        label: z.string().max(240),
        seconds: z.number().optional(),
        page: z.number().optional(),
      }),
    )
    .max(1000),
  createdAt: z.string(),
  artifacts: z
    .record(
      z.string(),
      z.object({
        frequency: z.number().min(1).max(24),
        sampling: z.number().min(2).max(60),
        amplitude: z.number().min(0.1).max(1),
      }),
    )
    .default({}),
  conversations: z
    .record(
      z.string(),
      z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().max(16000),
            tools: z.array(z.string()).optional(),
          }),
        )
        .max(100),
    )
    .default({}),
});
export type StudySession = z.infer<typeof sessionSchema>;
export type Attempt = {
  id: string;
  sourceId: string;
  sourceVersion: number;
  questionId: string;
  concept: string;
  selected: number;
  answer?: string;
  pendingReview?: boolean;
  learningVersion?: string;
  runId?: string;
  chapterId?: string;
  question?: PublicQuestion;
  reinforcementId?: string;
  reinforcementVersion?: number;
  correct: boolean;
  explanation: string;
  segmentIds: string[];
  createdAt: string;
};
export type Job = {
  id: string;
  sourceId: string;
  sourceVersion: number;
  locale: Locale;
  status: 'queued' | 'running' | 'partial' | 'completed' | 'failed' | 'cancelled';
  stage: 'normalize' | 'transcribe' | 'translate' | 'synthesize' | 'done';
  completedChunks: number;
  totalChunks: number;
  attempts: number;
  error?: string;
  createdAt: string;
};
export type Settings = { configured: boolean; locale: Locale; model: string; keySuffix?: string };
export type ConceptSource = {
  sourceId: string;
  sourceVersion: number;
  segmentIds: string[];
  location?: import('./annotations').SourceLocation;
  endSeconds?: number;
};
export type Concept = {
  id: string;
  term: string;
  definition: string;
  version: number;
  reviewed: boolean;
  sources: ConceptSource[];
  proposals: Array<{ id: string; definition: string; source: ConceptSource }>;
  aliases?: string[];
  senses?: import('./glossary').GlossarySense[];
  archived?: boolean;
  mergedInto?: string;
  updatedAt?: string;
};
export type Catalog = {
  files: Source[];
  directories: Directory[];
  sessions: StudySession[];
  attempts: Attempt[];
  concepts: Concept[];
  conversations: import('./conversations').Conversation[];
  settings: Settings;
};
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export function kindFor(name: string): Kind | null {
  const ext = name.split('.').pop()?.toLowerCase();
  if (['mp4', 'webm', 'mov', 'mkv'].includes(ext || '')) return 'video';
  if (['wav', 'mp3', 'm4a', 'ogg', 'flac'].includes(ext || '')) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext || '')) return 'image';
  if (ext === 'md') return 'markdown';
  if (['txt', 'csv'].includes(ext || '')) return 'text';
  return null;
}
export const fold = (value: string) =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();
export function mergeConcept(
  existing: Concept | undefined,
  term: string,
  definition: string,
  source: ConceptSource,
): Concept {
  if (!existing)
    return {
      id: crypto.randomUUID(),
      term,
      definition,
      version: 1,
      reviewed: false,
      sources: [source],
      proposals: [],
    };
  const sameSource = (a: ConceptSource, b: ConceptSource) =>
    a.sourceId === b.sourceId &&
    a.sourceVersion === b.sourceVersion &&
    a.segmentIds.join('|') === b.segmentIds.join('|');
  const sources = existing.sources.some((s) => sameSource(s, source))
    ? existing.sources
    : [...existing.sources, source];
  if (fold(existing.definition) === fold(definition)) return { ...existing, sources };
  if (
    existing.proposals.some(
      (p) => fold(p.definition) === fold(definition) && sameSource(p.source, source),
    )
  )
    return { ...existing, sources };
  return {
    ...existing,
    sources,
    proposals: [...existing.proposals, { id: crypto.randomUUID(), definition, source }],
  };
}
/** `imageIds` are segments with visual evidence, which image widgets may show. */
export function validateSynthesis(
  value: unknown,
  segments: Segment[],
  imageIds = new Set<string>(),
): Synthesis {
  const parsed = synthesisSchema.parse(value),
    ids = new Set(segments.map((s) => s.id));
  const seen = new Set<string>();
  for (const chapter of parsed.chapters) {
    if (seen.has(chapter.id)) throw new Error('Duplicate chapter identity');
    seen.add(chapter.id);
    for (const id of chapter.segmentIds)
      if (!ids.has(id)) throw new Error('Unresolvable chapter reference');
    for (const q of chapter.questions) {
      if (q.kind === 'short') {
        if (!q.expectedAnswer?.trim() || !q.rubric?.trim())
          throw new Error('Short answers require an explicit rubric');
      } else if (
        q.correctIndex == null ||
        q.choices.length < 2 ||
        q.correctIndex >= q.choices.length
      )
        throw new Error('Invalid question solution');
      for (const id of q.segmentIds)
        if (!ids.has(id)) throw new Error('Unresolvable question reference');
    }
  }
  const questionIds = parsed.chapters.flatMap((c) => c.questions.map((q) => q.id));
  if (new Set(questionIds).size !== questionIds.length)
    throw new Error('Duplicate question identity');
  for (const term of parsed.glossary)
    for (const id of term.segmentIds)
      if (!ids.has(id)) throw new Error('Unresolvable glossary reference');
  if (parsed.artifact)
    for (const id of parsed.artifact.segmentIds)
      if (!ids.has(id)) throw new Error('Unresolvable artifact reference');
  const terms = new Map<string, Synthesis['glossary'][number]>();
  for (const term of parsed.glossary) {
    const key = fold(term.term);
    if (!terms.has(key)) terms.set(key, term);
  }
  return {
    ...parsed,
    glossary: [...terms.values()],
    artifact: parsed.artifact && {
      ...parsed.artifact,
      explanation: sanitizeWidgets(parsed.artifact.explanation, ids, imageIds),
    },
  };
}
export function publicLearning(value: Learning): PublicLearning {
  return {
    ...value,
    synthesis: {
      ...value.synthesis,
      chapters: value.synthesis.chapters.map((c) => ({
        ...c,
        questions: c.questions.map(
          ({
            correctIndex: _correct,
            explanation: _explanation,
            expectedAnswer: _expected,
            rubric: _rubric,
            ...q
          }) => q,
        ),
      })),
    },
  };
}
export function reviewSummary(attempts: Attempt[]) {
  const graded = attempts.filter((a) => !a.pendingReview),
    count = graded.length,
    correct = graded.filter((a) => a.correct).length;
  return {
    count,
    correct,
    percent: count ? Math.round((correct / count) * 100) : null,
    needsPractice: [...new Set(graded.filter((a) => !a.correct).map((a) => a.concept))],
    evidence: count === 0 ? 'insufficient' : count < 3 ? 'limited' : 'observed',
  };
}
export function captionTime(seconds: number, srt = false) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${srt ? ',' : '.'}${String(ms % 1000).padStart(3, '0')}`;
}
export function captions(segments: Segment[], srt = false) {
  return `${srt ? '' : 'WEBVTT\n\n'}${segments
    .filter((s) => s.start != null && s.end != null)
    .map(
      (s, i) =>
        `${srt ? i + 1 : s.id}\n${captionTime(s.start!, srt)} --> ${captionTime(s.end!, srt)}\n${s.text.replace(/-->/g, '→').replace(/\n\s*\n/g, '\n')}\n`,
    )
    .join('\n')}`;
}
