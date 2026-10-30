/** Deletes every stored object under a prefix. */
export async function purgePrefix(env: Env, prefix: string) {
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix, cursor });
    if (page.objects.length) await env.FILES.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Deletes keys from Durable Object storage, at most 128 per call as storage allows. */
export async function deleteKeys(
  storage: Pick<DurableObjectStorage, 'delete'>,
  keys: Iterable<string>,
) {
  const all = [...keys];
  for (let i = 0; i < all.length; i += 128) await storage.delete(all.slice(i, i + 128));
}

/** Deletes every key under a prefix from Durable Object storage. */
export async function deletePrefix(
  storage: Pick<DurableObjectStorage, 'delete' | 'list'>,
  prefix: string,
) {
  await deleteKeys(storage, (await storage.list({ prefix })).keys());
}
