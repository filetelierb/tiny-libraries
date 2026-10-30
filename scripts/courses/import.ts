import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request } from 'node:http';
import { basename, join } from 'node:path';
import { kindFor, MAX_FILE_BYTES, type Source } from '../../shared/domain';
import type { ProjectSummary } from '../../shared/projects';
import { readManifest, type CourseManifest } from './download';

export type ImportOptions = {
  app: string;
  /** The project to fill; by default one named after the course, created if missing. */
  project?: string;
  /** Which imported files to queue for preparation. */
  prepare: 'none' | 'videos' | 'all';
  log: (line: string) => void;
};

async function call<T>(app: string, path: string, init: RequestInit = {}, project?: string) {
  const response = await fetch(`${app}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(project ? { 'X-Project': project } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `${path} answered ${response.status}`);
  return body as T;
}

// The type the browser would give each file, so the library serves it the same way.
const types: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  md: 'text/markdown',
  txt: 'text/plain',
  csv: 'text/csv',
  vtt: 'text/vtt',
  srt: 'application/x-subrip',
};
const typeOf = (name: string) =>
  types[name.split('.').pop()!.toLowerCase()] || 'application/octet-stream';

/** Streams a file to the library, as the upload form does, without reading it into memory. */
function upload(
  app: string,
  project: string,
  path: string,
  size: number,
  name: string,
  folder: string,
  progress: (percent: number) => void,
) {
  return new Promise<Source>((resolve, reject) => {
    const target = new URL('/api/files', app);
    const req = request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': typeOf(name),
          'Content-Length': size,
          'X-File-Name': encodeURIComponent(name),
          'X-File-Folder': encodeURIComponent(folder),
          'X-Project': project,
        },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(text);
            if ((res.statusCode || 500) >= 400) reject(new Error(body.error || text));
            else resolve(body);
          } catch {
            reject(new Error(`Upload of ${name} failed (${res.statusCode})`));
          }
        });
      },
    );
    req.on('error', reject);
    let sent = 0;
    const stream = createReadStream(path);
    stream.on('data', (chunk) => {
      sent += chunk.length;
      progress(Math.round((sent / size) * 100));
    });
    stream.on('error', reject);
    stream.pipe(req);
  });
}

/**
 * Adds a downloaded course to the library: the course becomes a folder with its own folders
 * (Handouts, Lectures/Lecture 01…), in a project of its own unless another is named. Files
 * already in the library at the same place are left as they are, so an import can be repeated.
 */
export async function importCourse(folder: string, options: ImportOptions) {
  const manifest: CourseManifest | null = await readManifest(folder);
  if (!manifest) throw new Error(`${folder} has no course.json; download the course first.`);
  const { app, log } = options;
  await call(app, '/settings').catch(() => {
    throw new Error(`The app is not answering at ${app}; start it with npm start.`);
  });
  const projects = await call<ProjectSummary[]>(app, '/projects');
  const wanted = options.project || basename(folder);
  let project = projects.find(
    (item) => item.id === wanted || item.name.trim().toLowerCase() === wanted.trim().toLowerCase(),
  );
  if (!project) {
    project = await call<ProjectSummary>(app, '/projects', {
      method: 'POST',
      body: JSON.stringify({ name: wanted.slice(0, 120) }),
    });
    log(`Created project “${project.name}”.`);
  } else log(`Adding to project “${project.name}”.`);
  const { locale } = await call<{ locale: 'en' | 'es' }>(app, '/settings');
  const catalog = await call<{ files: Source[] }>(app, '/catalog', {}, project.id);
  const present = new Set(catalog.files.map((file) => `${file.folder}/${file.name}`));
  const root = basename(folder);
  let added = 0,
    queued = 0;
  for (const file of manifest.files) {
    const place = `${root}/${file.folder}`;
    if (!kindFor(file.name)) {
      log(`  skip ${file.folder}/${file.name}: the library does not read this kind of file`);
      continue;
    }
    const local = join(folder, file.path);
    const size = (await stat(local).catch(() => null))?.size;
    if (!size) {
      log(`  skip ${file.folder}/${file.name}: not downloaded`);
      continue;
    }
    if (size > MAX_FILE_BYTES) {
      log(`  skip ${file.folder}/${file.name}: larger than 2 GB`);
      continue;
    }
    if (present.has(`${place}/${file.name}`)) continue;
    let shown = -1;
    const source = await upload(app, project.id, local, size, file.name, place, (percent) => {
      if (percent >= shown + 10 || percent === 100) {
        shown = percent;
        process.stdout.write(`\r  upload ${file.folder}/${file.name} ${percent}%   `);
      }
    });
    process.stdout.write('\n');
    added++;
    if (options.prepare === 'all' || (options.prepare === 'videos' && file.role === 'video')) {
      await call(
        app,
        '/jobs',
        { method: 'POST', body: JSON.stringify({ sourceId: source.id, locale }) },
        project.id,
      );
      queued++;
    }
  }
  log(
    `Added ${added} file${added === 1 ? '' : 's'}${queued ? `, ${queued} queued for preparation` : ''}. Open ${app}/projects/${project.id}`,
  );
}
