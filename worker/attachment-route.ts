import { attachmentInputSchema, MAX_ATTACHMENT_IMAGE_BYTES } from '../shared/tutor-attachments';
import {
  createQuestionAttachment,
  getQuestionAttachment,
  attachmentSegmentPage,
  attachmentImageKey,
  AttachmentError,
  type AttachmentStore,
} from './tutor-attachments';
const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
export async function attachmentRoute(
  request: Request,
  env: Env,
  storage: AttachmentStore,
  body: () => Promise<unknown>,
): Promise<Response | null> {
  const url = new URL(request.url),
    match = url.pathname.match(
      /^\/api\/tutor-attachments(?:\/([a-f0-9-]+)(?:\/(image|segments))?)?$/,
    );
  if (!match) return null;
  if (!match[1]) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const input = attachmentInputSchema.parse(await body());
    return json(
      await createQuestionAttachment(storage, env.FILES, input, async (bytes, strokes) => {
        let binary = '';
        for (let start = 0; start < bytes.length; start += 32768)
          binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
        const response = await fetch(`${env.MEDIA_BRIDGE_URL}/capture-image`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.MEDIA_BRIDGE_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ image: btoa(binary), strokes }),
          signal: AbortSignal.timeout(30000),
        });
        if (!response.ok)
          throw new AttachmentError(
            'Capture composition failed. Reopen the capture and try again.',
            422,
          );
        if (Number(response.headers.get('Content-Length')) > MAX_ATTACHMENT_IMAGE_BYTES)
          throw new AttachmentError('Drawn capture exceeds 3 MB', 413);
        return new Uint8Array(await response.arrayBuffer());
      }),
      201,
    );
  }
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const attachment = await getQuestionAttachment(storage, match[1]);
  if (match[2] === 'image') {
    if (!attachment.image) throw new AttachmentError('Attachment has no image', 404);
    const image = await env.FILES.get(attachmentImageKey(attachment.id, attachment.image.id));
    if (!image) throw new AttachmentError('Attachment image is unavailable', 404);
    return new Response(image.body, {
      headers: {
        'Content-Type': attachment.image.mime,
        'Content-Length': String(image.size),
        'Cache-Control': 'private, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': 'sandbox',
      },
    });
  }
  if (match[2] === 'segments') {
    const start = Number(url.searchParams.get('after') || 0);
    return json(await attachmentSegmentPage(storage, attachment, start));
  }
  return json(attachment);
}
