import { z } from 'zod';
import { visualKey } from '../shared/artifact-widgets';
import {
  segmentSchema,
  validateSynthesis,
  type Learning,
  type Locale,
  type Source,
} from '../shared/domain';
import type { CardDeck } from '../shared/flashcards';
import { latestArtifact } from './artifact-revisions';
import { commitPack, readPack, writePack } from './courses';

/**
 * A course folder can carry the material the library prepared for its files: transcripts,
 * subtitles, chapters with their quizzes, the glossary terms, the artifact, pictures and
 * flashcards. Another project made from the same course brings it in instead of preparing
 * again. A course's files keep their path in the course as their place in the library, and
 * are matched by it and their size; the student's progress, notes and conversations are never
 * part of it.
 */
export const coursePath = (file: { folder: string; name: string }) =>
  file.folder ? `${file.folder}/${file.name}` : file.name;
type Bridge = { MEDIA_BRIDGE_URL: string; MEDIA_BRIDGE_TOKEN: string };
type PackEnv = Bridge & { FILES: R2Bucket };
const manifestSchema = z.object({
  format: z.literal(1),
  exportedAt: z.string(),
  locale: z.enum(['en', 'es']),
  dir: z.string().regex(/^files-[\w-]+$/),
  files: z
    .array(z.object({ path: z.string().min(1).max(1024), size: z.number().int(), key: z.string() }))
    .max(5000),
});
export type PackManifest = z.infer<typeof manifestSchema>;
const CAPTIONS = ['original.vtt', 'original.srt', 'translated.vtt', 'translated.srt'];
/** What a file's material keeps of a deck: its chapter and cards, never who studied them. */
type PackedDeck = Pick<CardDeck, 'chapterId' | 'title' | 'locale' | 'model' | 'cards'>;

/** Writes the prepared material of every file of the course, then its manifest. */
export async function exportPack(
  storage: DurableObjectStorage,
  env: PackEnv,
  root: string,
  files: Source[],
): Promise<PackManifest> {
  const dir = `files-${Date.now().toString(36)}`;
  const entries: PackManifest['files'] = [];
  const locales = new Map<Locale, number>();
  for (const file of files) {
    if (file.kind === 'artifact') continue;
    const learning = await storage.get<Learning>(`learning:${file.id}`);
    if (!learning || learning.sourceVersion !== file.version) continue;
    const key = String(entries.length + 1),
      at = (name: string) => `${dir}/${key}/${name}`;
    // The artifact as the student last saved it; concept links belong to this library only.
    const latest = await latestArtifact(storage, learning);
    const { concepts: _concepts, sourceId: _id, sourceVersion: _version, ...material } = learning;
    await writePack(
      env,
      root,
      at('learning.json'),
      JSON.stringify({
        ...material,
        synthesis: latest
          ? { ...learning.synthesis, artifact: latest.artifact }
          : learning.synthesis,
      }),
    );
    for (const name of CAPTIONS) {
      const object = await env.FILES.get(`captions/${file.id}/${name}`);
      if (object) await writePack(env, root, at(`captions/${name}`), object.body);
    }
    // Pictures are numbered; their index keeps the segment each one shows and its type.
    const pictures: Array<{ segmentId: string; type: string }> = [];
    const listed = await env.FILES.list({ prefix: `visuals/${file.id}/${file.version}/` });
    for (const { key: stored } of listed.objects) {
      const object = await env.FILES.get(stored);
      if (!object) continue;
      await writePack(env, root, at(`visuals/${pictures.length + 1}`), object.body);
      pictures.push({
        segmentId: decodeURIComponent(stored.split('/').pop()!),
        type: object.httpMetadata?.contentType || 'image/jpeg',
      });
    }
    if (pictures.length) await writePack(env, root, at('visuals.json'), JSON.stringify(pictures));
    const decks: PackedDeck[] = [];
    for (const id of (
      await storage.list<string>({
        prefix: `card-index:${file.id}:${file.version}:${learning.createdAt}:`,
      })
    ).values()) {
      const deck = await storage.get<CardDeck>(`card-deck:${id}`);
      if (deck?.status === 'ready')
        decks.push({
          chapterId: deck.chapterId,
          title: deck.title,
          locale: deck.locale,
          model: deck.model,
          cards: deck.cards,
        });
    }
    if (decks.length) await writePack(env, root, at('cards.json'), JSON.stringify(decks));
    entries.push({ path: coursePath(file), size: file.size, key });
    locales.set(learning.locale, (locales.get(learning.locale) || 0) + 1);
  }
  if (!entries.length) throw new PackError('No file in this project has prepared material yet');
  const manifest: PackManifest = {
    format: 1,
    exportedAt: new Date().toISOString(),
    locale: [...locales].sort((a, b) => b[1] - a[1])[0][0],
    dir,
    files: entries,
  };
  await commitPack(env, root, manifest);
  return manifest;
}

