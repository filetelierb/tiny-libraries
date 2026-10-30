import { mkdir, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { see } from './courses/see';
import { lectureSelection, type CourseFile, type CourseSource } from './courses/source';
import {
  courseFolderName,
  downloadFile,
  formatBytes,
  remoteSizes,
  writeManifest,
  type CourseManifest,
} from './courses/download';
import { importCourse } from './courses/import';
import {
  assertVolumeMounted,
  assertWritable,
  DataFolderError,
  readConfig,
  saveConfig,
} from './data-dir';

const usage = `Open courseware for the library.

  npm run courses -- list [source]
  npm run courses -- show <source> <course>
  npm run courses -- download <source> <course> [--lectures 1-3|all|none]
                     [--no-transcripts] [--no-materials] [--to <folder>]
  npm run courses -- import <course folder> [--project <name>] [--prepare none|videos|all]

Sources: see (Stanford Engineering Everywhere, CC BY-NC-SA 4.0).
Videos are only downloaded for the lectures named with --lectures.
The folder given with --to is remembered for later downloads.`;

const sources: Record<string, CourseSource> = { see };
const root = process.cwd();
const [command, ...rest] = process.argv.slice(2);
const option = (name: string) => {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
};
const flag = (name: string) => rest.includes(`--${name}`);
const positional = rest.filter(
  (value, index) => !value.startsWith('--') && !rest[index - 1]?.match(/^--(?!no-)/),
);
const source = (id = 'see') => {
  const value = sources[id];
  if (!value) throw new DataFolderError(`Unknown source ${id}. Sources: ${Object.keys(sources)}`);
  return value;
};

async function list() {
  const value = source(positional[0]);
  console.log(`${value.name}\n`);
  for (const course of await value.catalog())
    console.log(`  ${course.code.padEnd(8)} ${course.title}`);
}

async function show() {
  const course = await source(positional[0]).course(positional[1] || '');
  const sizes = await remoteSizes(course.files.map((file) => file.url));
  const total = (files: CourseFile[]) =>
    files.reduce((sum, file) => sum + (sizes.get(file.url) || 0), 0);
  console.log(
    `${course.code} – ${course.title}${course.instructor ? ` · ${course.instructor}` : ''}`,
  );
  console.log(`${course.url}\nLicense: ${course.license.name}\n`);
  for (const lecture of course.lectures) {
    const video = course.files.find(
      (file) => file.lecture === lecture.number && file.role === 'video',
    );
    console.log(
      `  Lecture ${String(lecture.number).padStart(2)}  ${(lecture.duration || '').padEnd(12)} ${video ? formatBytes(sizes.get(video.url) || 0) : 'no video'}`,
    );
    if (lecture.topics) console.log(`      ${lecture.topics.slice(0, 150)}`);
  }
  const videos = course.files.filter((file) => file.role === 'video'),
    others = course.files.filter((file) => file.role !== 'video');
  console.log(`\nVideos: ${videos.length}, ${formatBytes(total(videos))}`);
  console.log(`Transcripts and materials: ${others.length} files, ${formatBytes(total(others))}`);
  const folders = [...new Set(others.filter((f) => f.role === 'material').map((f) => f.folder))];
  if (folders.length) console.log(`Material folders: ${folders.join(', ')}`);
}

async function download() {
  const course = await source(positional[0]).course(positional[1] || '');
  const remembered = (await readConfig(root)).coursesDir;
  const base = option('to') ? resolve(option('to')!) : remembered;
  if (!base) throw new DataFolderError('Choose where courses go with --to <folder>.');
  await assertVolumeMounted(base);
  const folder = join(base, course.source, courseFolderName(course));
  const lectures = lectureSelection(
    option('lectures'),
    course.lectures.map((lecture) => lecture.number),
  );
  const files = course.files.filter((file) =>
    file.role === 'video'
      ? lectures.has(file.lecture!)
      : file.role === 'transcript'
        ? !flag('no-transcripts')
        : !flag('no-materials'),
  );
  if (!files.length) throw new DataFolderError('Nothing to download with these options.');
  const sizes = await remoteSizes(files.map((file) => file.url));
  const needed = files.reduce((sum, file) => sum + (sizes.get(file.url) || 0), 0);
  await mkdir(folder, { recursive: true });
  await assertWritable(folder);
  if (option('to')) await saveConfig(root, { coursesDir: base });
  const disk = await statfs(folder);
  if (disk.bavail * disk.bsize < needed)
    throw new DataFolderError(
      `${formatBytes(needed)} are needed and ${formatBytes(disk.bavail * disk.bsize)} are free in ${base}.`,
    );
  console.log(`${course.code} – ${course.title}: ${files.length} files, ${formatBytes(needed)}`);
  console.log(`Into ${folder}\n`);
  const done: CourseManifest['files'] = [];
  for (const [index, file] of files.entries()) {
    const path = join(file.folder, file.name);
    let shown = -1;
    const result = await downloadFile(file.url, join(folder, path), (bytes, size) => {
      const percent = size ? Math.floor((bytes / size) * 100) : 0;
      if (percent !== shown) {
        shown = percent;
        process.stdout.write(
          `\r[${index + 1}/${files.length}] ${path} ${size ? `${percent}%` : formatBytes(bytes)}   `,
        );
      }
    });
    process.stdout.write(
      `\r[${index + 1}/${files.length}] ${path} ${result === 'kept' ? 'already here' : 'done'}\n`,
    );
    done.push({ ...file, path, size: sizes.get(file.url) || 0 });
    // The record is updated as files arrive, so an interrupted download can still be imported.
    await writeManifest(folder, course, done);
  }
  console.log(`\nNext: npm run courses -- import "${folder}"`);
}

async function main() {
  if (command === 'list') return list();
  if (command === 'show') return show();
  if (command === 'download') return download();
  if (command === 'import') {
    if (!positional[0]) throw new DataFolderError('Name the downloaded course folder to import.');
    const prepare = (option('prepare') || 'none') as 'none' | 'videos' | 'all';
    if (!['none', 'videos', 'all'].includes(prepare))
      throw new DataFolderError('Use --prepare none, videos or all.');
    return importCourse(resolve(positional[0]), {
      app: option('app') || 'http://127.0.0.1:9876',
      project: option('project'),
      prepare,
      log: console.log,
    });
  }
  console.log(usage);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
