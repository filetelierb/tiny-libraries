import { z } from 'zod';
import type { Learning } from './domain';
import { parseWidget, sanitizeWidgets, widgetCitations } from './artifact-widgets';

/**
 * Artifacts the tutor writes are library files of their own. They are generated in stages:
 * a plan, then every chapter in parallel, a check of each chapter with one repair round, and
 * the assembly into one document whose references point back to the files it used.
 */
export const artifactGoals = ['understand', 'summarize', 'review', 'exam'] as const;
export const artifactLengths = ['short', 'standard', 'deep'] as const;
export const tutorArtifactRequestSchema = z.object({
  request: z.string().trim().min(1).max(4000),
  title: z.string().trim().max(160).optional(),
  goal: z.enum(artifactGoals).default('understand'),
  length: z.enum(artifactLengths).default('standard'),
  /** The student's language, such as Spanish; the app language when absent. */
  language: z.string().trim().min(2).max(40).optional(),
  sourceIds: z.array(z.string().uuid()).min(1).max(8),
  /** An existing tutor artifact to write a new version of. */
  artifactId: z.string().uuid().optional(),
});
export type TutorArtifactRequest = z.infer<typeof tutorArtifactRequestSchema>;

export const chapterCount = { short: [2, 3], standard: [3, 5], deep: [5, 7] } as const;
export const widgetTypes = [
  'summary',
  'compare',
  'steps',
  'timeline',
  'predict',
  'explorable',
  'chart',
  'image',
  'details',
] as const;
export const artifactPlanSchema = z.object({
  title: z.string().min(1).max(160),
  guidingQuestion: z.string().min(1).max(400),
  introduction: z.string().min(1).max(1200),
  chapters: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        objective: z.string().min(1).max(400),
        keyIdeas: z.array(z.string().min(1).max(300)).min(1).max(6),
        widgets: z.array(z.enum(widgetTypes)).max(2),
        segmentIds: z.array(z.string()).max(24),
      }),
    )
    .min(2)
    .max(7),
});
export type ArtifactPlan = z.infer<typeof artifactPlanSchema>;
export const artifactChapterSchema = z.object({ markdown: z.string().min(1).max(30000) });

/** A passage the artifact cites, with its file and place, under the id the model used. */
export const artifactReferenceSchema = z.object({
  id: z.string().min(1).max(260),
  sourceId: z.string().uuid(),
  sourceVersion: z.number().int().positive(),
  segmentId: z.string().min(1).max(240),
  text: z.string().max(4000),
  page: z.number().int().positive().optional(),
  seconds: z.number().nonnegative().optional(),
});
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export const tutorArtifactDocumentSchema = z.object({
  format: z.literal(1),
  title: z.string().min(1).max(160),
  guidingQuestion: z.string().max(400),
  markdown: z.string().min(1).max(400000),
  references: z.array(artifactReferenceSchema).max(400),
  request: z.string().max(4000),
  goal: z.enum(artifactGoals),
  length: z.enum(artifactLengths),
  createdAt: z.string(),
});
export type TutorArtifactDocument = z.infer<typeof tutorArtifactDocumentSchema>;

export type ArtifactMaterial = {
  /** Short alias the model cites, such as r1. */
  alias: string;
  sourceId: string;
  sourceVersion: number;
  name: string;
  chapters: Array<{ title: string; summary: string }>;
  segments: Array<{ id: string; text: string; page?: number; seconds?: number }>;
};
export const MATERIAL_BUDGET = 90000;
const PER_SOURCE_BUDGET = 30000;

/**
 * The passages the generator sees: each file's chapter summaries and passages spread evenly
 * across the whole file, within a shared budget. Passage ids become `r1:p12`, short and unique.
 */
export function artifactMaterials(
  files: Array<{ learning: Learning; name: string }>,
  budget = MATERIAL_BUDGET,
): ArtifactMaterial[] {
  const share = Math.min(PER_SOURCE_BUDGET, Math.floor(budget / Math.max(1, files.length)));
  return files.map(({ learning, name }, index) => {
    const alias = `r${index + 1}`,
      usable = learning.segments.filter((segment) => segment.text.trim()),
      total = usable.reduce((sum, segment) => sum + segment.text.length, 0),
      stride = Math.max(1, Math.ceil(total / share));
    const segments: ArtifactMaterial['segments'] = [];
    let size = 0;
    usable.forEach((segment, position) => {
      if (position % stride || size >= share) return;
      const text = segment.text.slice(0, 1500);
      size += text.length;
      segments.push({
        id: `${alias}:${segment.id}`,
        text,
        ...(segment.page ? { page: segment.page } : {}),
        ...(segment.start != null ? { seconds: segment.start } : {}),
      });
    });
    return {
      alias,
      sourceId: learning.sourceId,
      sourceVersion: learning.sourceVersion,
      name,
      chapters: learning.synthesis.chapters.map((chapter) => ({
        title: chapter.title,
        summary: chapter.summary,
      })),
      segments,
    };
  });
}
export const materialIds = (materials: ArtifactMaterial[]) =>
  new Set(materials.flatMap((material) => material.segments.map((segment) => segment.id)));

