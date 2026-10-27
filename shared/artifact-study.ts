import { z } from 'zod';
import { questionSchema, type Question, type Segment } from './domain';

/** An artifact's `## ` headings are its chapters; text before the first one is an introduction. */
export function artifactChapters(markdown: string) {
  const chapters: Array<{ index: number; title: string; text: string }> = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) fenced = !fenced;
    const heading = !fenced && line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (heading) chapters.push({ index: chapters.length, title: heading[1], text: '' });
    else if (chapters.length) chapters.at(-1)!.text += `${line}\n`;
  }
  return chapters.map((chapter) => ({ ...chapter, text: chapter.text.trim() }));
}

export const artifactStudyPlanSchema = z.object({
  chapters: z
    .array(
      z.object({
        index: z.number().int().min(0),
        questions: z.array(questionSchema).min(1).max(3),
        cards: z
          .array(
            z.object({
              front: z.string().trim().min(1).max(400),
              back: z.string().trim().min(1).max(800),
              segmentIds: z.array(z.string()).min(1),
            }),
          )
          .min(2)
          .max(5),
      }),
    )
    .min(1)
    .max(20),
});
export type ArtifactStudyPlan = z.infer<typeof artifactStudyPlanSchema>;
export type ArtifactCard = ArtifactStudyPlan['chapters'][number]['cards'][number];
export type ArtifactStudyChapter = {
  id: string;
  index: number;
  title: string;
  summary: string;
  segmentIds: string[];
  questions: Question[];
  cards: ArtifactCard[];
};
export type ArtifactStudy = {
  sourceId: string;
  revision: number;
  status: 'generating' | 'ready' | 'failed';
  /** Identifies this generation; attempts record it as their study material version. */
  version: string;
  error?: string;
  chapters: ArtifactStudyChapter[];
  owner?: string;
  until?: number;
};
export type PublicArtifactStudy = Omit<ArtifactStudy, 'owner' | 'until' | 'chapters'> & {
  chapters: Array<
    Omit<ArtifactStudyChapter, 'questions'> & {
      questions: Array<
        Omit<Question, 'correctIndex' | 'expectedAnswer' | 'rubric' | 'explanation'>
      >;
    }
  >;
};
export type ArtifactStudySnapshot =
  PublicArtifactStudy | { status: 'pending' | 'unavailable'; revision: number | null };

export const artifactStudyKey = (sourceId: string) => `artifact-study:${sourceId}`;
export const artifactChapterId = (revision: number, index: number) =>
  `artifact-v${revision}-ch${index + 1}`;

/** Questions and cards must cite the source and solve their own questions. */
export function validateArtifactStudy(
  plan: ArtifactStudyPlan,
  chapters: ReturnType<typeof artifactChapters>,
  segments: Segment[],
  revision: number,
): ArtifactStudyChapter[] {
  const ids = new Set(segments.map((segment) => segment.id));
  const byIndex = new Map(plan.chapters.map((chapter) => [chapter.index, chapter]));
  return chapters.flatMap((chapter) => {
    const generated = byIndex.get(chapter.index);
    if (!generated) return [];
    const id = artifactChapterId(revision, chapter.index);
    const questions = generated.questions.map((question, number) => {
      if (question.kind === 'short') {
        if (!question.expectedAnswer?.trim() || !question.rubric?.trim())
          throw new Error('Short answers require an explicit rubric');
      } else if (
        question.correctIndex == null ||
        question.choices.length < 2 ||
        question.correctIndex >= question.choices.length
      )
        throw new Error('Invalid question solution');
      if (question.segmentIds.some((segmentId) => !ids.has(segmentId)))
        throw new Error('Unresolvable question reference');
      // Ids are namespaced so they never collide with the source's own chapter questions.
      return { ...question, id: `${id}-q${number + 1}` };
    });
    const cards = generated.cards.map((card) => {
      if (card.segmentIds.some((segmentId) => !ids.has(segmentId)))
        throw new Error('Unresolvable card reference');
      return card;
    });
    return [
      {
        id,
        index: chapter.index,
        title: chapter.title,
        summary: chapter.text.slice(0, 280),
        segmentIds: [...new Set([...questions, ...cards].flatMap((item) => item.segmentIds))],
        questions,
        cards,
      },
    ];
  });
}

export function publicArtifactStudy({ owner: _owner, until: _until, ...record }: ArtifactStudy) {
  return {
    ...record,
    chapters: record.chapters.map((chapter) => ({
      ...chapter,
      questions: chapter.questions.map(
        ({
          correctIndex: _correct,
          expectedAnswer: _expected,
          rubric: _rubric,
          explanation: _explanation,
          ...question
        }) => question,
      ),
    })),
  } satisfies PublicArtifactStudy;
}
