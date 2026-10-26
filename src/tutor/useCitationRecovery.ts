import { useEffect, useState } from 'react';
import type { Catalog, Learning, PublicLearning } from '../../shared/domain';
import type { Conversation } from '../../shared/conversations';
import { api } from '../api';
export function useCitationRecovery(conversation: Conversation, catalog: Catalog) {
  const [materials, setMaterials] = useState<Learning[]>([]);
  const ids = [
    ...new Set(
      conversation.messages
        .filter((m) => m.citations === undefined)
        .flatMap((m) => m.sourceIds || []),
    ),
  ];
  const oldSource = conversation.id.match(/^history-[a-f0-9-]{36}-([a-f0-9-]{36})$/)?.[1];
  if (oldSource) ids.push(oldSource);
  const key = [...new Set(ids)]
    .filter((id) => catalog.files.some((f) => f.id === id))
    .sort()
    .map((id) => `${id}:${catalog.files.find((f) => f.id === id)!.version}`)
    .join(',');
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      key
        .split(',')
        .filter(Boolean)
        .map(async (pair) => {
          const [id, version] = pair.split(':');
          try {
            const data = await api<PublicLearning | null>(`/learning/${id}`);
            return data?.sourceVersion === Number(version)
              ? ({ ...data, synthesis: { ...data.synthesis, chapters: [] } } as Learning)
              : null;
          } catch {
            return null;
          }
        }),
    ).then((results) => {
      if (!cancelled) setMaterials(results.filter((m): m is Learning => !!m));
    });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return materials;
}
