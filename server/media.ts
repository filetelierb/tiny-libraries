import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Kind, Segment, NormalizedSource } from '../shared/domain';
import { parseTranscript, transcriptSegments } from '../shared/transcript';

export const CHUNK_SECONDS = 300;
export const CHUNK_OVERLAP_SECONDS = 20;
export const MAX_RECORDING_SECONDS = 4 * 3600;
export function command(binary: string, args: string[], timeout = 180000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] }),
      out: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${binary} exceeded the processing time limit`));
    }, timeout);
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length;
      if (bytes < 2 * 1024 * 1024) out.push(data);
      else child.kill('SIGKILL');
    });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      reject(new Error(`${binary} is unavailable. Install it and retry.`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString());
      else reject(new Error(`${binary} could not process this file`));
    });
  });
}
export async function normalize(
  directory: string,
  kind: Kind,
  mime: string,
): Promise<NormalizedSource> {
  const input = join(directory, 'original');
  if (kind === 'video' || kind === 'audio') {
    const probe = JSON.parse(
      await command('ffprobe', [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'json',
        input,
      ]),
    );
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_RECORDING_SECONDS)
      throw new Error('Recordings must have a known duration of 4 hours or less');
    const audio = join(directory, 'audio.wav');
    await command(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-i',
        input,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'pcm_s16le',
        '-map_metadata',
        '-1',
        audio,
      ],
      600000,
    );
    // Chunks own consecutive spans and also hear CHUNK_OVERLAP_SECONDS of each neighbour,
    // so speech cut at a boundary is transcribed whole by one of them.
    const chunks = [];
    for (let index = 0; index * CHUNK_SECONDS < duration; index++) {
      const from = index * CHUNK_SECONDS,
        to = Math.min(duration, from + CHUNK_SECONDS),
        offset = Math.max(0, from - CHUNK_OVERLAP_SECONDS),
        chunkPath = join(directory, `chunk-${String(index).padStart(3, '0')}.wav`);
      await command('ffmpeg', [
        '-nostdin',
        '-v',
        'error',
        '-y',
        '-ss',
        String(offset),
        '-t',
        String(Math.min(duration, to + CHUNK_OVERLAP_SECONDS) - offset),
        '-i',
        audio,
        '-c:a',
        'pcm_s16le',
        chunkPath,
      ]);
      if ((await stat(chunkPath)).size > 31 * 1024 * 1024)
        throw new Error('Normalized audio chunk exceeds the ASR limit');
      const chunkProbe = JSON.parse(
        await command('ffprobe', [
          '-v',
          'error',
          '-show_entries',
          'format=duration',
          '-of',
          'json',
          chunkPath,
        ]),
      );
      const chunkDuration = Number(chunkProbe.format?.duration);
      if (!Number.isFinite(chunkDuration) || chunkDuration <= 0 || chunkDuration > 600)
        throw new Error('Invalid audio chunk duration');
      chunks.push({ index, offset, duration: chunkDuration, from, to });
    }
    await rm(audio, { force: true });
    const segments: Segment[] = [],
      visuals: Array<{ segmentId: string; data: string }> = [];
    if (kind === 'video') {
      for (let i = 0; i < 4; i++) {
        const second = Math.min(duration - 0.1, (duration * (i + 0.5)) / 4),
          framePath = join(directory, `frame-${i}.jpg`);
        await command('ffmpeg', [
          '-nostdin',
          '-v',
          'error',
          '-y',
          '-ss',
          String(second),
          '-i',
          input,
          '-frames:v',
          '1',
          '-vf',
          'scale=960:-2',
          '-q:v',
          '5',
          framePath,
        ]);
        const id = `frame-${i}`;
        segments.push({
          id,
          text: 'Sampled visual frame from the original recording; not a transcript quotation.',
          start: second,
          end: second,
        });
        visuals.push({
          segmentId: id,
          data: `data:image/jpeg;base64,${(await readFile(framePath)).toString('base64')}`,
        });
      }
    }
    return { segments, chunks, visuals };
  }
  if (kind === 'image') {
    if ((await stat(input)).size > 8 * 1024 * 1024)
      throw new Error('Images for AI preparation must be 8 MB or smaller');
    const buffer = await readFile(input);
    const contentType = mime.startsWith('image/') ? mime : 'image/png';
    return {
      segments: [
        {
          id: 'image-1',
          text: 'Original image. Interpret the supplied visual source; this label is not extracted text.',
        },
      ],
      chunks: [],
      imageData: `data:${contentType};base64,${buffer.toString('base64')}`,
    };
  }
  if (kind === 'pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = getDocument({ data: new Uint8Array(await readFile(input)), useSystemFonts: true });
    const document = await task.promise;
    try {
      // Long PDFs are analysed in overlapping windows; the bound keeps extraction within the step timeout.
      if (document.numPages > 1000) throw new Error('PDFs must contain 1,000 pages or fewer');
      const segments: Segment[] = [],
        visuals: Array<{ segmentId: string; data: string }> = [];
      let visualBytes = 0;
      for (let page = 1; page <= document.numPages; page++) {
        const pdfPage = await document.getPage(page),
          text = await pdfPage.getTextContent();
        const value = text.items
          .map((i) => ('str' in i ? i.str : ''))
          .join(' ')
          .trim();
        segments.push({
          id: `page-${page}`,
          text:
            value ||
            'Scanned page. Interpret the attached page image; this label is not extracted text.',
          page,
        });
        // Scanned pages and a bounded visual sample supplement extracted text.
        if (value.length < 80 || page === 1 || page === Math.ceil(document.numPages / 2)) {
          const { createCanvas } = await import('@napi-rs/canvas');
          const viewport = pdfPage.getViewport({ scale: 0.9 }),
            canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
          // PDF.js declares its renderer against DOM canvas; napi supplies the equivalent headless context.
          await pdfPage.render({
            canvas: null,
            canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
            viewport,
          }).promise;
          const data = canvas.toBuffer('image/png');
          visualBytes += data.length;
          if (visualBytes > 12 * 1024 * 1024)
            throw new Error(
              'Visual PDF content exceeds 12 MB. Split the PDF into smaller documents.',
            );
          visuals.push({
            segmentId: `page-${page}`,
            data: `data:image/png;base64,${data.toString('base64')}`,
          });
        }
      }
      return { segments, chunks: [], visuals };
    } finally {
      await task.destroy();
    }
  }
  if ((await stat(input)).size > 2 * 1024 * 1024)
    throw new Error('Text documents for preparation must be 2 MB or smaller');
  const value = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(input));
  if (!value.trim()) throw new Error('Document contains no text');
  // Subtitle files become timed passages, so their chapters point at moments of the talk.
  const cues = kind === 'text' ? parseTranscript(value) : [];
  const segments = cues.length
    ? transcriptSegments(cues)
    : value.match(/[\s\S]{1,4000}/g)?.map((text, i) => ({ id: `section-${i + 1}`, text })) || [];
  return { segments, chunks: [] };
}
