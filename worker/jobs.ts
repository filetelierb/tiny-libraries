import { DurableObject } from 'cloudflare:workers';
import { visualKey, widgetImages } from '../shared/artifact-widgets';
import { synthesisWindows } from '../shared/synthesis-windows';
import { ownedTurns } from '../shared/transcript';
import {
  captions,
  validateSynthesis,
  type Job,
  type Synthesis,
  type Source,
  type Segment,
  type Locale,
  type Learning,
  type NormalizedSource,
} from '../shared/domain';
import { internal } from './index';
import { recordEvent } from './agent-events';
import type { ProjectId } from '../shared/projects';
import {
  GLOSSARY_ROUNDS,
  applyFill,
  applyReview,
  conceptMatches,
  fillSegments,
  initialGlossary,
  planConcepts,
  type ConceptContext,
  type ConceptIndexItem,
  type ConceptPlan,
  type GlossaryState,
} from '../shared/glossary-pipeline';
import {
  MetaError,
  bridgedFetch,
  decideConcepts,
  fillGlossary,
  matchConcepts,
  outlineParts,
  reviewGlossary,
  synthesize,
  synthesizePart,
  transcribe,
  translate,
  type MetaUsage,
  type MetaUsageSink,
} from './meta';

/** Totals the resources every Meta call it feeds consumed, for one event. */
function usageTracker() {
  const total: MetaUsage = {};
  const sink: MetaUsageSink = (u) => {
    if (u.input !== undefined) total.input = (total.input || 0) + u.input;
    if (u.output !== undefined) total.output = (total.output || 0) + u.output;
    if (u.audioSeconds !== undefined)
      total.audioSeconds = (total.audioSeconds || 0) + u.audioSeconds;
  };
  return {
    sink,
    get usage() {
      return Object.keys(total).length ? total : undefined;
    },
  };
}

