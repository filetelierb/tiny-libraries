import { z } from 'zod';
import { completionMessageSchema, type CompletionMessage } from '../shared/tutor-transport';

const deltaSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.number().optional(),
        delta: z
          .object({
            content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().min(0).max(7),
                  id: z.string().max(200).optional(),
                  type: z.literal('function').optional(),
                  function: z
                    .object({
                      name: z.string().max(160).optional(),
                      arguments: z.string().max(65536).optional(),
                    })
                    .optional(),
                }),
              )
              .max(8)
              .optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .max(1),
});

/** Parses only visible text and function calls. Private reasoning is never retained. */
export class TutorStream {
  private buffer = '';
  private calls = new Map<number, { id: string; name: string; arguments: string }>();
  private finishReason: string | null = null;
  done = false;
  text = '';
  get toolNames() {
    return [...this.calls.values()].map((call) => call.name);
  }
  push(value: string) {
    if (this.done) return;
    this.buffer += value;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match) break;
      if (match.index > 1024 * 1024) throw new Error('Model stream frame exceeds 1 MB');
      const event = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.event(event);
      if (this.done) {
        this.buffer = '';
        break;
      }
    }
    if (this.buffer.length > 1024 * 1024) throw new Error('Model stream frame exceeds 1 MB');
  }
  finish(): CompletionMessage {
    if (this.buffer.trim()) this.event(this.buffer);
    if (!['stop', 'tool_calls'].includes(this.finishReason || ''))
      throw new Error(
        this.finishReason === 'length'
          ? 'The model reached its output limit before finishing. Partial text is retained.'
          : 'The model stream ended before a complete reply. Partial text is retained.',
      );
    const calls = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      }));
    if (this.finishReason === 'tool_calls' && !calls.length)
      throw new Error('The model finished with missing tool calls');
    if (calls.length && this.finishReason !== 'tool_calls')
      throw new Error('The model returned an incomplete tool-call response');
    return completionMessageSchema.parse({
      content: this.text || null,
      ...(calls.length ? { tool_calls: calls } : {}),
    });
  }
  private event(event: string) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    if (data.trim() === '[DONE]') {
      this.done = true;
      return;
    }
    const raw = JSON.parse(data);
    if (raw?.error) throw new Error('The model reported an error in its stream');
    const part = deltaSchema.parse(raw).choices[0];
    if (!part) return;
    if (part.index != null && part.index !== 0) throw new Error('Unexpected model choice');
    if (part.delta?.content) {
      this.text += part.delta.content;
      if (this.text.length > 16000) {
        this.text = this.text.slice(0, 16000);
        throw new Error('Reply exceeds the text limit. Partial text is retained.');
      }
    }
    for (const delta of part.delta?.tool_calls || []) {
      const call = this.calls.get(delta.index) || { id: '', name: '', arguments: '' };
      if (delta.id) {
        if (call.id && call.id !== delta.id) throw new Error('A tool-call identity changed');
        call.id = delta.id;
      }
      call.name += delta.function?.name || '';
      call.arguments += delta.function?.arguments || '';
      if (call.name.length > 160 || call.arguments.length > 65536)
        throw new Error('Model tool call exceeds its size limit');
      this.calls.set(delta.index, call);
    }
    if (part.finish_reason) {
      if (this.finishReason && this.finishReason !== part.finish_reason)
        throw new Error('Model completion state changed');
      this.finishReason = part.finish_reason;
    }
  }
}
