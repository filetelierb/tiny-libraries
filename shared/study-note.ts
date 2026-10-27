import { z } from 'zod';

const marker = '<study_note>';
const closingMarker = '</study_note>';
export const studyNoteCategories = [
  'concept',
  'comparison',
  'procedure',
  'example',
  'summary',
] as const;
export const studyNoteSuggestionSchema = z.discriminatedUnion('recommended', [
  z.object({ recommended: z.literal(false) }),
  z.object({
    recommended: z.literal(true),
    category: z.enum(studyNoteCategories),
    body: z.string().trim().min(1).max(10000),
  }),
]);
export type StudyNoteSuggestion = z.infer<typeof studyNoteSuggestionSchema>;

// An output convention, not a tool: a suggestion only seeds a draft and never saves an annotation.
export const studyNoteInstructions = `After your answer, append exactly one metadata block outside the text meant for the student: ${marker}{"recommended":true,"category":"concept","body":"Self-contained study note"}${closingMarker}. Recommend a note only when the answer holds knowledge worth reviewing; category must be exactly concept, comparison, procedure, example or summary. Keep the note brief, in the user's language and faithful to your answer, keeping its citations, limits and uncertainty; never invent sources or add new information. For greetings, errors, clarifying questions, bookmark actions or answers without study content, append ${marker}{"recommended":false}${closingMarker}. Never put this block inside code or mention it to the student.`;

/** Hides complete and partially streamed metadata while keeping all ordinary answer text. */
export function visibleTutorText(text: string) {
  const start = text.indexOf(marker);
  if (start >= 0) return text.slice(0, start).trimEnd();
  for (let length = marker.length - 1; length > 0; length--)
    if (text.endsWith(marker.slice(0, length))) return text.slice(0, -length).trimEnd();
  return text;
}

/** Splits a finished reply into visible text and an optional, validated note suggestion. */
export function parseTutorAnswer(text: string): {
  answer: string;
  suggestion?: StudyNoteSuggestion;
} {
  const answer = visibleTutorText(text).trim();
  const start = text.indexOf(marker),
    end = text.indexOf(closingMarker, start);
  if (start < 0 || end < 0) return { answer };
  try {
    const result = studyNoteSuggestionSchema.safeParse(
      JSON.parse(text.slice(start + marker.length, end)),
    );
    return result.success ? { answer, suggestion: result.data } : { answer };
  } catch {
    // Suggestions are optional; never discard an answer over malformed metadata.
    return { answer };
  }
}