export class PackError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

/**
 * Brings in the material of each file the pack knows by path and size and that has none yet.
 * `publish` stores it as a preparation does, so the glossary and the artifact history follow.
 */
export async function importPack(
  storage: DurableObjectStorage,
  env: PackEnv,
  root: string,
  files: Source[],
  publish: (learning: Learning) => Promise<void>,
) {
  const response = await readPack(env, root, 'manifest.json');
  if (!response) throw new PackError('This folder has no prepared material');
  const manifest = manifestSchema.parse(await response.json());
  const byPath = new Map(files.map((file) => [coursePath(file), file]));
  let imported = 0,
    skipped = 0;
  for (const entry of manifest.files) {
    const file = byPath.get(entry.path);
    if (!file || file.size !== entry.size || (await storage.get(`learning:${file.id}`))) {
      skipped++;
      continue;
    }
    const at = (name: string) => `${manifest.dir}/${entry.key}/${name}`;
    try {
      const raw = (await (await readPack(env, root, at('learning.json')))?.json()) as Record<
        string,
        unknown
      > | null;
      if (!raw) throw new PackError('Missing material');
      const segments = z.array(segmentSchema).max(20000).parse(raw.segments);
      const ids = new Set(segments.map((segment) => segment.id));
      const learning: Learning = {
        sourceId: file.id,
        sourceVersion: file.version,
        model: z.string().max(200).parse(raw.model),
        locale: z.enum(['en', 'es']).parse(raw.locale),
        segments,
        synthesis: validateSynthesis(raw.synthesis, segments, ids),
        createdAt: z.string().max(40).parse(raw.createdAt),
      };
      for (const name of CAPTIONS) {
        const object = await readPack(env, root, at(`captions/${name}`));
        if (object) await env.FILES.put(`captions/${file.id}/${name}`, await object.arrayBuffer());
      }
      const pictures = z
        .array(
          z.object({ segmentId: z.string().max(200), type: z.string().regex(/^image\/[a-z+]+$/) }),
        )
        .max(2000)
        .parse((await (await readPack(env, root, at('visuals.json')))?.json()) ?? []);
      for (const [index, picture] of pictures.entries()) {
        if (!ids.has(picture.segmentId)) continue;
        const object = await readPack(env, root, at(`visuals/${index + 1}`));
        if (object)
          await env.FILES.put(
            visualKey(file.id, file.version, picture.segmentId),
            await object.arrayBuffer(),
            { httpMetadata: { contentType: picture.type } },
          );
      }
      await publish(learning);
      const decks = (await (await readPack(env, root, at('cards.json')))?.json()) as
        PackedDeck[] | null;
      const chapters = new Set(learning.synthesis.chapters.map((chapter) => chapter.id));
      for (const deck of decks || []) {
        if (!chapters.has(deck.chapterId) || !Array.isArray(deck.cards)) continue;
        const stored = {
          id: crypto.randomUUID(),
          sourceId: file.id,
          sourceVersion: file.version,
          learningVersion: learning.createdAt,
          chapterId: deck.chapterId,
          title: String(deck.title).slice(0, 300),
          locale: learning.locale,
          model: String(deck.model).slice(0, 200),
          createdAt: new Date().toISOString(),
          status: 'ready',
          cards: deck.cards.map((card) => ({ ...card, id: crypto.randomUUID() })),
          owner: '',
          operation: '',
          until: 0,
        } satisfies CardDeck & { owner: string; operation: string; until: number };
        await storage.put(`card-deck:${stored.id}`, stored);
        await storage.put(
          `card-index:${file.id}:${file.version}:${learning.createdAt}:${deck.chapterId}`,
          stored.id,
        );
      }
      imported++;
    } catch (error) {
      console.error(`Prepared material for ${entry.path} could not be imported`, error);
      skipped++;
    }
  }
  return { files: imported, skipped, locale: manifest.locale };
}
