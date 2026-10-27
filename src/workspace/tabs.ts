import type { ResourceTab, StudySession } from '../../shared/domain';

export type ResourceWorkspace = { resourceTabs: ResourceTab[]; activeTabId: string | null };
export function visibleWorkspace(
  state: ResourceWorkspace,
  validSources: Set<string>,
): ResourceWorkspace {
  const resourceTabs = state.resourceTabs.filter((tab) =>
    tab.sources.every((id) => validSources.has(id)),
  );
  return {
    resourceTabs,
    activeTabId: resourceTabs.some((tab) => tab.id === state.activeTabId)
      ? state.activeTabId
      : resourceTabs.at(-1)?.id || null,
  };
}

/** Read older saved sessions without changing their original resource identities. */
export function readWorkspace(session: StudySession): ResourceWorkspace {
  if (session.resourceTabs) {
    const activeTabId = session.resourceTabs.some((tab) => tab.id === session.activeTabId)
      ? session.activeTabId!
      : session.resourceTabs.at(-1)?.id || null;
    return { resourceTabs: session.resourceTabs, activeTabId };
  }
  const resourceTabs: ResourceTab[] = [...new Set(session.tabs)].map((id) => ({
    id: `file:${id}`,
    sources: [id],
    preview: false,
  }));
  let activeTabId = resourceTabs.find((tab) => tab.sources[0] === session.active)?.id || null;
  if (session.active && session.split && session.active !== session.split) {
    const pair = {
      id: `pair:${session.active}:${session.split}`,
      sources: [session.active, session.split],
      preview: false,
    };
    resourceTabs.push(pair);
    activeTabId = pair.id;
  }
  return { resourceTabs, activeTabId: activeTabId || resourceTabs.at(-1)?.id || null };
}

/** Keep the flat resource index compatible with existing session consumers. */
export function workspacePatch(workspace: ResourceWorkspace): Partial<StudySession> {
  const active = workspace.resourceTabs.find((tab) => tab.id === workspace.activeTabId);
  return {
    ...workspace,
    tabs: [...new Set(workspace.resourceTabs.flatMap((tab) => tab.sources))],
    active: active?.sources[0] || null,
    split: active?.sources[1] || null,
  };
}

export function openResource(
  state: ResourceWorkspace,
  sourceId: string,
  mode: 'preview' | 'retain',
): ResourceWorkspace {
  const existing = state.resourceTabs.find(
    (tab) => tab.sources.length === 1 && tab.sources[0] === sourceId,
  );
  if (existing)
    return {
      resourceTabs: state.resourceTabs.map((tab) =>
        tab.id === existing.id && mode === 'retain' ? { ...tab, preview: false } : tab,
      ),
      activeTabId: existing.id,
    };
  const preview = state.resourceTabs.find((tab) => tab.preview);
  const next: ResourceTab = {
    id: mode === 'preview' && preview ? preview.id : crypto.randomUUID(),
    sources: [sourceId],
    preview: mode === 'preview',
  };
  return {
    resourceTabs:
      preview && mode === 'preview'
        ? state.resourceTabs.map((tab) => (tab.id === preview.id ? next : tab))
        : [...state.resourceTabs, next],
    activeTabId: next.id,
  };
}

export function retainTab(state: ResourceWorkspace, id: string): ResourceWorkspace {
  return {
    ...state,
    resourceTabs: state.resourceTabs.map((tab) =>
      tab.id === id ? { ...tab, preview: false } : tab,
    ),
  };
}

export function closeResourceTab(state: ResourceWorkspace, id: string): ResourceWorkspace {
  const index = state.resourceTabs.findIndex((tab) => tab.id === id);
  const resourceTabs = state.resourceTabs.filter((tab) => tab.id !== id);
  return {
    resourceTabs,
    activeTabId:
      state.activeTabId === id
        ? resourceTabs[Math.min(index, resourceTabs.length - 1)]?.id || null
        : state.activeTabId,
  };
}

