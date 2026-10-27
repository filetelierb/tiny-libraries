import type { ChatMessage } from '../shared/conversations';
import { tutorFingerprint, type TurnIntent, type TurnRecord } from '../shared/tutor-turns';
import {
  tutorCompletionSchema,
  type TransportSnapshot,
  type TutorCompletion,
} from '../shared/tutor-transport';
import {
  createTutorAgent,
  type TutorAgentInput,
  type TutorAgentCheckpoint,
  type BookmarkWriter,
} from './tutor-agent';
import { TutorJournal } from './tutor-journal';

export type FrozenTutorContext = Omit<TutorAgentInput, 'prompt' | 'history'>;
export type TutorRunnerServices = {
  get(id: string): Promise<TransportSnapshot | null>;
  start(id: string, body: TutorCompletion): Promise<TransportSnapshot>;
  cancel(id: string): Promise<TransportSnapshot>;
  bookmark(
    record: TurnRecord,
    intent: TurnIntent,
    input: Parameters<BookmarkWriter>[0],
  ): Promise<unknown>;
};
class ControlCheckpoint extends Error {}

/** One short durable transition per alarm; the sidecar owns the open model connection. */
export class TutorRunner {
  constructor(
    private readonly journal: TutorJournal,
    private readonly services: TutorRunnerServices,
  ) {}
  private async message(record: TurnRecord, content: string): Promise<ChatMessage> {
    const intent = await this.journal.intent(record);
    return {
      role: 'assistant',
      content,
      requestId: record.id,
      generation: record.generation,
      sourceIds: intent.userMessage.sourceIds,
      tools: record.toolNames,
    };
  }
  private async terminate(
    record: TurnRecord,
    status: 'stopped' | 'failed' | 'interrupted',
    error?: string,
  ) {
    return this.journal.finish(
      record,
      status,
      record.partial ? await this.message(record, record.partial) : undefined,
      error,
    );
  }
  async step() {
    const claimed = (await this.journal.active()) || (await this.journal.claim());
    if (!claimed) return;
    let record: TurnRecord = claimed;
    try {
      if (record.retiredProviders?.length) {
        for (const id of record.retiredProviders) await this.services.cancel(id);
        await this.journal.progress(record, { retiredProviders: [] });
        return;
      }
      if (record.stopRequested) {
        if (record.providerId) {
          const saved = await this.services.cancel(record.providerId);
          record =
            (await this.journal.progress(record, {
              partial: saved.text,
              providerSequence: saved.sequence,
            })) || record;
        }
        await this.terminate(record, 'stopped');
        return;
      }
      if (record.deadline && record.deadline <= Date.now()) {
        if (record.providerId) await this.services.cancel(record.providerId);
        await this.terminate(
          record,
          'interrupted',
          'This reply reached its time limit. Saved progress is retained; retry explicitly.',
        );
        return;
      }
      const intent = await this.journal.intent(record);
      if (!record.initialObject || !record.checkpointObject) {
        const context = await this.journal.objects.get<FrozenTutorContext>(intent.contextObject);
        const history = (await this.journal.history()).messages
          .filter((message) => message.messageId !== `${record.id}:a${record.attempt}:user`)
          .slice(-16);
        const input: TutorAgentInput = {
          ...context,
          model: record.generation.model,
          reasoningEffort: record.generation.reasoningEffort,
          prompt: intent.input.prompt,
          history: history.map((message) =>
            message.status
              ? {
                  ...message,
                  content:
                    `[Partial ${message.status} reply; not a completed answer]\n${message.content}`.slice(
                      0,
                      16000,
                    ),
                }
              : message,
          ),
        };
        const agent = await createTutorAgent(input);
        const initialObject = await this.journal.objects.put(input);
        const checkpointObject = await this.journal.objects.put(agent.snapshot());
        await this.journal.progress(record, { initialObject, checkpointObject, phase: 'tools' });
        return;
      }
      const input = await this.journal.objects.get<TutorAgentInput>(record.initialObject);
      const checkpoint = await this.journal.objects.get<TutorAgentCheckpoint>(
        record.checkpointObject,
      );
      const agent = await createTutorAgent(input, checkpoint);
      const appliedSteers = agent.snapshot().steers.length;
      if (record.appliedSteers !== appliedSteers) {
        await this.journal.progress(record, { appliedSteers });
        return;
      }
      if (record.steering.length) {
        if (agent.modelCalls >= 20 || appliedSteers >= 20) {
          await this.journal.releaseSteering(record);
          return;
        }
        if (record.providerId) await this.services.cancel(record.providerId);
        const childId = record.steering[0],
          child = await this.journal.get(childId);
        if (!child) throw new Error('Saved steering question is unavailable');
        const childIntent = await this.journal.intent(child);
        agent.steer(childId, childIntent.input.prompt);
        const checkpointObject = await this.journal.objects.put(agent.snapshot());
        await this.journal.appliedSteering(record, childId, checkpointObject);
        return;
      }
      if (agent.result) {
        const result = agent.result;
        await this.journal.finish(record, 'completed', {
          ...(await this.message(record, result.text)),
          tools: result.tools,
          citations: result.citations,
        });
        return;
      }
      if (record.phase === 'model' && record.providerId) {
        let snapshot = await this.services.get(record.providerId);
        if (!snapshot) {
          if (record.providerStart !== 'unsubmitted') {
            await this.terminate(
              record,
              'interrupted',
              'The saved provider request is unavailable. Retry explicitly; the question and completed tools are retained.',
            );
            return;
          }
          // A crash after this commit leaves an uncertain start, never a silent duplicate.
          const next = await this.journal.progress(record, { providerStart: 'submitting' });
          if (!next) return;
          record = next;
          if (record.stopRequested || record.steering.length) return;
          snapshot = await this.services.start(
            record.providerId!,
            tutorCompletionSchema.parse(agent.request()),
          );
        }
        if (
          snapshot.sequence === record.providerSequence &&
          record.providerStart === 'accepted' &&
          ['accepted', 'running'].includes(snapshot.status)
        )
          return;
        const next = await this.journal.progress(record, {
          providerStart: 'accepted',
          providerSequence: snapshot.sequence,
          partial: snapshot.text,
          toolNames: [...agent.snapshot().used, ...snapshot.toolNames],
        });
        if (!next) return;
        record = next;
        if (snapshot.status === 'completed' && snapshot.result) {
          agent.acceptCompletion(snapshot.result);
          const checkpointObject = await this.journal.objects.put(agent.snapshot());
          await this.journal.progress(record, {
            checkpointObject,
            phase: 'tools',
            modelCalls: agent.modelCalls,
            providerId: undefined,
            providerSequence: undefined,
            providerStart: undefined,
          });
        } else if (['failed', 'interrupted', 'cancelled'].includes(snapshot.status)) {
          await this.terminate(
            record,
            record.stopRequested
              ? 'stopped'
              : snapshot.status === 'failed'
                ? 'failed'
                : 'interrupted',
            snapshot.error,
          );
        }
        return;
      }
      if (agent.hasPendingTools) {
        const control = await this.journal.active();
        if (
          !control ||
          control.id !== record.id ||
          control.workVersion !== record.workVersion ||
          control.stopRequested ||
          control.steering.length
        )
          return;
        await agent.executeNextTool(async (value) => {
          const current = await this.journal.active();
          if (
            !current ||
            current.id !== record!.id ||
            current.stopRequested ||
            current.steering.length
          )
            throw new ControlCheckpoint();
          return this.services.bookmark(record!, intent, value);
        });
        const checkpointObject = await this.journal.objects.put(agent.snapshot());
        await this.journal.progress(record, { checkpointObject, toolNames: agent.snapshot().used });
        return;
      }
      const providerId = await tutorFingerprint({
        conversation: record.conversationId,
        turn: record.id,
        revision: record.intentRevision,
        attempt: record.attempt,
        modelCalls: agent.modelCalls,
        checkpoint: record.checkpointObject,
      });
      await this.journal.progress(record, {
        phase: 'model',
        providerId,
        providerStart: 'unsubmitted',
        providerSequence: undefined,
        partial: '',
      });
    } catch (error) {
      if (error instanceof ControlCheckpoint) return;
      // Resume from the latest committed checkpoint, including any controls admitted during I/O.
      const current = await this.journal.active();
      if (current?.id !== record.id) return;
      if (current.stopRequested || current.steering.length) return;
      // An ambiguous POST or a temporarily unreachable sidecar is reconciled by its stable ID.
      if (current.providerId && current.providerStart !== 'unsubmitted') return;
      await this.terminate(
        current,
        'interrupted',
        (error instanceof Error
          ? error.message
          : 'Reply interrupted. Saved progress is retained.'
        ).slice(0, 500),
      );
    }
  }
}
