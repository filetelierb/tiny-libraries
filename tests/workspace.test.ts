import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionSchema, type StudySession } from '../shared/domain';
import {
  readWorkspace,
  openResource,
  openSplit,
  closeResourceTab,
  retainTab,
  workspacePatch,
  unsplit,
  focusSource,
  resizeSplit,
  swapSplit,
  replacePane,
  visibleWorkspace,
} from '../src/workspace/tabs';
import { splitLimits } from '../src/workspace/SplitWorkspace';
import { readPanelPreferences, resolvePanels, PANEL_MIN } from '../src/workspace/layout';

const saved: StudySession = sessionSchema.parse({
  id: '8a302f95-695a-4f56-8de6-3c159bd6b81d',
  name: 'Reading',
  tabs: ['recording', 'slides', 'notes'],
  active: 'recording',
  split: 'slides',
  positions: { recording: 37.5, slides: 4 },
  notes: [{ id: 'note', sourceId: 'recording', text: 'A thought', createdAt: '2026-10-26' }],
  bookmarks: [{ id: 'bookmark', sourceId: 'slides', label: 'Diagram', page: 4 }],
  createdAt: '2026-10-26',
});

test('older sessions keep every retained resource and split pair through serialization', () => {
  const state = readWorkspace(saved);
  assert.equal(state.resourceTabs.length, 4);
  assert.deepEqual(state.resourceTabs.find((tab) => tab.id === state.activeTabId)?.sources, [
    'recording',
    'slides',
  ]);
  const restored = sessionSchema.parse(
    JSON.parse(JSON.stringify({ ...saved, ...workspacePatch(state) })),
  );
  assert.deepEqual(readWorkspace(restored), state);
  assert.deepEqual(restored.positions, saved.positions);
  assert.deepEqual(restored.notes, saved.notes);
  assert.deepEqual(restored.bookmarks, saved.bookmarks);
});

test('successive previews replace one slot without removing retained resources', () => {
  let state = openResource(readWorkspace(saved), 'new-one', 'preview');
  const previewId = state.activeTabId;
  state = openResource(state, 'new-two', 'preview');
  assert.equal(state.activeTabId, previewId);
  assert.equal(state.resourceTabs.filter((tab) => tab.preview).length, 1);
  assert.ok(!state.resourceTabs.some((tab) => tab.sources.includes('new-one')));
  assert.ok(state.resourceTabs.some((tab) => tab.sources[0] === 'recording'));
  state = retainTab(state, previewId!);
  state = openResource(state, 'new-three', 'preview');
  assert.ok(state.resourceTabs.some((tab) => tab.sources[0] === 'new-two' && !tab.preview));
  assert.equal(state.resourceTabs.filter((tab) => tab.preview).length, 1);
});

test('opening a preview in a separate tab retains it without duplication', () => {
  let state = openResource({ resourceTabs: [], activeTabId: null }, 'a', 'preview');
  const id = state.activeTabId;
  state = openResource(state, 'a', 'retain');
  assert.equal(state.resourceTabs.length, 1);
  assert.equal(state.activeTabId, id);
  assert.equal(state.resourceTabs[0].preview, false);
});

test('split pairs remain independent of singles and of each other', () => {
  let state = openSplit(readWorkspace(saved), 'notes', 'slides');
  const secondPair = state.activeTabId;
  const firstPair = state.resourceTabs.find((tab) => tab.sources.join(',') === 'recording,slides')!;
  state = openSplit(state, 'recording', 'slides');
  assert.equal(state.activeTabId, firstPair.id);
  assert.equal(state.resourceTabs.filter((tab) => tab.sources.length === 2).length, 2);
  state = closeResourceTab(state, secondPair!);
  assert.equal(state.activeTabId, firstPair.id);
  assert.equal(state.resourceTabs.filter((tab) => tab.sources.length === 2).length, 1);
  const single = unsplit(state);
  assert.equal(workspacePatch(single).active, 'recording');
  assert.equal(workspacePatch(single).split, null);
  assert.ok(single.resourceTabs.some((tab) => tab.sources[0] === 'slides'));
});

test('closing the active tab selects its neighbor; closing the final tab clears the view', () => {
  let state = {
    resourceTabs: [
      { id: 'a', sources: ['a'], preview: false },
      { id: 'b', sources: ['b'], preview: false },
      { id: 'c', sources: ['c'], preview: false },
    ],
    activeTabId: 'b' as string | null,
  };
  state = closeResourceTab(state, 'b');
  assert.equal(state.activeTabId, 'c');
  state = closeResourceTab(closeResourceTab(state, 'c'), 'a');
  assert.equal(state.activeTabId, null);
  assert.deepEqual(workspacePatch(state).tabs, []);
});

