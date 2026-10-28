import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, open, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_FILE_BYTES, kindSchema } from '../shared/domain';
import { normalize } from './media';
import { museStatus, codeSession } from './muse';
import { z } from 'zod';
import { composeCapture } from './capture-image';
import { drawingSchema } from '../shared/annotations';
import { captureDrawingSchema } from '../shared/capture-drawing';
import { renderCapture } from './capture-render';
import { TutorTransport, TutorTransportError, type TutorProvider } from './tutor-transport';

export async function startBridge(
  token: string,
  root: string,
  port = 9877,
  tutorProvider?: TutorProvider,
) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const tutor = new TutorTransport(join(root, 'tutor-requests'), tutorProvider);
  const server = createServer(async (req, res) => {
    const send = (value: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      const supplied = Buffer.from(req.headers.authorization || ''),
        expected = Buffer.from(`Bearer ${token}`);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        send({ error: 'Unauthorized' }, 401);
        return;
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const tutorMatch = url.pathname.match(/^\/tutor-requests\/([a-f0-9]{64})(\/cancel)?$/);
      if (tutorMatch) {
        let result;
        if (req.method === 'GET' && !tutorMatch[2]) result = await tutor.get(tutorMatch[1]);
        else if (req.method === 'POST' && tutorMatch[2]) result = await tutor.cancel(tutorMatch[1]);
        else if (req.method === 'POST') {
          const key = req.headers['x-meta-key'];
          if (typeof key !== 'string') throw new TutorTransportError('Meta credential is missing');
          const parts: Buffer[] = [];
          let length = 0;
          for await (const part of req) {
            length += part.length;
            if (length > 32 * 1024 * 1024)
              throw new TutorTransportError('Model request exceeds 32 MB', 413);
            parts.push(Buffer.from(part));
          }
          result = await tutor.start(
            tutorMatch[1],
            key,
            JSON.parse(Buffer.concat(parts).toString()),
          );
        } else {
          send({ error: 'Method not allowed' }, 405);
          return;
        }
        send(result || { error: 'Stream request not found' }, result ? 200 : 404);
        return;
      }
      if (url.pathname === '/render-capture' && req.method === 'POST') {
        const parts: Buffer[] = [];
        let length = 0;
        for await (const part of req) {
          length += part.length;
          if (length > 12 * 1024 * 1024) throw new Error('Capture request exceeds 12 MB');
          parts.push(Buffer.from(part));
        }
        const input = z
          .object({
            image: z
              .string()
              .max(12 * 1024 * 1024)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/),
            drawing: captureDrawingSchema,
          })
          .parse(JSON.parse(Buffer.concat(parts).toString()));
        const result = await renderCapture(Buffer.from(input.image, 'base64'), input.drawing);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': result.bytes.length,
          'X-Capture-Width': result.width,
          'X-Capture-Height': result.height,
          'Cache-Control': 'no-store',
        });
        res.end(result.bytes);
        return;
      }
      if (url.pathname === '/capture-image' && req.method === 'POST') {
        const parts: Buffer[] = [];
        let bytes = 0;
        for await (const part of req) {
          bytes += part.length;
          if (bytes > 5 * 1024 * 1024) throw new Error('Capture request exceeds 5 MB');
          parts.push(Buffer.from(part));
        }
        const input = z
          .object({ image: z.string().max(4 * 1024 * 1024), strokes: drawingSchema })
          .parse(JSON.parse(Buffer.concat(parts).toString()));
        const image = await composeCapture(Buffer.from(input.image, 'base64'), input.strokes);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': image.length,
          'Cache-Control': 'no-store',
        });
        res.end(image);
        return;
      }
      if (
        ['/meta/chat/completions', '/meta/asr/transcribe'].includes(url.pathname) &&
        req.method === 'POST'
      ) {
        const key = req.headers['x-meta-key'];
        if (typeof key !== 'string' || key.length > 1024)
          throw new Error('Meta credential is missing');
        const parts: Buffer[] = [];
        let bytes = 0;
        for await (const part of req) {
          bytes += part.length;
          if (bytes > 32 * 1024 * 1024) throw new Error('Meta request exceeds 32 MB');
          parts.push(Buffer.from(part));
        }
        const response = await fetch(
          `https://api.meta.ai/v1/${url.pathname.slice('/meta/'.length)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${key}`,
              'Content-Type': String(req.headers['content-type'] || 'application/json'),
            },
            body: Buffer.concat(parts),
            signal: AbortSignal.timeout(180000),
          },
        );
        res.writeHead(response.status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        if (!response.body) {
          res.end();
          return;
        }
        const reader = response.body.getReader();
        let responseBytes = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          responseBytes += value.length;
          if (responseBytes > 8 * 1024 * 1024) {
            await reader.cancel();
            throw new Error('Meta response exceeds 8 MB');
          }
          res.write(value);
        }
        res.end();
        return;
      }
      const match = url.pathname.match(/^\/normalize\/([a-f0-9-]+-v\d+-(?:en|es))$/);
      if (match && req.method === 'POST') {
        const directory = join(root, match[1]);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        try {
          const existing = await readFile(join(directory, 'normalized.json'), 'utf8');
          req.resume();
          send(JSON.parse(existing));
          return;
        } catch {}
        const parts: Buffer[] = [];
        let requestBytes = 0;
        for await (const part of req) {
          requestBytes += part.length;
          if (requestBytes > 2048) throw new Error('Invalid normalization request');
          parts.push(Buffer.from(part));
        }
        const source = z
          .object({
            sourceId: z.string().uuid(),
            sourceVersion: z.number().int().positive(),
            mime: z.string().max(160),
          })
          .parse(JSON.parse(Buffer.concat(parts).toString()));
        const metadata = await fetch(`http://127.0.0.1:9876/api/files/${source.sourceId}`);
        if (!metadata.ok) throw new Error('Source metadata is unavailable');
        if (((await metadata.json()) as { version: number }).version !== source.sourceVersion)
          throw new Error('Source version changed');
        const original = await fetch(`http://127.0.0.1:9876/api/files/${source.sourceId}/content`);
        if (!original.ok || !original.body) throw new Error('Original source is unavailable');
        const handle = await open(join(directory, 'upload.tmp'), 'w', 0o600);
        let bytes = 0;
        const reader = original.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            if (bytes > MAX_FILE_BYTES) {
              await reader.cancel();
              throw new Error('File exceeds 2 GB');
            }
            await handle.write(value);
          }
        } finally {
          await handle.close();
        }
        await rename(join(directory, 'upload.tmp'), join(directory, 'original'));
        const kind = kindSchema.parse(url.searchParams.get('kind'));
        const result = await normalize(directory, kind, source.mime);
        await writeFile(join(directory, 'normalized.json'), JSON.stringify(result), {
          mode: 0o600,
        });
        send(result);
        return;
      }
      const chunkMatch = url.pathname.match(/^\/chunks\/([a-f0-9-]+-v\d+-(?:en|es))\/(\d+)$/);
      if (chunkMatch) {
        const data = await readFile(
          join(root, chunkMatch[1], `chunk-${chunkMatch[2].padStart(3, '0')}.wav`),
        );
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': data.length });
        res.end(data);
        return;
      }
      if (url.pathname === '/api/code/status') {
        send(await museStatus());
        return;
      }
      if (url.pathname === '/api/code/sessions' && req.method === 'POST') {
        const parts: Buffer[] = [];
        let bytes = 0;
        for await (const part of req) {
          bytes += part.length;
          if (bytes > 16000) throw new Error('Prompt is too large');
          parts.push(Buffer.from(part));
        }
        const { prompt } = z
          .object({ prompt: z.string().trim().min(1).max(8000) })
          .parse(JSON.parse(Buffer.concat(parts).toString()));
        send(await codeSession(join(root, 'code'), prompt));
        return;
      }
      send({ error: 'Not found' }, 404);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else
        send(
          { error: error instanceof Error ? error.message : 'Media operation failed' },
          error instanceof TutorTransportError ? error.status : 422,
        );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  try {
    await tutor.initialize();
  } catch (error) {
    server.close();
    throw error;
  }
  server.once('close', () => {
    void tutor
      .shutdown()
      .catch(() => console.error('Unable to finish saving local tutor streams.'));
  });
  return Object.assign(server, { shutdownTutor: () => tutor.shutdown() });
}
