import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  completionCallSchema,
  completionMessageSchema,
  type CompletionMessage,
  type TutorCompletion,
} from '../shared/tutor-transport';
import { webCitationSchema, type WebCitation } from '../shared/tutor-web';

const messageSchema = z.object({
  role: z.enum(['system', 'developer', 'user', 'assistant', 'tool']),
  content: z
    .union([
      z.string(),
      z.array(
        z.union([
          z.object({ type: z.literal('text'), text: z.string() }),
          z.object({ type: z.literal('image_url'), image_url: z.object({ url: z.string() }) }),
        ]),
      ),
    ])
    .nullable()
    .optional(),
  tool_call_id: z.string().optional(),
  tool_calls: z.array(completionCallSchema).max(8).optional(),
});
export function webResponsesRequest(body: TutorCompletion) {
  if (!body.webSearch) throw new Error('Web permission is required');
  const input: unknown[] = [];
  for (const raw of body.messages) {
    const message = messageSchema.parse(raw);
    if (message.role === 'tool') {
      if (!message.tool_call_id || typeof message.content !== 'string')
        throw new Error('Invalid tool result');
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id,
        output: message.content,
      });
      continue;
    }
    if (message.content != null && message.content !== '') {
      const content =
        typeof message.content === 'string'
          ? [
              {
                type: message.role === 'assistant' ? 'output_text' : 'input_text',
                text: message.content,
              },
            ]
          : message.content.map((part) =>
              part.type === 'text'
                ? { type: 'input_text', text: part.text }
                : { type: 'input_image', image_url: part.image_url.url },
            );
      input.push({ role: message.role, content });
    }
    for (const call of message.tool_calls || [])
      input.push({
        type: 'function_call',
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
  }
  const tools = (body.tools || []).map((raw) => {
    const tool = z
      .object({
        type: z.literal('function'),
        function: z.object({
          name: z.string(),
          description: z.string(),
          parameters: z.record(z.string(), z.unknown()),
        }),
      })
      .parse(raw);
    if (['browser.search', 'browser.open', 'browser.find'].includes(tool.function.name))
      throw new Error('Reserved hosted search tool name');
    return { type: 'function', ...tool.function };
  });
  return {
    model: body.model,
    input,
    tools: [...tools, { type: 'web_search', search_context_size: 'medium' }],
    store: false,
    stream: true,
    ...(body.reasoning_effort ? { reasoning: { effort: body.reasoning_effort } } : {}),
  };
}

const annotationSchema = z.object({
  type: z.literal('url_citation'),
  url: z.string(),
  title: z.string().optional(),
  start_index: z.number().int().nonnegative(),
  end_index: z.number().int().nonnegative(),
});
const responseSchema = z.object({
  status: z.literal('completed'),
  output: z.array(z.unknown()).max(200),
});
const itemSchema = z.object({ type: z.string() }).passthrough();

/** Retain visible text, public provenance and function calls; discard all reasoning events. */
export class TutorResponsesStream {
  private buffer = '';
  private result?: CompletionMessage;
  private names = new Set<string>();
  done = false;
  text = '';
  get toolNames() {
    return [...this.names].slice(0, 8);
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
    if (!this.result)
      throw new Error('The model stream ended before a complete reply. Partial text is retained.');
    return this.result;
  }
  private event(event: string) {
    const data = event
      .split(/\r?\n/)
      .filter((x) => x.startsWith('data:'))
      .map((x) => x.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const raw = z.object({ type: z.string() }).passthrough().parse(JSON.parse(data));
    if (raw.type === 'response.output_text.delta') {
      this.text += z.string().parse(raw.delta);
      if (this.text.length > 16000) {
        this.text = this.text.slice(0, 16000);
        throw new Error('Reply exceeds the text limit. Partial text is retained.');
      }
    } else if (raw.type === 'response.output_item.added') {
      const item = itemSchema.parse(raw.item);
      if (item.type === 'web_search_call') this.names.add('web_search');
      if (item.type === 'function_call' && typeof item.name === 'string')
        this.names.add(item.name.slice(0, 160));
    } else if (['error', 'response.failed', 'response.incomplete'].includes(raw.type)) {
      throw new Error('The model did not complete its reply. Partial text is retained.');
    } else if (raw.type === 'response.completed') {
      const response = responseSchema.parse(raw.response),
        sources = new Map<string, WebCitation>(),
        calls = [],
        texts = [];
      let searched = this.names.has('web_search');
      const hasFinalAnswer = response.output.some((value) => {
        const item = itemSchema.parse(value);
        return item.type === 'message' && item.phase === 'final_answer';
      });
      for (const output of response.output) {
        const item = itemSchema.parse(output);
        if (item.type === 'web_search_call') {
          searched = true;
          this.names.add('web_search');
        } else if (item.type === 'function_call') {
          const call = z
            .object({
              call_id: z.string(),
              name: z.string(),
              arguments: z.string(),
              status: z.literal('completed').optional(),
            })
            .parse(item);
          calls.push({
            id: call.call_id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          });
        } else if (item.type === 'message') {
          if (item.phase === 'commentary' || (hasFinalAnswer && item.phase !== 'final_answer'))
            continue;
          const message = z
            .object({
              role: z.literal('assistant'),
              content: z.array(z.unknown()).max(100),
              status: z.literal('completed').optional(),
            })
            .parse(item);
          for (const content of message.content) {
            const block = itemSchema.parse(content);
            if (block.type !== 'output_text') continue;
            const value = z
              .object({
                text: z.string().max(16000),
                annotations: z.array(z.unknown()).max(200).optional(),
              })
              .parse(block);
            const inserts = new Map<number, Set<string>>();
            for (const rawAnnotation of value.annotations || []) {
              const parsed = annotationSchema.safeParse(rawAnnotation);
              if (!parsed.success) continue;
              const annotation = parsed.data;
              if (
                annotation.start_index > annotation.end_index ||
                annotation.end_index > value.text.length
              )
                continue;
              const reference = webCitationSchema.safeParse({
                kind: 'web',
                id: `web.${createHash('sha256').update(annotation.url).digest('hex').slice(0, 24)}`,
                url: annotation.url,
                title: (annotation.title || annotation.url).slice(0, 300),
              });
              if (!reference.success || (!sources.has(reference.data.id) && sources.size >= 40))
                continue;
              sources.set(reference.data.id, reference.data);
              const ids = inserts.get(annotation.end_index) || new Set<string>();
              ids.add(reference.data.id);
              inserts.set(annotation.end_index, ids);
            }
            let text = value.text;
            for (const [offset, ids] of [...inserts].sort(([a], [b]) => b - a))
              text =
                text.slice(0, offset) +
                [...ids].map((id) => ` [${id}]`).join('') +
                text.slice(offset);
            texts.push(text);
          }
        }
      }
      if (!texts.some((text) => text.trim()) && !calls.length)
        throw new Error(
          'The model returned no visible answer or function calls. Partial text is retained.',
        );
      this.result = completionMessageSchema.parse({
        content: texts.join('\n\n') || null,
        ...(calls.length ? { tool_calls: calls } : {}),
        webSearched: searched,
        webSources: [...sources.values()],
      });
      this.text = this.result.content || '';
      this.done = true;
    }
  }
}
