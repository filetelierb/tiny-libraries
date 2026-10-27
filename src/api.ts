export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
/** The sign-in behind the library expired; only a page reload renews it. */
export class SessionExpiredError extends ApiResponseError {}
export async function api<T>(path: string, method = 'GET', value?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    headers: value === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  if (response.status === 401 || response.status === 419)
    throw new SessionExpiredError('Session expired', response.status);
  const data = await response.json();
  if (!response.ok)
    throw new ApiResponseError(
      data.error || `Request failed (${response.status})`,
      response.status,
    );
  return data;
}
export function uploadFile(
  file: File,
  folder: string,
  progress: (percent: number) => void,
  directoryId?: string,
  signal?: AbortSignal,
): Promise<import('../shared/domain').Source> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    if (signal?.aborted) return reject(new DOMException('Upload cancelled', 'AbortError'));
    signal?.addEventListener('abort', () => request.abort(), { once: true });
    request.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'));
    request.open('POST', '/api/files');
    request.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    request.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    request.setRequestHeader('X-File-Folder', encodeURIComponent(folder));
    if (directoryId) request.setRequestHeader('X-Directory-Id', directoryId);
    request.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(Math.round((e.loaded / e.total) * 100));
    };
    request.onerror = () => reject(new Error('Upload interrupted'));
    request.onload = () => {
      try {
        const result = JSON.parse(request.responseText);
        if (request.status >= 400) reject(new Error(result.error));
        else resolve(result);
      } catch {
        reject(new Error('Upload failed'));
      }
    };
    request.send(file);
  });
}
