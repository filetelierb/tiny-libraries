import { z } from 'zod';

/** Web provenance is external evidence; it never grants library or local network access. */
export const publicWebUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value),
        host = url.hostname.toLowerCase();
      return (
        ['https:', 'http:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        host.includes('.') &&
        !host.endsWith('.localhost') &&
        !host.endsWith('.local') &&
        !/^\d+(?:\.\d+){3}$/.test(host) &&
        !host.includes(':') &&
        host !== 'localhost'
      );
    } catch {
      return false;
    }
  }, 'A public HTTP or HTTPS source is required');
export const webCitationSchema = z.object({
  kind: z.literal('web'),
  id: z.string().regex(/^web\.[a-f0-9]{24}$/),
  url: publicWebUrlSchema,
  title: z.string().min(1).max(300),
});
export type WebCitation = z.infer<typeof webCitationSchema>;
export const webDraftSchema = z.object({ enabled: z.boolean(), stamp: z.string().uuid() });
export type WebDraft = z.infer<typeof webDraftSchema>;
export function readWebDraft(value: string): WebDraft {
  try {
    const parsed = webDraftSchema.safeParse(JSON.parse(value));
    if (parsed.success) return parsed.data;
  } catch {}
  return { enabled: false, stamp: crypto.randomUUID() };
}
