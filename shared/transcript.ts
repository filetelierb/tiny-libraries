import type { Segment } from './domain';

export type TranscriptCue = { start: number; end: number; text: string };

const TIME = /(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
const seconds = (match: RegExpMatchArray) =>
  Number(match[1] ?? 0) * 3600 +
  Number(match[2]) * 60 +
  Number(match[3]) +
  Number(match[4].padEnd(3, '0')) / 1000;

/** Reads WebVTT or SRT cues; any other text yields no cues. Markup inside cues is dropped. */
export function parseTranscript(value: string): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  for (const block of value.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0) continue;
    const [from, to] = lines[at].split('-->');
    const start = from.match(TIME),
      end = to?.match(TIME);
    if (!start || !end) continue;
    const text = lines
      .slice(at + 1)
      .map((line) => line.replace(/<[^>]*>/g, '').trim())
      .filter(Boolean)
      .join('\n');
    if (text) cues.push({ start: seconds(start), end: seconds(end), text });
  }
  return cues;
}

/**
 * Groups cues into timed passages of about a minute so chapters can point at moments
 * of the recording; each passage's text is its cue lines, as they appear in the file.
 */
export function transcriptSegments(cues: TranscriptCue[], span = 60, maxChars = 2000) {
  const segments: Segment[] = [];
  for (const cue of cues) {
    const last = segments.at(-1);
    if (last && cue.start - last.start! < span && last.text.length + cue.text.length < maxChars) {
      last.text += `\n${cue.text}`;
      last.end = cue.end;
    } else
      segments.push({
        id: `cue-${segments.length + 1}`,
        text: cue.text,
        start: cue.start,
        end: cue.end,
      });
  }
  return segments;
}
