import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, normalize } from '../server/media';

test('a recording longer than ten minutes becomes bounded WAV chunks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tailored-audio-'));
  await command('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=16000',
    '-t',
    '611',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    join(directory, 'original') + '.wav',
  ]);
  const { rename } = await import('node:fs/promises');
  await rename(join(directory, 'original.wav'), join(directory, 'original'));
  const result = await normalize(directory, 'audio', 'audio/wav');
  // Chunks own consecutive five-minute spans and overlap their neighbours by 20 seconds.
  assert.deepEqual(
    result.chunks.map((c) => [c.from, c.to, c.offset]),
    [
      [0, 300, 0],
      [300, 600, 280],
      [600, 611, 580],
    ],
  );
  assert.ok(Math.abs(result.chunks[0].duration - 320) < 0.1);
  assert.ok(Math.abs(result.chunks[1].duration - 331) < 0.1);
  assert.ok(Math.abs(result.chunks[2].duration - 31) < 0.1);
  for (let i = 0; i < 3; i++)
    assert.ok(
      (await stat(join(directory, `chunk-${String(i).padStart(3, '0')}.wav`))).size <
        32 * 1024 * 1024,
    );
});
test('text normalization gives stable section identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tailored-text-'));
  await writeFile(join(directory, 'original'), 'A'.repeat(8001));
  const result = await normalize(directory, 'text', 'text/plain');
  assert.deepEqual(
    result.segments.map((s) => s.id),
    ['section-1', 'section-2', 'section-3'],
  );
});
test('visual PDF pages retain page locators and render as local image evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tailored-pdf-'));
  const stream = '0.1 0.4 0.4 rg 30 30 100 100 re f';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await writeFile(join(directory, 'original'), pdf);
  const result = await normalize(directory, 'pdf', 'application/pdf');
  assert.equal(result.segments[0].page, 1);
  assert.equal(result.segments[0].id, 'page-1');
  assert.match(result.visuals![0].data, /^data:image\/png;base64,/);
});
test('video normalization supplies independent timestamped visual evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tailored-video-'));
  await command('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=teal:s=320x240:r=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=16000',
    '-t',
    '3',
    '-c:v',
    'mpeg4',
    '-c:a',
    'aac',
    join(directory, 'fixture.mp4'),
  ]);
  const { rename } = await import('node:fs/promises');
  await rename(join(directory, 'fixture.mp4'), join(directory, 'original'));
  const result = await normalize(directory, 'video', 'video/mp4');
  assert.equal(result.chunks.length, 1);
  assert.equal(result.visuals!.length, 4);
  assert.ok(result.segments.every((s) => s.start! >= 0 && s.end! <= 3.1));
});