export function reorderResourceTabs(
  state: ResourceWorkspace,
  sourceId: string,
  targetId: string,
): ResourceWorkspace {
  const from = state.resourceTabs.findIndex((tab) => tab.id === sourceId),
    to = state.resourceTabs.findIndex((tab) => tab.id === targetId);
  if (from < 0 || to < 0 || from === to) return state;
  const resourceTabs = [...state.resourceTabs];
  const [tab] = resourceTabs.splice(from, 1);
  resourceTabs.splice(to, 0, tab);
  return { ...state, resourceTabs };
}

export function splitWithResource(state: ResourceWorkspace, sourceId: string): ResourceWorkspace {
  const active = state.resourceTabs.find((tab) => tab.id === state.activeTabId);
  if (!active || !state.resourceTabs.some((tab) => tab.sources.includes(sourceId))) return state;
  const current =
    active.focusedSource && active.sources.includes(active.focusedSource)
      ? active.focusedSource
      : active.sources[0];
  return openSplit(state, current, sourceId);
}

export function openSplit(
  state: ResourceWorkspace,
  first: string,
  second: string,
): ResourceWorkspace {
  if (first === second) return state;
  const existing = state.resourceTabs.find(
    (tab) => tab.sources[0] === first && tab.sources[1] === second,
  );
  if (existing) return { ...state, activeTabId: existing.id };
  const tab: ResourceTab = { id: crypto.randomUUID(), sources: [first, second], preview: false };
  return { resourceTabs: [...state.resourceTabs, tab], activeTabId: tab.id };
}

export function unsplit(state: ResourceWorkspace): ResourceWorkspace {
  const tab = state.resourceTabs.find((tab) => tab.id === state.activeTabId);
  if (!tab || tab.sources.length < 2) return state;
  const without = closeResourceTab(state, tab.id);
  return openResource(
    without,
    tab.focusedSource && tab.sources.includes(tab.focusedSource)
      ? tab.focusedSource
      : tab.sources[0],
    'retain',
  );
}

export function focusSource(state: ResourceWorkspace, sourceId: string): ResourceWorkspace {
  return {
    ...state,
    resourceTabs: state.resourceTabs.map((tab) =>
      tab.id === state.activeTabId && tab.sources.includes(sourceId)
        ? { ...tab, focusedSource: sourceId }
        : tab,
    ),
  };
}
export function resizeSplit(state: ResourceWorkspace, ratio: number): ResourceWorkspace {
  return {
    ...state,
    resourceTabs: state.resourceTabs.map((tab) =>
      tab.id === state.activeTabId && tab.sources.length === 2
        ? { ...tab, splitRatio: Math.max(0.2, Math.min(0.8, ratio)) }
        : tab,
    ),
  };
}
export function swapSplit(state: ResourceWorkspace): ResourceWorkspace {
  return {
    ...state,
    resourceTabs: state.resourceTabs.map((tab) =>
      tab.id === state.activeTabId && tab.sources.length === 2
        ? {
            ...tab,
            sources: [...tab.sources].reverse(),
            focusedSource: tab.focusedSource || tab.sources[0],
            splitRatio: 1 - (tab.splitRatio ?? 0.5),
          }
        : tab,
    ),
  };
}
export function replacePane(
  state: ResourceWorkspace,
  sourceId: string,
  replacement: string,
): ResourceWorkspace {
  const current = state.resourceTabs.find((tab) => tab.id === state.activeTabId);
  if (!current || current.sources.length !== 2 || !current.sources.includes(sourceId)) return state;
  if (current.sources.includes(replacement)) return focusSource(state, replacement);
  return {
    ...state,
    resourceTabs: state.resourceTabs.map((tab) =>
      tab.id === current.id
        ? {
            ...tab,
            sources: tab.sources.map((id) => (id === sourceId ? replacement : id)),
            focusedSource: replacement,
          }
        : tab,
    ),
  };
}
