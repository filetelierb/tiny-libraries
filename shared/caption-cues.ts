/** About two subtitle lines; a transcribed turn is split into cues of this size. */
export const CAPTION_CHARS = 84;
export type CaptionCue = { start: number; end: number; text: string };

/**
 * Splits one timed passage into short consecutive cues. Words are kept whole, a sentence end
 * closes a cue once it is half full, and each cue gets a share of the passage's time in
 * proportion to its length, so the cue on screen follows the speech.
 */
export function captionCues(text: string, start: number, end: number): CaptionCue[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const chunks: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > CAPTION_CHARS) {
      chunks.push(current);
      current = word;
    } else current = next;
    if (/[.!?…]["”’)]?$/.test(word) && current.length >= CAPTION_CHARS / 2) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  const total = chunks.reduce((n, chunk) => n + chunk.length, 0),
    span = Math.max(0, end - start);
  let at = start;
  return chunks.map((chunk, i) => {
    const from = at;
    at = i === chunks.length - 1 ? end : at + (span * chunk.length) / total;
    return { start: from, end: at, text: chunk };
  });
}
