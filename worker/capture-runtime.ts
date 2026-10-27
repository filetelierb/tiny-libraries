import { CaptureStore, CaptureError, type CaptureRenderer } from './capture-store';
import type { GlossaryStorage } from './glossary';

export async function boundedCaptureBytes(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
) {
  if (!body) throw new CaptureError('Capture body is missing');
  const reader = body.getReader(),
    parts: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > maximum) throw new CaptureError('Capture body exceeds its size limit', 413);
      parts.push(part.value);
    }
  } finally {
    await reader.cancel();
  }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return data;
}
export function captureRenderer(env: Env): CaptureRenderer {
  return async (bytes, drawing) => {
    let binary = '';
    for (let start = 0; start < bytes.length; start += 32768)
      binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
    const response = await fetch(`${env.MEDIA_BRIDGE_URL}/render-capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.MEDIA_BRIDGE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ image: btoa(binary), drawing }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new CaptureError(
        'Capture composition failed. Its saved annotation has not been replaced.',
        response.status === 400 ? 422 : 503,
      );
    return {
      bytes: await boundedCaptureBytes(response.body, 3 * 1024 * 1024),
      width: Number(response.headers.get('X-Capture-Width')),
      height: Number(response.headers.get('X-Capture-Height')),
    };
  };
}
export function captureStore(env: Env, storage: GlossaryStorage) {
  return new CaptureStore(
    storage,
    {
      read: async (key) => {
        const object = await env.FILES.get(key);
        if (!object) return null;
        if (object.size > 8 * 1024 * 1024)
          throw new CaptureError('Stored capture exceeds its size limit', 503);
        return new Uint8Array(await object.arrayBuffer());
      },
      write: async (key, bytes) => {
        await env.FILES.put(key, bytes);
      },
    },
    captureRenderer(env),
  );
}
