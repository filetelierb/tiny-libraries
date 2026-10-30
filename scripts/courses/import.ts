import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { request } from 'node:http';
import { basename, join } from 'node:path';
import { kindFor, MAX_FILE_BYTES, mimeFor, type Source } from '../../shared/domain';
import type { ProjectSummary } from '../../shared/projects';
import { readManifest, type CourseManifest } from './download';

export type ImportOptions = {
  app: string;
  /**
   * A project to upload copies into. Without it, the course gets a project that keeps its files
   * in the course folder itself.
   */
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
          'Content-Type': mimeFor(name),
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
  const { locale } = await call<{ locale: 'en' | 'es' }>(app, '/settings');
  const queue = async (project: string, sources: Source[]) => {
    for (const source of sources)
      await call(
        app,
        '/jobs',
        { method: 'POST', body: JSON.stringify({ sourceId: source.id, locale }) },
        project,
      );
    return sources.length;
  };
  // Without --project, the course gets a project that keeps its files in the course folder:
  // the downloaded files are listed where they are, with nothing copied.
  if (!options.project) {
    let project = projects.find((item) => item.folder === folder);
    if (!project) {
      project = await call<ProjectSummary>(app, '/projects', {
        method: 'POST',
        body: JSON.stringify({ name: basename(folder).slice(0, 120), folder, adopt: false }),
      });
      log(`Created project “${project.name}” in ${folder}.`);
    } else log(`Adding to project “${project.name}”.`);
    const { added } = await call<{ added: Source[] }>(
      app,
      '/files/scan',
      { method: 'POST', body: '{}' },
      project.id,
    );
    const videos = new Set(
      manifest.files.filter((file) => file.role === 'video').map((file) => file.path),
    );
    const queued = await queue(
      project.id,
      added.filter(
        (source) =>
          options.prepare === 'all' || (options.prepare === 'videos' && videos.has(source.path!)),
      ),
    );
    log(
      `Added ${added.length} file${added.length === 1 ? '' : 's'}${queued ? `, ${queued} queued for preparation` : ''}. Open ${app}/projects/${project.id}`,
    );
    return;
  }
  const wanted = options.project;
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
    if (options.prepare === 'all' || (options.prepare === 'videos' && file.role === 'video'))
      queued += await queue(project.id, [source]);
  }
  log(
    `Added ${added} file${added === 1 ? '' : 's'}${queued ? `, ${queued} queued for preparation` : ''}. Open ${app}/projects/${project.id}`,
  );
}
