import { DurableObject } from 'cloudflare:workers';
import {
  captions,
  type Job,
  type Source,
  type Segment,
  type Locale,
  type Learning,
  type NormalizedSource,
} from '../shared/domain';
import { internal } from './index';
import { MetaError, bridgedFetch, synthesize, transcribe, translate } from './meta';

export type Normalized = NormalizedSource;
export class ProcessingJob extends DurableObject<Env> {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    let job = await this.ctx.storage.get<Job>('job');
    if (path === '/start' && request.method === 'POST') {
      if (job) return Response.json(job);
      const { id, file, locale } = await request.json<{
        id: string;
        file: Source;
        locale: Locale;
      }>();
      job = {
        id,
        sourceId: file.id,
        sourceVersion: file.version,
        locale,
        status: 'queued',
        stage: 'normalize',
        completedChunks: 0,
        totalChunks: 0,
        attempts: 0,
        createdAt: new Date().toISOString(),
      };
      await this.ctx.storage.put({ job, file });
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return Response.json(job, { status: 201 });
    }
    if (!job) return Response.json(null);
    if (request.method === 'DELETE') {
      job = { ...job, status: 'cancelled' };
      await this.ctx.storage.put('job', job);
      await this.ctx.storage.deleteAlarm();
    }
    if (request.method === 'POST' && (job.status === 'failed' || job.status === 'cancelled')) {
      job = { ...job, status: 'queued', error: undefined, attempts: 0 };
      await this.ctx.storage.put('job', job);
      await this.ctx.storage.setAlarm(Date.now() + 100);
    }
    const segments = await this.ctx.storage.get<Segment[]>('segments');
    return Response.json(
      { ...job, segments: segments || [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  async bridge(path: string, options: RequestInit = {}) {
    const response = await fetch(`${this.env.MEDIA_BRIDGE_URL}${path}`, {
      ...options,
      headers: { ...options.headers, Authorization: `Bearer ${this.env.MEDIA_BRIDGE_TOKEN}` },
      signal: AbortSignal.timeout(180000),
    });
    if (!response.ok) {
      const data = await response.json<{ error?: string }>().catch(() => ({ error: undefined }));
      throw new MetaError(data.error || 'Local media processing failed', response.status >= 500);
    }
    return response;
  }
  async alarm() {
    let job = await this.ctx.storage.get<Job>('job');
    if (!job || job.status === 'cancelled' || job.status === 'completed') return;
    const initial = job;
    try {
      // Schedule a recovery wake before external work; completed checkpoints are never repeated.
      await this.ctx.storage.setAlarm(Date.now() + 240000);
      job = { ...job, status: 'running', error: undefined };
      await this.ctx.storage.put('job', job);
      const file = (await this.ctx.storage.get<Source>('file'))!;
      const { key } = await internal<{ key: string | null }>(this.env, '/internal/key');
      if (!key) throw new MetaError('Add a Meta API key in Settings, then retry.', false);
      const settings = await internal<{ model: string }>(this.env, '/api/settings');
      if (job.stage === 'normalize') {
        // Let Node stream the immutable original from the loopback API. celld v0.6.3
        // cannot transfer an R2-owned body stream into outbound fetch here.
        const response = await this.bridge(`/normalize/${job.id}?kind=${file.kind}`, {
          method: 'POST',
          body: JSON.stringify({ sourceId: file.id, sourceVersion: file.version, mime: file.mime }),
          headers: { 'Content-Type': 'application/json' },
        });
        const normalized = await response.json<Normalized>();
        await this.ctx.storage.put({ normalized, segments: normalized.segments });
        job = {
          ...job,
          totalChunks: normalized.chunks.length,
          stage: normalized.chunks.length ? 'transcribe' : 'synthesize',
        };
      } else if (job.stage === 'transcribe') {
        const normalized = (await this.ctx.storage.get<Normalized>('normalized'))!,
          chunk = normalized.chunks[job.completedChunks];
        const cacheKey = `chunk:${chunk.index}`;
        let result = await this.ctx.storage.get<Segment[]>(cacheKey);
        if (!result) {
          const audio = await (await this.bridge(`/chunks/${job.id}/${chunk.index}`)).arrayBuffer();
          result = await transcribe(
            key,
            audio,
            chunk.index,
            chunk.offset,
            chunk.duration,
            bridgedFetch(this.env),
          );
          await this.ctx.storage.put(cacheKey, result);
        }
        const segments: Segment[] = [...normalized.segments];
        for (let i = 0; i <= job.completedChunks; i++)
          segments.push(...((await this.ctx.storage.get<Segment[]>(`chunk:${i}`)) || []));
        await this.ctx.storage.put('segments', segments);
        job = { ...job, completedChunks: job.completedChunks + 1, status: 'partial' };
        if (job.completedChunks === job.totalChunks) {
          if (!segments.length)
            throw new MetaError('No speech was detected in this recording', false);
          await this.saveCaptions(
            job.sourceId,
            'original',
            segments.filter((s) => !s.id.startsWith('frame-')),
          );
          job = { ...job, stage: 'translate' };
        }
      } else if (job.stage === 'translate') {
        const segments = (await this.ctx.storage.get<Segment[]>('segments'))!.filter(
            (s) => !s.id.startsWith('frame-'),
          ),
          translated: Segment[] = [];
        // Bound translation calls and persist each batch independently.
        for (let i = 0; i < segments.length; i += 80) {
          const cacheKey = `translation:${i}`;
          let batch = await this.ctx.storage.get<Segment[]>(cacheKey);
          if (!batch) {
            batch = await translate(
              key,
              settings.model,
              segments.slice(i, i + 80),
              job.locale,
              bridgedFetch(this.env),
            );
            await this.ctx.storage.put(cacheKey, batch);
          }
          translated.push(...batch);
        }
        await this.saveCaptions(job.sourceId, 'translated', translated);
        job = { ...job, stage: 'synthesize', status: 'partial' };
      } else if (job.stage === 'synthesize') {
        const segments = (await this.ctx.storage.get<Segment[]>('segments'))!,
          normalized = (await this.ctx.storage.get<Normalized>('normalized'))!;
        const synthesis = await synthesize(
          key,
          settings.model,
          segments,
          job.locale,
          normalized.imageData,
          normalized.visuals,
          bridgedFetch(this.env),
        );
        const learning: Learning = {
          sourceId: file.id,
          sourceVersion: file.version,
          model: settings.model,
          locale: job.locale,
          segments,
          synthesis,
          createdAt: new Date().toISOString(),
        };
        // Publish under a stable source version; repeated publication replaces the same record.
        if ((await this.ctx.storage.get<Job>('job'))?.status === 'cancelled') return;
        await internal(this.env, `/internal/learning/${file.id}`, learning);
        job = { ...job, stage: 'done', status: 'completed' };
      }
      const current = await this.ctx.storage.get<Job>('job');
      if (current?.status === 'cancelled') return;
      await this.ctx.storage.put('job', { ...job, attempts: 0 });
      if (job.status === 'completed') await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(Date.now() + 100);
    } catch (error) {
      const current = await this.ctx.storage.get<Job>('job');
      if (current?.status === 'cancelled') return;
      console.error(
        JSON.stringify({
          event: 'processing_step_failed',
          stage: initial.stage,
          type: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : 'unknown',
        }),
      );
      const attempts = initial.attempts + 1,
        retryable = error instanceof MetaError ? error.retryable : false;
      const message =
        error instanceof MetaError
          ? error.message
          : error instanceof Error
            ? `${error.name}: ${error.message.slice(0, 300)}`
            : 'Processing failed validation. Saved steps remain available.';
      await this.ctx.storage.put('job', {
        ...(current || initial),
        attempts,
        status: retryable && attempts < 4 ? 'queued' : 'failed',
        error: message,
      });
      if (retryable && attempts < 4)
        await this.ctx.storage.setAlarm(Date.now() + Math.min(60000, 2000 * 2 ** attempts));
      else await this.ctx.storage.deleteAlarm();
    }
  }
  async saveCaptions(sourceId: string, track: string, segments: Segment[]) {
    await this.env.FILES.put(`captions/${sourceId}/${track}.vtt`, captions(segments));
    await this.env.FILES.put(`captions/${sourceId}/${track}.srt`, captions(segments, true));
  }
}