test('invalid layout preferences recover and saved widths stay bounded', () => {
  assert.equal(readPanelPreferences('broken JSON', 1400).left.pinned, true);
  assert.equal(readPanelPreferences('null', 1400).right.width, 340);
  const preferences = readPanelPreferences(
    JSON.stringify({
      left: { width: -100, pinned: false, open: true },
      right: { width: 9000, pinned: true, open: false },
    }),
    1400,
  );
  assert.equal(preferences.left.width, PANEL_MIN.left);
  assert.equal(preferences.right.width, 600);
  assert.equal(preferences.left.pinned, false);
  assert.equal(preferences.right.open, false);
});

test('resizing a viewport retains reading room without changing saved preferences', () => {
  const preferences = readPanelPreferences(
    JSON.stringify({
      left: { width: 520, pinned: true, open: true },
      right: { width: 600, pinned: true, open: true },
    }),
    1500,
  );
  for (const width of [960, 1000, 1150, 1500]) {
    const layout = resolvePanels(preferences, width);
    assert.ok(layout.left.width >= 240);
    assert.ok(layout.right.width >= 280);
    assert.ok(width - layout.left.width - layout.right.width - 12 >= 360);
  }
  const mobile = resolvePanels(preferences, 390);
  assert.equal(mobile.left.docked, false);
  assert.equal(mobile.right.docked, false);
  assert.equal(preferences.left.width, 520);
  assert.equal(preferences.right.width, 600);
  assert.equal(resolvePanels(preferences, 1600).left.width, 520);
});

test('saved resource workspaces reject duplicate tab IDs, duplicate split sources and multiple previews', () => {
  const tab = { id: 'one', sources: ['source'], preview: true };
  assert.throws(() => sessionSchema.parse({ ...saved, resourceTabs: [tab, tab] }));
  assert.throws(() =>
    sessionSchema.parse({ ...saved, resourceTabs: [tab, { ...tab, id: 'two' }] }),
  );
  assert.throws(() =>
    sessionSchema.parse({ ...saved, resourceTabs: [{ ...tab, sources: ['same', 'same'] }] }),
  );
});

test('split focus and width survive serialization independently for each pair', () => {
  let state = resizeSplit(focusSource(readWorkspace(saved), 'slides'), 0.65);
  const first = state.activeTabId;
  state = openSplit(state, 'notes', 'recording');
  state = resizeSplit(focusSource(state, 'recording'), 0.35);
  const second = state.activeTabId;
  const restored = readWorkspace(
    sessionSchema.parse(JSON.parse(JSON.stringify({ ...saved, ...workspacePatch(state) }))),
  );
  assert.equal(restored.resourceTabs.find((tab) => tab.id === first)?.splitRatio, 0.65);
  assert.equal(restored.resourceTabs.find((tab) => tab.id === first)?.focusedSource, 'slides');
  assert.equal(restored.resourceTabs.find((tab) => tab.id === second)?.splitRatio, 0.35);
  assert.equal(restored.resourceTabs.find((tab) => tab.id === second)?.focusedSource, 'recording');
  assert.equal(workspacePatch(restored).active, 'notes');
});
test('swapping preserves source focus and its allocated space; replacing targets the chosen pane', () => {
  let state = resizeSplit(focusSource(readWorkspace(saved), 'slides'), 0.7);
  state = swapSplit(state);
  let tab = state.resourceTabs.find((tab) => tab.id === state.activeTabId)!;
  assert.deepEqual(tab.sources, ['slides', 'recording']);
  assert.equal(tab.focusedSource, 'slides');
  assert.ok(Math.abs(tab.splitRatio! - 0.3) < 0.0001);
  state = replacePane(state, 'recording', 'new-document');
  tab = state.resourceTabs.find((tab) => tab.id === state.activeTabId)!;
  assert.deepEqual(tab.sources, ['slides', 'new-document']);
  assert.equal(tab.focusedSource, 'new-document');
  assert.equal(workspacePatch(unsplit(state)).active, 'new-document');
});
test('trashed resources leave visible tab workspaces without removing source study history', () => {
  const state = visibleWorkspace(readWorkspace(saved), new Set(['slides', 'notes']));
  assert.ok(state.resourceTabs.every((tab) => !tab.sources.includes('recording')));
  assert.deepEqual(saved.positions, { recording: 37.5, slides: 4 });
  assert.equal(saved.notes[0].sourceId, 'recording');
});
test('split limits always leave visible panes and invalid focused source is rejected', () => {
  for (const width of [361, 800, 1440, 3000]) {
    const limits = splitLimits(width);
    assert.ok(limits.min >= 0.2 && limits.min <= 0.25);
    assert.equal(limits.max, 1 - limits.min);
  }
  assert.throws(() =>
    sessionSchema.parse({
      ...saved,
      resourceTabs: [
        { id: 'one', sources: ['recording', 'slides'], preview: false, focusedSource: 'outside' },
      ],
    }),
  );
});