const fence = /^```widget[ \t]*\n([\s\S]*?)\n```[ \t]*$/gm;
const inlineCite = /\[((?:r\d+):[^\]\s]+)\]/g;

/** What a written chapter gets wrong, phrased so the model can repair it. */
export function chapterIssues(markdown: string, title: string, ids: Set<string>) {
  const issues: string[] = [];
  if (!/^##\s+\S/m.test(markdown)) issues.push(`Start the chapter with "## ${title}".`);
  if ((markdown.match(/^##\s+\S/gm) || []).length > 1)
    issues.push('Write exactly one ## heading; use ### for sections inside the chapter.');
  if (markdown.replace(fence, '').trim().length < 400)
    issues.push('The explanation is too short: develop the objective in prose.');
  for (const [, body] of markdown.matchAll(fence)) {
    const widget = parseWidget(body);
    if (!widget) issues.push(`Fix or remove this invalid widget: ${body.slice(0, 160)}`);
    else
      for (const id of widgetCitations(widget))
        if (!ids.has(id)) issues.push(`Widget cites unknown passage ${id}; use a supplied id.`);
  }
  for (const [, id] of markdown.matchAll(inlineCite))
    if (!ids.has(id)) issues.push(`Unknown citation [${id}]; cite only supplied passage ids.`);
  if (!markdown.match(inlineCite) && !markdown.match(/"segmentId"/))
    issues.push('Cite the passages the chapter relies on as [r1:id].');
  return issues;
}

/**
 * One document from the plan and its chapters. Inline citations become numbered references,
 * widgets that still cite unknown passages are dropped, and only cited passages are kept.
 */
export function assembleArtifact(
  plan: ArtifactPlan,
  chapters: string[],
  materials: ArtifactMaterial[],
  context: {
    request: string;
    goal: TutorArtifactDocument['goal'];
    length: TutorArtifactDocument['length'];
  },
): TutorArtifactDocument {
  const ids = materialIds(materials);
  const byId = new Map(
    materials.flatMap((material) =>
      material.segments.map((segment) => [segment.id, { material, segment }] as const),
    ),
  );
  const cited: string[] = [];
  const cite = (id: string) => {
    if (!cited.includes(id)) cited.push(id);
    return cited.indexOf(id) + 1;
  };
  const body = chapters
    .map((chapter) => sanitizeWidgets(chapter, ids))
    .join('\n\n')
    .replace(inlineCite, (match, id: string) =>
      ids.has(id) ? `[[${cite(id)}]](#ref-${encodeURIComponent(id)})` : '',
    );
  for (const [, widget] of body.matchAll(fence)) {
    const parsed = parseWidget(widget);
    if (parsed) for (const id of widgetCitations(parsed)) cite(id);
  }
  return {
    format: 1,
    title: plan.title,
    guidingQuestion: plan.guidingQuestion,
    markdown: `> [!key]\n> ${plan.guidingQuestion}\n\n${plan.introduction}\n\n${body}`.trim(),
    references: cited.map((id) => {
      const { material, segment } = byId.get(id)!;
      return {
        id,
        sourceId: material.sourceId,
        sourceVersion: material.sourceVersion,
        segmentId: id.slice(material.alias.length + 1),
        text: segment.text,
        ...(segment.page ? { page: segment.page } : {}),
        ...(segment.seconds != null ? { seconds: segment.seconds } : {}),
      };
    }),
    request: context.request,
    goal: context.goal,
    length: context.length,
    createdAt: new Date().toISOString(),
  };
}

/** Generation state, saved after every stage so a restarted app continues where it stopped. */
export type TutorArtifactJob = {
  id: string;
  /** The library file that holds the artifact once it is saved. */
  fileId: string;
  conversationId: string;
  /** The tutor turn that started this generation. Preserved so the Agent activity panel can
   * attach the artifact's progress events to that turn's lane. */
  turnId?: string;
  sessionId?: string;
  request: TutorArtifactRequest;
  locale: 'en' | 'es';
  model: string;
  status: 'planning' | 'writing' | 'checking' | 'saving' | 'ready' | 'failed';
  plan?: ArtifactPlan;
  chapters: Array<string | null>;
  /** The file version this job saved. */
  version?: number;
  title?: string;
  error?: string;
  owner?: string;
  until?: number;
  createdAt: string;
  updatedAt: string;
};
export type TutorArtifactStatus = Pick<
  TutorArtifactJob,
  'id' | 'fileId' | 'status' | 'title' | 'version' | 'error' | 'createdAt' | 'updatedAt'
> & { chapters: { done: number; total: number } };
export const artifactStatus = (job: TutorArtifactJob): TutorArtifactStatus => ({
  id: job.id,
  fileId: job.fileId,
  status: job.status,
  title: job.title || job.plan?.title || job.request.title,
  ...(job.version ? { version: job.version } : {}),
  ...(job.error ? { error: job.error } : {}),
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  chapters: {
    done: job.chapters.filter((chapter) => chapter !== null).length,
    total: job.plan?.chapters.length || 0,
  },
});