export type Normalized = NormalizedSource;
export class ProcessingJob extends DurableObject<Env> {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    // A deleted project's jobs are removed with it.
    if (path === '/purge' && request.method === 'POST') {
      await this.releaseTurn();
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return Response.json({ ok: true });
    }
    let job = await this.ctx.storage.get<Job>('job');
    if (path === '/resume' && request.method === 'POST') {
      // A page refresh pokes stalled jobs: if the DO is holding a non-terminal job that stopped
      // alarming (crash, eviction, missing alarm after a deploy), re-queue it so its next tick
      // can claim a turn and keep going. Terminal jobs are left alone.
      if (!job || job.status === 'completed' || job.status === 'cancelled')
        return Response.json(job || null);
      const next: Job =
        job.status === 'failed'
          ? { ...job, status: 'queued', error: undefined, attempts: 0 }
          : { ...job, status: 'queued' };
      await this.ctx.storage.put('job', next);
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return Response.json(next);
    }
    if (path === '/start' && request.method === 'POST') {
      if (job) return Response.json(job);
      const { id, file, locale, project } = await request.json<{
        id: string;
        file: Source;
        locale: Locale;
        project?: ProjectId;
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
      await this.ctx.storage.put({ job, file, project: project || 'default' });
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return Response.json(job, { status: 201 });
    }
    if (!job) return Response.json(null);
    if (request.method === 'DELETE') {
      job = { ...job, status: 'cancelled', position: undefined };
      await this.ctx.storage.put('job', job);
      await this.ctx.storage.deleteAlarm();
      await this.releaseTurn();
    }
    if (request.method === 'POST' && (job.status === 'failed' || job.status === 'cancelled')) {
      job = { ...job, status: 'queued', error: undefined, attempts: 0 };
      await this.ctx.storage.put('job', job);
      await this.ctx.storage.setAlarm(Date.now() + 100);
    }
    if (new URL(request.url).searchParams.has('summary'))
      return Response.json(job, { headers: { 'Cache-Control': 'no-store' } });
    const segments = await this.ctx.storage.get<Segment[]>('segments');
    return Response.json(
      { ...job, segments: segments || [] },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }
  /** A turn to prepare, asked for before each step; without one the job waits in line. */
  private turn(id: string) {
    return internal<{ granted: boolean; position?: number }>(this.env, '/internal/turns/claim', {
      id,
    });
  }
  private async releaseTurn() {
    const job = await this.ctx.storage.get<Job>('job');
    if (job)
      await internal(this.env, '/internal/turns/release', { id: job.id }).catch(() => undefined);
  }
  /** The library of the project the file belongs to. */
  private async library<T>(path: string, body?: unknown) {
    const project = (await this.ctx.storage.get<ProjectId>('project')) || 'default';
    return internal<T>(this.env, path, body, project);
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
  /** Publishes the study record; true when the job was cancelled first. */
  async publish(
    file: Source,
    job: Job,
    model: string,
    segments: Segment[],
    synthesis: Synthesis,
    concepts?: ConceptPlan[],
  ) {
    const normalized = (await this.ctx.storage.get<Normalized>('normalized'))!;
    // Image widgets show source pictures, which the study record itself does not keep.
    const pictures = [
      ...(normalized.imageData ? [{ segmentId: 'image-1', data: normalized.imageData }] : []),
      ...(normalized.visuals || []),
    ];
    for (const segmentId of widgetImages(synthesis.artifact?.explanation || '')) {
      const match = pictures
        .find((picture) => picture.segmentId === segmentId)
        ?.data.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
      if (match)
        await this.env.FILES.put(
          visualKey(file.id, file.version, segmentId),
          Uint8Array.from(atob(match[2]), (char) => char.charCodeAt(0)),
          { httpMetadata: { contentType: match[1] } },
        );
    }
    const learning: Learning = {
      sourceId: file.id,
      sourceVersion: file.version,
      model,
      locale: job.locale,
      segments,
      synthesis,
      ...(concepts ? { concepts } : {}),
      createdAt: new Date().toISOString(),
    };
    // Publish under a stable source version; repeated publication replaces the same record.
    if ((await this.ctx.storage.get<Job>('job'))?.status === 'cancelled') return true;
    await this.library(`/internal/learning/${file.id}`, learning);
    return false;
  }
  /**
   * One checkpointed step of the glossary loop. Returns the next state, or null once the
   * terms are final and planned (the plan is saved with them).
   */
  async glossaryStep(
    key: string,
    model: string,
    locale: Locale,
    synthesis: Synthesis,
    segments: Segment[],
    state: GlossaryState,
    onUsage?: MetaUsageSink,
  ): Promise<GlossaryState | null> {
    const transport = bridgedFetch(this.env);
    if (!state.terms.length) return null;
    if (state.phase === 'review') {
      const review = await reviewGlossary(
        key,
        model,
        state.terms,
        synthesis,
        state.round,
        locale,
        transport,
        onUsage,
      );
      const terms = applyReview(state.terms, review);
      // A review that keeps nothing is ignored rather than emptying the glossary.
      const kept = terms.length ? terms : state.terms,
        missing = review.missing.filter((m) => synthesis.chapters[m.chapter]);
      return missing.length && state.round + 1 < GLOSSARY_ROUNDS
        ? { ...state, terms: kept, phase: 'fill', missing }
        : { ...state, terms: kept, phase: 'match', missing: undefined };
    }
    if (state.phase === 'fill') {
      const available = fillSegments(segments, synthesis, state.missing || []);
      const { terms, added } = available.length
        ? applyFill(
            state.terms,
            await fillGlossary(
              key,
              model,
              state.missing || [],
              available,
              locale,
              transport,
              onUsage,
            ),
            available,
          )
        : { terms: state.terms, added: 0 };
      // Nothing new to review ends the loop early.
      return added
        ? { round: state.round + 1, terms, phase: 'review' }
        : { ...state, terms, phase: 'match', missing: undefined };
    }
    const names = state.terms.map((term) => [term.term, ...term.aliases]);
    const { index, byName } = await this.library<{
      index: ConceptIndexItem[];
      byName: Array<string | null>;
    }>('/internal/glossary-terms', { names });
    if (state.phase === 'match') {
      const unnamed = state.terms
        .map((term, i) => ({
          term: i,
          name: term.term,
          aliases: term.aliases,
          definition: term.definition.slice(0, 400),
        }))
        .filter((term) => !byName[term.term]);
      const picked =
        unnamed.length && index.length
          ? await matchConcepts(key, model, unnamed, index, transport, onUsage)
          : { matches: [] };
      return {
        ...state,
        phase: 'decide',
        matches: conceptMatches(state.terms, byName, picked, index),
      };
    }
    const matches = state.matches || state.terms.map(() => null),
      ids = [...new Set(matches.filter((id) => id !== null))];
    const { concepts } = ids.length
      ? await this.library<{ concepts: ConceptContext[] }>('/internal/glossary-context', {
          ids,
        })
      : { concepts: [] };
    const matched = state.terms
      .map((term, i) => ({
        term: i,
        name: term.term,
        definition: term.definition,
        conceptId: matches[i]!,
      }))
      .filter((term) => term.conceptId && concepts.some((c) => c.id === term.conceptId));
    const decided = matched.length
      ? await decideConcepts(key, model, matched, concepts, locale, transport, onUsage)
      : { decisions: [] };
    await this.ctx.storage.put('glossary', {
      ...state,
      plan: planConcepts(state.terms, matches, byName, concepts, decided),
    });
    return null;
  }
  async alarm() {
    let job = await this.ctx.storage.get<Job>('job');
    if (!job || job.status === 'cancelled' || job.status === 'completed') return;
    const turn = await this.turn(job.id).catch(() => null);
    if (!turn?.granted) {
      // Waiting jobs ask again a little apart, so they do not all ask at the same moment.
      await this.ctx.storage.put('job', { ...job, status: 'queued', position: turn?.position });
      await this.ctx.storage.setAlarm(Date.now() + 6000 + Math.random() * 4000);
      return;
    }
    job = { ...job, position: undefined };
    const initial = job;
    const stageStartedAt = Date.now();
    try {
      // Schedule a recovery wake before external work; completed checkpoints are never repeated.
      await this.ctx.storage.setAlarm(Date.now() + 240000);
      job = { ...job, status: 'running', error: undefined };
      await this.ctx.storage.put('job', job);
      const file = (await this.ctx.storage.get<Source>('file'))!;
      const project = (await this.ctx.storage.get<ProjectId>('project')) || 'default';
      const push = (
        action: string,
        summary: string,
        extra: {
          detail?: string;
          progress?: { current: number; total: number };
          elapsedMs?: number;
          model?: string;
          reasoningEffort?: string;
          usage?: { input?: number; output?: number; audioSeconds?: number };
          tool?: 'preparation' | 'glossary';
        } = {},
      ) => {
        const { tool, ...rest } = extra;
        // The preparation pipeline uses Meta's default reasoning effort for every chat call.
        const defaults =
          rest.model && !action.startsWith('transcribe') && !action.startsWith('normalize')
            ? { reasoningEffort: 'auto', ...rest }
            : rest;
        return recordEvent(this.env, project, {
          tool: tool || 'preparation',
          action,
          fileId: file.id,
          fileName: file.name,
          summary,
          ...defaults,
        });
      };
      const { key } = await this.library<{ key: string | null }>('/internal/key');
      if (!key) throw new MetaError('Add a Meta API key in Settings, then retry.', false);
      const settings = await this.library<{ model: string }>('/api/settings');
      if (job.stage === 'normalize') {
        await push('normalize.start', `Reading ${file.name}`);
        // Let Node stream the immutable original from the loopback API, so the Worker never
        // pipes a stored body into an outbound request.
        const response = await this.bridge(`/normalize/${job.id}?kind=${file.kind}`, {
          method: 'POST',
          body: JSON.stringify({
            sourceId: file.id,
            sourceVersion: file.version,
            mime: file.mime,
            project: (await this.ctx.storage.get<ProjectId>('project')) || 'default',
          }),
          headers: { 'Content-Type': 'application/json' },
        });
        const normalized = await response.json<Normalized>();
        await this.ctx.storage.put({ normalized, segments: normalized.segments });
        job = {
          ...job,
          totalChunks: normalized.chunks.length,
          stage: normalized.chunks.length ? 'transcribe' : 'synthesize',
        };
        await push(
          'normalize.done',
          normalized.chunks.length
            ? `Segmented ${file.name} into ${normalized.chunks.length} audio chunks`
            : `Read ${file.name}; no audio to transcribe`,
          { elapsedMs: Date.now() - stageStartedAt },
        );
      } else if (job.stage === 'transcribe') {
        const normalized = (await this.ctx.storage.get<Normalized>('normalized'))!;
        // Chunks are at most 300s + 2 × 20s = ~5m 40s and under 31 MB, inside Meta's
        // one-shot limits (10 min, 32 MB), so several can be transcribed in parallel.
        const PARALLEL = 5;
        const jobId = job.id;
        const start = job.completedChunks,
          batch = normalized.chunks.slice(start, start + PARALLEL);
        const transcribeTracker = usageTracker();
        await Promise.all(
          batch.map(async (chunk) => {
            const cacheKey = `chunk:${chunk.index}`;
            if (await this.ctx.storage.get<Segment[]>(cacheKey)) return;
            const audio = await (
              await this.bridge(`/chunks/${jobId}/${chunk.index}`)
            ).arrayBuffer();
            let result = await transcribe(
              key,
              audio,
              chunk.index,
              chunk.offset,
              chunk.duration,
              bridgedFetch(this.env),
              transcribeTracker.sink,
            );
            result = ownedTurns(result, chunk, chunk.index === normalized.chunks.length - 1);
            await this.ctx.storage.put(cacheKey, result);
          }),
        );
        const segments: Segment[] = [...normalized.segments];
        for (let i = 0; i < start + batch.length; i++)
          segments.push(...((await this.ctx.storage.get<Segment[]>(`chunk:${i}`)) || []));
        await this.ctx.storage.put('segments', segments);
        job = { ...job, completedChunks: start + batch.length, status: 'partial' };
        await push(
          'transcribe.chunk',
          `Transcribed audio chunks ${job.completedChunks} of ${job.totalChunks}`,
          {
            progress: { current: job.completedChunks, total: job.totalChunks },
            elapsedMs: Date.now() - stageStartedAt,
            model: 'muse-voice-transcribe-1.0',
            usage: transcribeTracker.usage || {
              audioSeconds: batch.reduce((sum, c) => sum + c.duration, 0),
            },
          },
        );
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
        const translateTracker = usageTracker();
        // Bound translation calls and persist each batch independently.
        for (let i = 0; i < segments.length; i += 80) {
          const cacheKey = `translation:${i}`;
          let batch = await this.ctx.storage.get<Segment[]>(cacheKey);
          if (!batch) {
            batch = await this.translateBatch(
              key,
              settings.model,
              segments.slice(i, i + 80),
              job.locale,
              translateTracker.sink,
            );
            await this.ctx.storage.put(cacheKey, batch);
          }
          translated.push(...batch);
        }
        await this.saveCaptions(job.sourceId, 'translated', translated);
        await push(
          'translate.done',
          `Translated subtitles into ${job.locale.toUpperCase()} for ${file.name}`,
          {
            elapsedMs: Date.now() - stageStartedAt,
            model: settings.model,
            usage: translateTracker.usage,
          },
        );
        job = { ...job, stage: 'synthesize', status: 'partial' };
      } else if (job.stage === 'synthesize') {
        const segments = (await this.ctx.storage.get<Segment[]>('segments'))!,
          normalized = (await this.ctx.storage.get<Normalized>('normalized'))!;
        const windows = synthesisWindows(segments),
          done = job.completedParts || 0;
        let synthesis: Synthesis | undefined;
        const synthesizeTracker = usageTracker();
        if (windows.length === 1)
          synthesis = await synthesize(
            key,
            settings.model,
            segments,
            job.locale,
            normalized.imageData,
            normalized.visuals,
            bridgedFetch(this.env),
            synthesizeTracker.sink,
          );
        else if (JSON.stringify(segments).length > 1500000)
          throw new MetaError('Source text exceeds the analysis limit', false);
        else if (done < windows.length) {
          // Long sources are analysed one overlapping window per step; each part is kept.
          if (!(await this.ctx.storage.get<Synthesis>(`part:${done}`)))
            await this.ctx.storage.put(
              `part:${done}`,
              await synthesizePart(
                key,
                settings.model,
                segments,
                windows[done],
                done,
                windows.length,
                job.locale,
                normalized.visuals,
                bridgedFetch(this.env),
                synthesizeTracker.sink,
              ),
            );
          job = {
            ...job,
            completedParts: done + 1,
            totalParts: windows.length + 1,
            status: 'partial',
          };
          await push(
            'synthesize.part',
            `Built chapters for window ${done + 1} of ${windows.length} of ${file.name}`,
            {
              progress: { current: done + 1, total: windows.length + 1 },
              model: settings.model,
              usage: synthesizeTracker.usage,
            },
          );
        } else {
          const parts = await Promise.all(
            windows.map(async (_, i) => (await this.ctx.storage.get<Synthesis>(`part:${i}`))!),
          );
          synthesis = validateSynthesis(
            await outlineParts(
              key,
              settings.model,
              parts,
              job.locale,
              bridgedFetch(this.env),
              synthesizeTracker.sink,
            ),
            segments,
            new Set((normalized.visuals || []).map((v) => v.segmentId)),
          );
        }
        if (synthesis) {
          await this.ctx.storage.put('synthesis', synthesis);
          await this.ctx.storage.put<GlossaryState>('glossary', {
            round: 0,
            phase: 'review',
            terms: initialGlossary(synthesis),
          });
          await push(
            'synthesize.done',
            `Study guide ready: ${synthesis.chapters.length} chapters, ${synthesis.chapters.reduce(
              (sum, c) => sum + c.questions.length,
              0,
            )} questions, ${synthesis.glossary.length} glossary terms`,
            {
              elapsedMs: Date.now() - stageStartedAt,
              model: settings.model,
              usage: synthesizeTracker.usage,
            },
          );
          job = { ...job, stage: 'concepts', status: 'partial', completedParts: 0, totalParts: 0 };
        }
      } else if (job.stage === 'concepts') {
        const synthesis = (await this.ctx.storage.get<Synthesis>('synthesis'))!,
          segments = (await this.ctx.storage.get<Segment[]>('segments'))!,
          state = (await this.ctx.storage.get<GlossaryState>('glossary'))!;
        let next: GlossaryState | null;
        const glossaryTracker = usageTracker();
        try {
          next = await this.glossaryStep(
            key,
            settings.model,
            job.locale,
            synthesis,
            segments,
            state,
            glossaryTracker.sink,
          );
        } catch (error) {
          // The study guide never waits on the glossary: a failed review publishes the terms as they are.
          if (!(error instanceof MetaError) || error.retryable) throw error;
          console.error(
            JSON.stringify({ event: 'glossary_review_failed', message: error.message }),
          );
          next = null;
        }
        if (next) {
          await this.ctx.storage.put('glossary', next);
          await push(
            'glossary.round',
            `Reviewed the glossary (round ${next.round}, ${next.terms.length} terms)`,
            {
              progress: { current: next.round, total: 3 },
              model: settings.model,
              tool: 'glossary',
              usage: glossaryTracker.usage,
            },
          );
          job = { ...job, status: 'partial', completedParts: next.round };
        } else {
          const finished = await this.ctx.storage.get<GlossaryState & { plan?: ConceptPlan[] }>(
            'glossary',
          );
          // Terms reviewed before a failure are kept; without a plan they join concepts by name.
          const reviewed = finished?.terms.length
            ? {
                ...synthesis,
                glossary: finished.terms.map(({ term, definition, segmentIds }) => ({
                  term,
                  definition,
                  segmentIds,
                })),
              }
            : synthesis;
          if (await this.publish(file, job, settings.model, segments, reviewed, finished?.plan))
            return;
          // The home library's publishLearning writes `preparation.done` after flashcards start.
          job = { ...job, stage: 'done', status: 'completed' };
        }
      }
      const current = await this.ctx.storage.get<Job>('job');
      if (current?.status === 'cancelled') return;
      await this.ctx.storage.put('job', { ...job, attempts: 0 });
      if (job.status === 'completed') {
        await this.ctx.storage.deleteAlarm();
        await this.releaseTurn();
      } else await this.ctx.storage.setAlarm(Date.now() + 100);
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
      else {
        await this.ctx.storage.deleteAlarm();
        await this.releaseTurn();
      }
    }
  }
  // A batch whose cue identities come back changed is retried in halves; a cue that still
  // fails keeps its original text, so translation never blocks the study guide.
  async translateBatch(
    key: string,
    model: string,
    batch: Segment[],
    locale: Locale,
    onUsage?: MetaUsageSink,
  ): Promise<Segment[]> {
    try {
      return await translate(key, model, batch, locale, bridgedFetch(this.env), onUsage);
    } catch (error) {
      if (!(error instanceof MetaError) || error.retryable) throw error;
      if (batch.length === 1) return batch;
      const half = Math.ceil(batch.length / 2);
      return [
        ...(await this.translateBatch(key, model, batch.slice(0, half), locale, onUsage)),
        ...(await this.translateBatch(key, model, batch.slice(half), locale, onUsage)),
      ];
    }
  }
  async saveCaptions(sourceId: string, track: string, segments: Segment[]) {
    await this.env.FILES.put(`captions/${sourceId}/${track}.vtt`, captions(segments));
    await this.env.FILES.put(`captions/${sourceId}/${track}.srt`, captions(segments, true));
  }
}
