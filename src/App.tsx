import { useEffect, useRef, useState, lazy, Suspense, type CSSProperties } from 'react';
import {
  BookOpen,
  PanelLeft,
  PanelRight,
  Plus,
  Settings as SettingsIcon,
  Search,
  Folder,
  FileText,
  Archive,
  X,
  Check,
  ChevronRight,
  Sparkles,
  Bookmark,
  StickyNote,
  GraduationCap,
  MessageSquare,
  Activity,
  Columns2,
  Maximize2,
  Minimize2,
  Download,
  ArrowUp,
  ArrowLeft,
  CircleHelp,
  Code2,
  LoaderCircle,
  RotateCcw,
  Pin,
  PinOff,
  FolderPlus,
  Trash2,
  ArrowLeftRight,
  FolderOpen,
  Pencil,
  Lightbulb,
} from 'lucide-react';
import {
  type Catalog,
  type Source,
  type StudySession,
  type Settings,
  type Locale,
  type PublicLearning,
  type Segment,
  type Job,
  type Attempt,
  type Directory,
  MAX_FILE_BYTES,
  MAX_RESOURCE_TABS,
  kindFor,
  fold,
  reviewSummary,
} from '../shared/domain';
import { api, uploadFile } from './api';
import { dictionaries, type T } from './i18n';
import { Badge, Button, Empty, IconButton, Modal } from './design/components';
import { Viewer } from './Viewer';
import { GeneratedArtifact } from './GeneratedArtifact';
import { SignalExplorer } from './SignalExplorer';
import { PanelResizer, useDrawerFocus, usePanels } from './workspace/Panels';
import {
  readWorkspace,
  workspacePatch,
  openResource,
  closeResourceTab,
  retainTab,
  openSplit,
  unsplit,
  type ResourceWorkspace,
  focusSource,
  resizeSplit,
  swapSplit,
  replacePane,
  visibleWorkspace,
} from './workspace/tabs';
import { ResourceTabs } from './workspace/ResourceTabs';
import { StudyTabs, type StudyTab } from './workspace/StudyTabs';
import { DirectoryTree, type TreeActions } from './workspace/DirectoryTree';
import { SplitWorkspace } from './workspace/SplitWorkspace';
import { UploadForm } from './workspace/UploadForm';
import { ConversationPanel } from './workspace/ConversationPanel';
import { AnnotationsPanel } from './annotations/AnnotationsPanel';
import { captureSource } from './annotations/capture';
import type { AnnotationRequest } from './annotations/AnnotationEditor';
import type { Annotation, SourceLocation } from '../shared/annotations';
import { useBookmarks } from './bookmarks/useBookmarks';
import { BookmarkEditor, type BookmarkIntent } from './bookmarks/BookmarkEditor';
import { BookmarksPanel, type BookmarkFilter } from './bookmarks/BookmarksPanel';
import { GlossaryPanel } from './glossary/GlossaryPanel';
import { ResourceConceptSuggestions } from './glossary/ResourceConceptSuggestions';
const AnnotationEditor = lazy(() => import('./annotations/AnnotationEditor'));
import { sessionPreview, type QuestionContext } from '../shared/conversations';
import { ActionMenu } from './design/ActionMenu';
import { containsPath, directoryName, sourceState, type CatalogView } from '../shared/directories';

const localGet = (key: string, fallback: string) => localStorage.getItem(key) || fallback;
type DirectoryDialog =
  | { action: 'create'; parentPath: string }
  | { action: 'rename'; directory: Directory }
  | { action: 'trash'; directory: Directory }
  | { action: 'trashFile'; file: Source };

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [locale, setLocale] = useState<Locale>(() => localGet('tl:locale', 'en') as Locale),
    [session, setSession] = useState<StudySession | null>(null);
  const [annotationRequest, setAnnotationRequest] = useState<AnnotationRequest | null>(null);
  const [conceptSuggestionsOpen, setConceptSuggestionsOpen] = useState(false);
  const [glossaryFocus, setGlossaryFocus] = useState<{ id: string; nonce: string } | null>(null);
  const [annotationTick, setAnnotationTick] = useState(0);
  const [bookmarkTick, setBookmarkTick] = useState(0);
  const [bookmarkIntent, setBookmarkIntent] = useState<BookmarkIntent | null>(null);
  const [bookmarkFilter, setBookmarkFilter] = useState<BookmarkFilter>(() => {
    const value = localGet('tl:bookmark-filter', 'all');
    return value === 'manual' || value === 'tutor' ? value : 'all';
  });
  const [questionRequest, setQuestionRequest] = useState<{
    id: string;
    context: QuestionContext;
    prompt?: string;
  } | null>(null);
  const [selection, setSelection] = useState<{ sourceId: string; location: SourceLocation } | null>(
    null,
  );
  const panels = usePanels();
  const left = panels.effective.left.open,
    right = panels.effective.right.open;
  const setLeft = (value: boolean) => panels.open('left', value);
  const setRight = (value: boolean) => panels.open('right', value);
  const leftPanelRef = useRef<HTMLElement>(null),
    rightPanelRef = useRef<HTMLElement>(null);
  const [focus, setFocus] = useState(false),
    [tab, setTab] = useState<StudyTab>('chapters'),
    [query, setQuery] = useState(''),
    [catalogView, setCatalogView] = useState<CatalogView>('files');
  const [renamingSession, setRenamingSession] = useState<StudySession | null>(null);
  const [directoryDialog, setDirectoryDialog] = useState<DirectoryDialog | null>(null);
  const [uploadDirectoryId, setUploadDirectoryId] = useState<string | null>(null);
  const [returnToSplit, setReturnToSplit] = useState(false);
  const [splitRequest, setSplitRequest] = useState<{
    mode: 'new' | 'replace';
    sourceId: string;
    tabId: string | null;
  } | null>(null);
  const [splitQuery, setSplitQuery] = useState('');
  useDrawerFocus('left', !!catalog && !focus && panels.drawer === 'left', leftPanelRef, () =>
    setLeft(false),
  );
  useDrawerFocus('right', !!catalog && !focus && panels.drawer === 'right', rightPanelRef, () =>
    setRight(false),
  );
  const [modal, setModal] = useState<'settings' | 'upload' | 'session' | 'rename' | 'split' | null>(
      null,
    ),
    [rename, setRename] = useState<Source | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [learningState, setLearning] = useState<PublicLearning | null>(null),
    [jobState, setJob] = useState<(Job & { segments?: Segment[] }) | null>(null),
    [seek, setSeek] = useState<{ sourceId: string; value: number; nonce: number } | null>(null),
    [evidence, setEvidence] = useState<{ sourceId: string; segment: Segment } | null>(null),
    [artifact, setArtifact] = useState<string | false>(false),
    [refreshTick, setRefreshTick] = useState(0);
  const sessionRef = useRef(session),
    saveChain = useRef(Promise.resolve()),
    t = dictionaries[locale] || dictionaries.en;
  const materialCache = useRef<Record<string, PublicLearning | null>>({});
  const usable = (value: StudySession, data = catalog) =>
    visibleWorkspace(
      readWorkspace(value),
      new Set(
        (data?.files || [])
          .filter((file) => sourceState(file, data?.directories || []) !== 'trash')
          .map((file) => file.id),
      ),
    );
  const resources = session ? usable(session) : { resourceTabs: [], activeTabId: null };
  const activeResourceTab = resources.resourceTabs.find(
    (item) => item.id === resources.activeTabId,
  );
  useEffect(() => {
    if (activeResourceTab?.sources.length === 2) panels.enterSplit();
  }, [session?.id, activeResourceTab?.id]);
  const primary = catalog?.files.find((file) => file.id === activeResourceTab?.sources[0]) || null;
  const split = catalog?.files.find((file) => file.id === activeResourceTab?.sources[1]) || null;
  const targetId =
    activeResourceTab?.focusedSource &&
    activeResourceTab.sources.includes(activeResourceTab.focusedSource)
      ? activeResourceTab.focusedSource
      : primary?.id;
  const active = catalog?.files.find((file) => file.id === targetId) || null;
  const savedBookmarks = useBookmarks(
    session?.id,
    resources.resourceTabs.flatMap((tab) => tab.sources),
    bookmarkTick,
    setError,
  );
  const activeBookmarks = savedBookmarks.filter((item) => item.sourceId === active?.id);
  const learning = learningState?.sourceId === active?.id ? learningState : null;
  const job = jobState?.sourceId === active?.id ? jobState : null;
  const run = async (work: () => Promise<void>) => {
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : t.error);
    }
  };
  async function refresh() {
    const value = await api<Catalog>('/catalog');
    setCatalog(value);
    setBookmarkTick((value) => value + 1);
    return value;
  }
  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem('tl:locale', locale);
  }, [locale]);
  useEffect(() => {
    void run(async () => {
      const data = await refresh();
      setLocale(data.settings.locale);
      let selected =
        data.sessions.find((s) => s.id === localGet('tl:session', '')) || data.sessions[0];
      if (!selected) {
        selected = await api<StudySession>('/sessions', 'POST', {
          name: dictionaries[data.settings.locale].sessionName,
        });
        setCatalog((c) => (c ? { ...c, sessions: [...c.sessions, selected] } : c));
      }
      setSession(selected);
      sessionRef.current = selected;
      localStorage.setItem('tl:session', selected.id);
      if (!data.settings.configured && !localStorage.getItem('tl:explored')) setModal('settings');
    });
  }, []);
  function updateSession(update: Partial<StudySession>) {
    if (!sessionRef.current) return;
    const value = { ...sessionRef.current, ...update };
    sessionRef.current = value;
    setSession(value);
    setCatalog((c) =>
      c ? { ...c, sessions: c.sessions.map((s) => (s.id === value.id ? value : s)) } : c,
    );
    saveChain.current = saveChain.current
      .catch(() => {})
      .then(async () => {
        await api(`/sessions/${value.id}`, 'PUT', value);
      })
      .catch((e) => setError(e.message));
  }
  function selectSession(value: StudySession) {
    setQuestionRequest(null);
    setSelection(null);
    if (sessionRef.current && value.id !== sessionRef.current.id) {
      const positions = { ...sessionRef.current.positions };
      for (const pane of document.querySelectorAll<HTMLElement>('[data-source-id]')) {
        const player = pane.querySelector<HTMLMediaElement>('audio,video');
        if (
          player &&
          player.readyState > 0 &&
          pane.dataset.sourceId &&
          Number.isFinite(player.currentTime)
        )
          positions[pane.dataset.sourceId] = player.currentTime;
      }
      updateSession({ positions });
    }
    sessionRef.current = value;
    setSession(value);
    localStorage.setItem('tl:session', value.id);
    setArtifact(false);
    setLearning(null);
    setSeek(null);
  }
  function commitWorkspace(next: ResourceWorkspace) {
    if (next.resourceTabs.length > MAX_RESOURCE_TABS) {
      setError(t.tabLimit);
      return;
    }
    updateSession(workspacePatch(next));
  }
  function openFile(file: Source, mode: 'preview' | 'retain' = 'preview') {
    if (!sessionRef.current) return;
    commitWorkspace(openResource(usable(sessionRef.current), file.id, mode));
    setArtifact(false);
    setSeek(null);
    if (panels.drawer === 'left') setLeft(false);
  }
  function closeFile(id: string) {
    if (!sessionRef.current) return;
    const current = usable(sessionRef.current);
    commitWorkspace(closeResourceTab(current, id));
    if (current.activeTabId === id) {
      setArtifact(false);
      setSeek(null);
    }
  }
  function selectResourceTab(id: string) {
    if (!sessionRef.current) return;
    commitWorkspace({ ...usable(sessionRef.current), activeTabId: id });
    setArtifact(false);
    setSeek(null);
  }
  function keepResourceTab(id: string) {
    if (sessionRef.current) commitWorkspace(retainTab(usable(sessionRef.current), id));
  }
  function closeSplit() {
    if (sessionRef.current) commitWorkspace(unsplit(usable(sessionRef.current)));
    setArtifact(false);
  }
  function showSplitPicker() {
    if (!active) return;
    setSplitRequest({
      mode: split ? 'replace' : 'new',
      sourceId: active.id,
      tabId: resources.activeTabId,
    });
    setSplitQuery('');
    setModal('split');
  }
  function focusPane(sourceId: string) {
    if (!sessionRef.current || active?.id === sourceId) return;
    commitWorkspace(focusSource(usable(sessionRef.current), sourceId));
  }
  useEffect(() => {
    setLearning(null);
    setJob(null);
    setEvidence((previous) => (previous?.sourceId === active?.id ? previous : null));
    if (!active) return;
    let stopped = false;
    const load = async () => {
      try {
        const [material, current] = await Promise.all([
          api<PublicLearning | null>(`/learning/${active.id}`),
          api<(Job & { segments?: Segment[] }) | null>(
            `/jobs/${active.id}-v${active.version}-${locale}`,
          ),
        ]);
        if (!stopped) {
          materialCache.current[active.id] = material;
          setLearning(material);
          setJob(current);
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : t.error);
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, 2500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [active?.id, locale, refreshTick]);
  async function prepare() {
    if (!active) return;
    if (!catalog?.settings.configured) {
      setModal('settings');
      return;
    }
    setBusy(true);
    try {
      const current = await api<Job>('/jobs', 'POST', { sourceId: active.id, locale });
      setJob(current);
      setRefreshTick((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }
  async function editFile(file: Source, update: Partial<Source>) {
    const result = await api<Source>(`/files/${file.id}`, 'PATCH', update);
    setCatalog((c) =>
      c ? { ...c, files: c.files.map((f) => (f.id === file.id ? result : f)) } : c,
    );
  }
  async function addFiles(files: File[], folder: string, directoryId?: string) {
    setBusy(true);
    try {
      for (const file of files) {
        if (!kindFor(file.name)) throw new Error(`${t.unsupported}: ${file.name}`);
        if (file.size > MAX_FILE_BYTES) throw new Error(t.maxSize);
        setUploadProgress(0);
        const source = await uploadFile(file, folder, setUploadProgress, directoryId);
        setCatalog((c) => (c ? { ...c, files: [...c.files, source] } : c));
        openFile(source, 'retain');
      }
      await saveChain.current;
      await refresh();
      setModal(returnToSplit ? 'split' : null);
      setReturnToSplit(false);
    } finally {
      setBusy(false);
      setUploadProgress(null);
    }
  }
  async function example() {
    const text =
      locale === 'es'
        ? '# Muestreo y señales\n\nUna señal continua se representa con muestras discretas. La frecuencia de muestreo indica cuántas muestras se toman cada segundo.\n\n## El límite de Nyquist\n\nPara representar una frecuencia de 8 Hz se necesita una frecuencia de muestreo superior a 16 Hz. Si se toman 12 muestras por segundo, la señal puede confundirse con una de 4 Hz: ese fenómeno se llama aliasing.\n\n## Explora\n\nAbre el explorador de señales y cambia las frecuencias. Los puntos ámbar son muestras; la curva verde es la señal original. Este ejemplo es sintético y no representa datos clínicos.'
        : '# Sampling and signals\n\nA continuous signal can be represented with discrete samples. The sampling frequency tells us how many samples are collected each second.\n\n## The Nyquist limit\n\nTo represent an 8 Hz signal, the sampling frequency must exceed 16 Hz. At 12 samples per second, that signal can appear to be 4 Hz. This ambiguity is called aliasing.\n\n## Explore it\n\nOpen the signal explorer and change the frequencies. Amber points are samples; the teal curve is the original signal. This authored example is synthetic and contains no clinical data.';
    await addFiles(
      [new File([text], `${t.example}.md`, { type: 'text/markdown' })],
      locale === 'es' ? 'Ejemplos' : 'Examples',
    );
  }
  async function directoryMutation(
    directory: Directory,
    action: 'archive' | 'unarchive' | 'trash' | 'restore' | 'rename',
    name?: string,
  ) {
    await api(`/directories/${directory.id}`, 'PATCH', { action, ...(name ? { name } : {}) });
    await saveChain.current;
    const data = await refresh();
    if (sessionRef.current) commitWorkspace(usable(sessionRef.current, data));
    if (splitRequest) {
      const base = data.files.find((file) => file.id === splitRequest.sourceId);
      if (!base || sourceState(base, data.directories) === 'trash') {
        setSplitRequest(null);
        setReturnToSplit(false);
        if (modal === 'split') setModal(null);
      }
    }
  }
  function showUpload(directoryId: string | null = null) {
    setUploadDirectoryId(directoryId);
    setReturnToSplit((current) => modal === 'split' || (modal === 'upload' && current));
    setModal('upload');
  }
  const treeActions: TreeActions = {
    create: (parentPath) => setDirectoryDialog({ action: 'create', parentPath }),
    renameDirectory: (directory) => setDirectoryDialog({ action: 'rename', directory }),
    archiveDirectory: (directory, restore) =>
      void run(() => directoryMutation(directory, restore ? 'unarchive' : 'archive')),
    trashDirectory: (directory) => setDirectoryDialog({ action: 'trash', directory }),
    restoreDirectory: (directory) => void run(() => directoryMutation(directory, 'restore')),
    upload: (directory) => showUpload(directory.id),
    renameFile: (file) => {
      setRename(file);
      setModal('rename');
    },
    archiveFile: (file, restore) => void run(() => editFile(file, { archived: !restore })),
    trashFile: (file) => setDirectoryDialog({ action: 'trashFile', file }),
    restoreFile: (file) => void run(() => editFile(file, { trashed: false })),
  };
  const position = active ? session?.positions[active.id] || 0 : 0;
  function resourceLocation(source: Source): SourceLocation {
    if (selection?.sourceId === source.id) return selection.location;
    const position = sessionRef.current?.positions[source.id] || 0;
    return source.kind === 'pdf'
      ? { page: Math.max(1, Math.round(position) || 1) }
      : ['audio', 'video'].includes(source.kind)
        ? { seconds: position }
        : {};
  }
  function askAbout(source: Source) {
    setQuestionRequest({
      id: crypto.randomUUID(),
      context: {
        sourceId: source.id,
        sourceVersion: source.version,
        sourceName: source.name,
        location: resourceLocation(source),
      },
    });
    setRight(true);
    setTab('assistant');
  }
  async function beginAnnotation(
    sourceId: string | null,
    location: SourceLocation = {},
    capture = false,
    markdown?: string,
    references?: string[],
  ) {
    const file = catalog?.files.find((file) => file.id === sourceId) || null;
    if (sourceId && (!file || sourceState(file, catalog?.directories || []) === 'trash')) {
      setError(t.sourceUnavailable);
      return;
    }
    const image = capture && file ? await captureSource(file, location) : undefined;
    if (capture && file && ['pdf', 'video', 'image'].includes(file.kind) && !image) {
      setError(t.captureNotReady);
      return;
    }
    setAnnotationRequest({
      id: crypto.randomUUID(),
      sourceId,
      location,
      ...(image ? { capture: image } : {}),
      ...(markdown ? { markdown, origin: 'tutor' as const } : {}),
      ...(references ? { references } : {}),
    });
  }
  function navigateAnnotation(sourceId: string, location: SourceLocation, label = 'annotation') {
    citeFrom(sourceId, {
      id: label,
      text: location.quote || '',
      ...(location.page ? { page: location.page } : {}),
      ...(location.seconds != null ? { start: location.seconds } : {}),
    });
  }
  function cite(segment: Segment) {
    if (!active) return;
    citeFrom(active.id, segment);
  }
  function citeFrom(sourceId: string, segment: Segment) {
    if (!activeResourceTab?.sources.includes(sourceId)) {
      const file = catalog?.files.find((item) => item.id === sourceId);
      if (!file || sourceState(file, catalog?.directories || []) === 'trash') {
        setError(t.evidenceUnavailable);
        return;
      }
      openFile(file, 'retain');
    } else focusPane(sourceId);
    setEvidence({ sourceId, segment });
    if (segment.start != null || segment.page != null) {
      setSeek({ sourceId, value: segment.start ?? segment.page ?? 0, nonce: Date.now() });
      setArtifact(false);
    }
    setArtifact(false);
  }
  if (!catalog || !session)
    return (
      <div className="loading">
        <BookOpen />
        <p>{error || t.loading}</p>
        {error && <Button onClick={() => location.reload()}>{t.retry}</Button>}
      </div>
    );
  return (
    <div
      className={`app ${focus ? 'focus' : ''}`}
      style={
        {
          '--panel-width': `${panels.resolved.left.width}px`,
          '--study-width': `${panels.resolved.right.width}px`,
        } as CSSProperties
      }
    >
      <aside
        id="left-panel"
        ref={leftPanelRef}
        aria-label={t.library}
        hidden={!left || focus}
        inert={!!panels.drawer && panels.drawer !== 'left'}
        className={`library-panel ${panels.resolved.left.docked ? 'docked' : 'floating'}`}
        role={panels.drawer === 'left' ? 'dialog' : undefined}
        aria-modal={panels.drawer === 'left' ? true : undefined}
      >
        <div className="brand">
          <div>
            <strong>{t.catalogTitle}</strong>
            <span>{t.local}</span>
          </div>
          <IconButton
            label={panels.preferences.left.pinned ? t.unpinPanel : t.pinPanel}
            aria-pressed={panels.preferences.left.pinned}
            onClick={() => panels.pin('left')}
          >
            {panels.preferences.left.pinned ? <Pin /> : <PinOff />}
          </IconButton>
          <IconButton
            label={panels.drawer === 'left' ? t.backToSession : t.hideFiles}
            onClick={() => setLeft(false)}
          >
            <PanelLeft />
          </IconButton>
        </div>
        <div className="library-search">
          <Search size={15} />
          <input
            aria-label={t.search}
            placeholder={t.search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="library-actions">
          <Button onClick={() => showUpload()}>
            <Plus size={15} />
            {t.upload}
          </Button>
          <IconButton label={t.newFolder} onClick={() => treeActions.create('')}>
            <FolderPlus />
          </IconButton>
          <IconButton label={t.settings} onClick={() => setModal('settings')}>
            <SettingsIcon />
          </IconButton>
        </div>
        <div className="catalog-switch">
          <button
            className={catalogView === 'files' ? 'selected' : ''}
            onClick={() => setCatalogView('files')}
          >
            {t.files}
            <span>
              {catalog.files.filter((f) => sourceState(f, catalog.directories) === 'files').length}
            </span>
          </button>
          <button
            className={catalogView === 'archived' ? 'selected' : ''}
            onClick={() => setCatalogView('archived')}
          >
            <Archive size={13} />
            {t.archived}
            <span>
              {
                catalog.files.filter((f) => sourceState(f, catalog.directories) === 'archived')
                  .length
              }
            </span>
          </button>
          <button
            className={catalogView === 'trash' ? 'selected' : ''}
            onClick={() => setCatalogView('trash')}
          >
            <Trash2 size={13} />
            {t.trash}
            <span>
              {catalog.files.filter((f) => sourceState(f, catalog.directories) === 'trash').length}
            </span>
          </button>
        </div>
        <div className="file-tree">
          <DirectoryTree
            directories={catalog.directories}
            files={catalog.files}
            t={t}
            active={active?.id}
            view={catalogView}
            query={query}
            chooseFile={openFile}
            actions={treeActions}
            storageKey="tl:tree:sidebar"
          />
        </div>
        <div className="sessions-heading">
          <span>{t.sessions}</span>
          <IconButton label={t.newSession} onClick={() => setModal('session')}>
            <Plus />
          </IconButton>
        </div>
        <div className="session-list">
          {[...catalog.sessions]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .map((item) => {
              const preview = sessionPreview(item, catalog.files, catalog.conversations);
              return (
                <div
                  className={`session-entry ${item.id === session.id ? 'active' : ''}`}
                  key={item.id}
                >
                  <button
                    className="session-row"
                    aria-current={item.id === session.id ? 'true' : undefined}
                    onClick={() => selectSession(item)}
                  >
                    <BookOpen size={15} />
                    <span>
                      <span>{item.name}</span>
                      <small title={preview.source?.name}>
                        {preview.source?.name || t.noOpenResources}
                      </small>
                      <small>
                        {preview.count} {t.messages}
                      </small>
                    </span>
                    <ChevronRight size={13} />
                  </button>
                  <ActionMenu
                    label={`${t.sessionOptions}: ${item.name}`}
                    actions={[{ label: t.renameSession, run: () => setRenamingSession(item) }]}
                  />
                </div>
              );
            })}
        </div>
        <div className="sidebar-foot">
          <span className={`connection-dot ${catalog.settings.configured ? 'connected' : ''}`} />
          <button onClick={() => setModal('settings')}>
            {catalog.settings.configured ? t.configured : t.notConfigured}
          </button>
          <span className="language-pill">{locale.toUpperCase()}</span>
        </div>
      </aside>
      {left && !focus && panels.resolved.left.docked && (
        <PanelResizer
          side="left"
          label={t.filePanelWidth}
          help={t.resizeHelp}
          width={panels.resolved.left.width}
          max={panels.resolved.left.max}
          change={(value) => panels.resize('left', value)}
        />
      )}
      {panels.drawer && !focus && (
        <button
          className="drawer-backdrop"
          tabIndex={-1}
          aria-label={t.dismissPanels}
          onClick={() => panels.open(panels.drawer!, false)}
        />
      )}
      <main className="workspace" inert={!!panels.drawer && !focus}>
        <div className="resource-tabs">
          <IconButton
            label={left ? t.hideFiles : t.openFiles}
            aria-controls="left-panel"
            aria-expanded={left && !focus}
            data-panel-toggle="left"
            onClick={() => setLeft(!left)}
          >
            <PanelLeft />
          </IconButton>
          <ResourceTabs
            workspace={resources}
            files={catalog.files}
            t={t}
            select={selectResourceTab}
            keep={keepResourceTab}
            close={closeFile}
          />
          <IconButton label={t.newSession} onClick={() => setModal('session')}>
            <Plus />
          </IconButton>
          <IconButton
            label={t.study}
            aria-expanded={right && !focus}
            aria-controls="right-panel"
            data-panel-toggle="right"
            onClick={() => setRight(!right)}
          >
            <PanelRight />
          </IconButton>
        </div>
        {error && (
          <div role="alert" className="error-bar">
            <CircleHelp size={16} />
            <span>{error}</span>
            <IconButton label={t.close} onClick={() => setError('')}>
              <X />
            </IconButton>
          </div>
        )}
        {!active ? (
          <Empty icon={<BookOpen />} title={t.welcome} description={t.welcomeBody}>
            <div className="welcome-actions">
              <Button
                onClick={() => {
                  setLeft(true);
                  if (!catalog.files.length) showUpload();
                }}
              >
                <Folder size={18} />
                {t.exploreFiles}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setTab('assistant');
                  setRight(true);
                }}
              >
                <MessageSquare size={18} />
                {t.startConversation}
              </Button>
            </div>
          </Empty>
        ) : (
          <>
            <div className="file-toolbar">
              <div className="file-title">
                <span>{active.folder || t.library}</span>
                {split ? (
                  <select
                    className="pane-target"
                    aria-label={t.toolsTarget}
                    value={active.id}
                    onChange={(event) => focusPane(event.target.value)}
                  >
                    {[primary!, split].map((source) => (
                      <option key={source.id} value={source.id}>
                        {source.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <strong title={active.name}>{active.name}</strong>
                )}
              </div>
              <div className="reader-commands">
                <div className="toolbar-actions" aria-label={t.resourceTools}>
                  <IconButton
                    label={t.addBookmark}
                    onClick={() =>
                      setBookmarkIntent({ source: active, location: resourceLocation(active) })
                    }
                  >
                    <Bookmark />
                  </IconButton>
                  <IconButton
                    label={t.notes}
                    onClick={() => {
                      setRight(true);
                      setTab('notes');
                    }}
                  >
                    <StickyNote />
                  </IconButton>
                  <IconButton
                    label={t.annotateResource}
                    onClick={() =>
                      void run(() => beginAnnotation(active.id, resourceLocation(active), true))
                    }
                  >
                    <Pencil />
                  </IconButton>
                  <IconButton
                    label={t.conceptSuggestions}
                    onClick={() => setConceptSuggestionsOpen(true)}
                  >
                    <Lightbulb />
                  </IconButton>
                  <IconButton label={t.askTutor} onClick={() => askAbout(active)}>
                    <MessageSquare />
                  </IconButton>
                  <IconButton label={split ? t.replaceResource : t.split} onClick={showSplitPicker}>
                    {split ? <FolderOpen /> : <Columns2 />}
                  </IconButton>
                  {split && (
                    <IconButton
                      label={t.swapPanes}
                      onClick={() => {
                        if (sessionRef.current)
                          commitWorkspace(swapSplit(usable(sessionRef.current)));
                      }}
                    >
                      <ArrowLeftRight />
                    </IconButton>
                  )}
                  {split && (
                    <IconButton label={t.noSplit} onClick={closeSplit}>
                      <X />
                    </IconButton>
                  )}
                  <IconButton
                    label={active.reviewed ? t.reviewed : t.markReviewed}
                    aria-pressed={active.reviewed}
                    onClick={() => void run(() => editFile(active, { reviewed: !active.reviewed }))}
                  >
                    <Check />
                  </IconButton>
                  <a
                    className="button icon-button button-ghost"
                    href={`/api/files/${active.id}/content`}
                    download={active.name}
                    title={t.download}
                    aria-label={t.download}
                  >
                    <Download size={16} />
                  </a>
                </div>
                <div className="focus-action">
                  <IconButton
                    label={focus ? t.unfocus : t.focus}
                    onClick={() => setFocus((v) => !v)}
                  >
                    {focus ? <Minimize2 /> : <Maximize2 />}
                  </IconButton>
                </div>
              </div>
            </div>
            {job && (
              <div className={`job-strip ${job.status === 'failed' ? 'failed' : ''}`} role="status">
                {['queued', 'running', 'partial'].includes(job.status) ? (
                  <LoaderCircle className="spin" size={14} />
                ) : (
                  <Check size={14} />
                )}
                <span>
                  {
                    t[
                      (
                        {
                          queued: 'jobQueued',
                          running: 'jobRunning',
                          partial: 'jobPartial',
                          completed: 'jobCompleted',
                          failed: 'jobFailed',
                          cancelled: 'jobCancelled',
                        } as const
                      )[job.status]
                    ]
                  }{' '}
                  · {t[job.stage]}
                  {job.totalChunks > 0 ? ` · ${job.completedChunks}/${job.totalChunks}` : ''}
                </span>
                {job.error && <span>{job.error}</span>}
                {['failed', 'cancelled'].includes(job.status) ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void run(async () => {
                        await api(`/jobs/${job.id}`, 'POST');
                        setRefreshTick((v) => v + 1);
                      })
                    }
                  >
                    {t.retry}
                  </Button>
                ) : (
                  job.status !== 'completed' && (
                    <Button
                      variant="ghost"
                      onClick={() =>
                        void run(async () => {
                          await api(`/jobs/${job.id}`, 'DELETE');
                          setRefreshTick((v) => v + 1);
                        })
                      }
                    >
                      {t.cancel}
                    </Button>
                  )
                )}
              </div>
            )}
            <div
              id="resource-view"
              role="tabpanel"
              aria-labelledby={
                activeResourceTab ? `resource-tab-${activeResourceTab.id}` : undefined
              }
              className="viewers"
            >
              <SplitWorkspace
                key={`${session.id}:${activeResourceTab?.id}`}
                sources={[primary!, ...(split ? [split] : [])]}
                focused={active.id}
                ratio={activeResourceTab?.splitRatio ?? 0.5}
                focus={focusPane}
                resize={(ratio) => {
                  if (sessionRef.current)
                    commitWorkspace(resizeSplit(usable(sessionRef.current), ratio));
                }}
                t={t}
              >
                {(source) => {
                  const material =
                    learning?.sourceId === source.id ? learning : materialCache.current[source.id];
                  return (
                    <>
                      {evidence?.sourceId === source.id && (
                        <section className="evidence-panel" aria-label={t.sources}>
                          <div>
                            <strong>
                              {t.source} · {evidence.segment.id}
                            </strong>
                            <IconButton label={t.close} onClick={() => setEvidence(null)}>
                              <X />
                            </IconButton>
                          </div>
                          <p>{evidence.segment.text}</p>
                        </section>
                      )}
                      {artifact === source.id ? (
                        <div className="artifact-stage">
                          <Button variant="ghost" onClick={() => setArtifact(false)}>
                            <ArrowLeft size={14} />
                            {t.originalSource}
                          </Button>
                          {material?.synthesis.artifact ? (
                            <GeneratedArtifact
                              artifact={material.synthesis.artifact}
                              t={t}
                              segments={material.segments}
                              onCite={(segment) => citeFrom(source.id, segment)}
                              saved={session.artifacts?.[source.id]}
                              persist={(value) =>
                                updateSession({
                                  artifacts: {
                                    ...sessionRef.current!.artifacts,
                                    [source.id]: value,
                                  },
                                })
                              }
                            />
                          ) : (
                            <SignalExplorer
                              key={source.id}
                              t={t}
                              storageKey={`tl:signal:${session.id}:${source.id}`}
                              initial={session.artifacts?.[source.id]}
                              onPersist={(value) =>
                                updateSession({
                                  artifacts: {
                                    ...sessionRef.current!.artifacts,
                                    [source.id]: value,
                                  },
                                })
                              }
                            />
                          )}
                        </div>
                      ) : (
                        <Viewer
                          source={source}
                          bookmarks={savedBookmarks
                            .filter(
                              (bookmark) =>
                                bookmark.sourceId === source.id &&
                                !bookmark.deleted &&
                                (bookmarkFilter === 'all' || bookmark.origin === bookmarkFilter),
                            )
                            .map((bookmark) => ({
                              id: bookmark.id,
                              sourceId: source.id,
                              label: bookmark.title,
                              ...(bookmark.location.page ? { page: bookmark.location.page } : {}),
                              ...(bookmark.location.seconds != null
                                ? { seconds: bookmark.location.seconds }
                                : {}),
                            }))}
                          t={t}
                          learning={material || null}
                          sessionId={session.id}
                          annotationTick={annotationTick}
                          onSelection={(location) =>
                            setSelection({ sourceId: source.id, location })
                          }
                          position={session.positions[source.id] || 0}
                          onPosition={(value) => {
                            if (source.kind === 'pdf')
                              setSelection((current) =>
                                current?.sourceId === source.id && current.location.page !== value
                                  ? null
                                  : current,
                              );
                            if (sessionRef.current?.id === session.id)
                              updateSession({
                                positions: { ...sessionRef.current.positions, [source.id]: value },
                              });
                          }}
                          seek={seek?.sourceId === source.id ? seek : null}
                        />
                      )}
                    </>
                  );
                }}
              </SplitWorkspace>
              <ResourceConceptSuggestions
                key={`${active.id}:${active.version}`}
                source={active}
                preparedAt={learning?.createdAt || ''}
                location={resourceLocation(active)}
                open={conceptSuggestionsOpen}
                setOpen={setConceptSuggestionsOpen}
                catalog={catalog}
                t={t}
                changed={refresh}
                prepare={() => void run(prepare)}
                navigate={(id, location) => {
                  setConceptSuggestionsOpen(false);
                  navigateAnnotation(id, location, t.conceptSuggestions);
                }}
                followup={(prompt, location) => {
                  setConceptSuggestionsOpen(false);
                  setQuestionRequest({
                    id: crypto.randomUUID(),
                    context: {
                      sourceId: active.id,
                      sourceVersion: active.version,
                      sourceName: active.name,
                      location,
                    },
                    prompt,
                  });
                  setRight(true);
                  setTab('assistant');
                }}
                openConcept={(id) => {
                  setConceptSuggestionsOpen(false);
                  setGlossaryFocus({ id, nonce: crypto.randomUUID() });
                  setRight(true);
                  setTab('glossary');
                }}
              />
            </div>
          </>
        )}
        <div className="workspace-foot">
          <span>{session.name}</span>
          <span>
            <span className="connection-dot connected" />
            {t.local}
          </span>
        </div>
      </main>
      {right && !focus && panels.resolved.right.docked && (
        <PanelResizer
          side="right"
          label={t.studyPanelWidth}
          help={t.resizeHelp}
          width={panels.resolved.right.width}
          max={panels.resolved.right.max}
          change={(value) => panels.resize('right', value)}
        />
      )}
      <aside
        id="right-panel"
        ref={rightPanelRef}
        aria-label={t.study}
        hidden={!right || focus}
        inert={!!panels.drawer && panels.drawer !== 'right'}
        className={`study-panel ${panels.resolved.right.docked ? 'docked' : 'floating'}`}
        role={panels.drawer === 'right' ? 'dialog' : undefined}
        aria-modal={panels.drawer === 'right' ? true : undefined}
      >
        <div className="study-heading">
          <span>{t.study}</span>
          <div className="panel-heading-actions">
            <IconButton
              label={panels.preferences.right.pinned ? t.unpinPanel : t.pinPanel}
              aria-pressed={panels.preferences.right.pinned}
              onClick={() => panels.pin('right')}
            >
              {panels.preferences.right.pinned ? <Pin /> : <PinOff />}
            </IconButton>
            <IconButton
              label={panels.drawer === 'right' ? t.backToSession : t.close}
              onClick={() => setRight(false)}
            >
              <X />
            </IconButton>
          </div>
        </div>
        <StudyTabs
          value={tab}
          change={setTab}
          t={t}
          bookmarkCount={activeBookmarks.filter((bookmark) => !bookmark.deleted).length}
        />
        {active && (
          <div className="study-resource" aria-label={t.activeResource}>
            <FileText size={15} />
            <span title={active.name}>{active.name}</span>
          </div>
        )}
        <div
          id="study-content"
          role="tabpanel"
          aria-labelledby={`study-tab-${tab}`}
          className="study-content"
        >
          <div hidden={tab !== 'glossary'} className="glossary-host">
            <GlossaryPanel
              focusRequest={glossaryFocus}
              catalog={catalog}
              source={active}
              openSourceIds={resources.resourceTabs.flatMap((tab) => tab.sources)}
              t={t}
              actions={treeActions}
              changed={refresh}
              navigate={(id, location) => navigateAnnotation(id, location, t.glossary)}
              onError={setError}
            />
          </div>
          {tab === 'glossary' ? null : tab === 'assistant' ? (
            <ConversationPanel
              key={session.id}
              sessionId={session.id}
              source={active}
              catalog={catalog}
              t={t}
              onError={setError}
              changed={refresh}
              cite={citeFrom}
              treeActions={treeActions}
              questionRequest={questionRequest}
              consumeQuestion={() => setQuestionRequest(null)}
              annotate={(content, ids, context) => {
                if (
                  context &&
                  catalog.files.find((file) => file.id === context.sourceId)?.version !==
                    context.sourceVersion
                ) {
                  setError(t.sourceUnavailable);
                  return;
                }
                void run(() =>
                  beginAnnotation(
                    context?.sourceId || (ids.length === 1 ? ids[0] : null),
                    context?.location || {},
                    false,
                    content,
                    ids,
                  ),
                );
              }}
            />
          ) : tab === 'notes' ? (
            <AnnotationsPanel
              key={session.id}
              sessionId={session.id}
              openSourceIds={[...new Set(resources.resourceTabs.flatMap((tab) => tab.sources))]}
              source={active}
              catalog={catalog}
              t={t}
              tick={annotationTick}
              actions={treeActions}
              create={() =>
                void run(() =>
                  beginAnnotation(active?.id || null, active ? resourceLocation(active) : {}),
                )
              }
              edit={(value) =>
                setAnnotationRequest({
                  id: value.id,
                  sourceId: value.sourceId,
                  location: value.location,
                  initial: value,
                })
              }
              navigate={navigateAnnotation}
              onError={setError}
            />
          ) : !active ? (
            <div className="small-empty">
              <BookOpen size={24} />
              <p>{t.noSelectionBody}</p>
            </div>
          ) : (
            <>
              {tab === 'chapters' && (
                <>
                  <div className="section-label">
                    {t.chapters}
                    {learning && <Badge>{learning.synthesis.chapters.length}</Badge>}
                  </div>
                  {!learning ? (
                    <div className="prepare-card">
                      <div className="prepare-symbol">
                        <Sparkles />
                      </div>
                      <h3>{t.process}</h3>
                      <p>{t.noChapters}</p>
                      <Button
                        variant="primary"
                        disabled={
                          busy || (!!job && ['queued', 'running', 'partial'].includes(job.status))
                        }
                        onClick={() => void run(prepare)}
                      >
                        {busy ? (
                          <LoaderCircle className="spin" size={14} />
                        ) : (
                          <Sparkles size={14} />
                        )}{' '}
                        {t.process}
                      </Button>
                      <small>{t.processingNotice}</small>
                    </div>
                  ) : (
                    learning.synthesis.chapters.map((chapter, i) => (
                      <section className="chapter-card" key={chapter.id}>
                        <button
                          className="chapter-title"
                          onClick={() => {
                            const segment = learning.segments.find(
                              (s) => s.id === chapter.segmentIds[0],
                            );
                            if (segment) cite(segment);
                          }}
                        >
                          <span>{String(i + 1).padStart(2, '0')}</span>
                          <strong>{chapter.title}</strong>
                        </button>
                        <p>{chapter.summary}</p>
                        <Citations
                          ids={chapter.segmentIds}
                          segments={learning.segments}
                          onCite={cite}
                          t={t}
                        />
                        <Button variant="ghost" onClick={() => setTab('practice')}>
                          <GraduationCap size={13} />
                          {t.quiz}
                        </Button>
                      </section>
                    ))
                  )}
                  {job?.segments?.length && !learning ? (
                    <details className="transcript">
                      <summary>{t.showTranscript}</summary>
                      {job.segments.map((s) => (
                        <button key={s.id} onClick={() => cite(s)}>
                          {s.start != null && <span>{formatPosition(s.start)}</span>}
                          {s.text}
                        </button>
                      ))}
                    </details>
                  ) : null}
                  {['video', 'audio'].includes(active.kind) && job && job.completedChunks > 0 && (
                    <div className="caption-downloads">
                      {(['original', 'translated'] as const).map((track) => (
                        <div key={track}>
                          <span>{t[track]}</span>
                          {['vtt', 'srt'].map((format) => (
                            <a
                              key={format}
                              href={`/api/captions/${active.id}/${track}.${format}`}
                              download={`${active.name}.${track}.${format}`}
                            >
                              {format.toUpperCase()}
                            </a>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  <button className="artifact-link" onClick={() => setArtifact(active.id)}>
                    <span>
                      <Activity size={17} />
                      <strong>{t.artifact}</strong>
                    </span>
                    <p>{t.artifactBody}</p>
                    <span className="text-link">
                      {t.open}
                      <ChevronRight size={13} />
                    </span>
                  </button>
                </>
              )}
              {tab === 'bookmarks' && (
                <BookmarksPanel
                  items={activeBookmarks}
                  filter={bookmarkFilter}
                  changeFilter={(value) => {
                    setBookmarkFilter(value);
                    localStorage.setItem('tl:bookmark-filter', value);
                  }}
                  t={t}
                  create={() =>
                    setBookmarkIntent({ source: active, location: resourceLocation(active) })
                  }
                  edit={(item) =>
                    void run(async () => {
                      const initial = await api<Annotation>(`/annotations/${item.id}`);
                      setBookmarkIntent({ source: active, location: initial.location, initial });
                    })
                  }
                  navigate={(item) => navigateAnnotation(item.sourceId!, item.location)}
                  remove={async (item) => {
                    await run(async () => {
                      await api(`/annotations/${item.id}`, 'PATCH', {
                        deleted: !item.deleted,
                        expectedRevision: item.revision,
                      });
                      setBookmarkTick((value) => value + 1);
                    });
                  }}
                />
              )}
              {tab === 'practice' && (
                <Practice
                  key={`${active.id}-${learning?.createdAt}`}
                  source={active}
                  learning={learning}
                  t={t}
                  onAttempt={(attempt) =>
                    setCatalog((c) => (c ? { ...c, attempts: [...c.attempts, attempt] } : c))
                  }
                  onError={setError}
                  onCite={cite}
                />
              )}
              {tab === 'review' && (
                <Review
                  attempts={catalog.attempts.filter((a) => a.sourceId === active.id)}
                  t={t}
                  showPractice={() => setTab('practice')}
                  showArtifact={() => setArtifact(active.id)}
                />
              )}
              {tab === 'miniapp' && <CodePanel t={t} onError={setError} />}
            </>
          )}
        </div>
      </aside>
      {bookmarkIntent && (
        <BookmarkEditor
          intent={bookmarkIntent}
          sessionId={session.id}
          t={t}
          close={() => setBookmarkIntent(null)}
          saved={() => {
            setBookmarkIntent(null);
            setBookmarkTick((value) => value + 1);
            setRight(true);
            setTab('bookmarks');
          }}
        />
      )}
      {annotationRequest && (
        <Suspense fallback={<p role="status">{t.loadingAnnotations}</p>}>
          <AnnotationEditor
            key={annotationRequest.id}
            request={annotationRequest}
            sessionId={session.id}
            source={catalog.files.find((file) => file.id === annotationRequest.sourceId) || null}
            t={t}
            close={() => setAnnotationRequest(null)}
            saved={() => {
              setAnnotationTick((value) => value + 1);
              setAnnotationRequest(null);
              setTab('notes');
              setRight(true);
            }}
          />
        </Suspense>
      )}
      {modal === 'settings' && (
        <SettingsModal
          initial={catalog.settings}
          t={t}
          close={() => {
            localStorage.setItem('tl:explored', 'yes');
            setModal(null);
          }}
          save={async (value) => {
            const settings = await api<Settings>('/settings', 'POST', value);
            setLocale(settings.locale);
            setCatalog((c) => (c ? { ...c, settings } : c));
          }}
          onError={setError}
        />
      )}
      {directoryDialog &&
        (directoryDialog.action === 'create' || directoryDialog.action === 'rename') && (
          <TextModal
            title={directoryDialog.action === 'create' ? t.newFolder : t.rename}
            label={t.folderName}
            initial={
              directoryDialog.action === 'rename'
                ? directoryName(directoryDialog.directory.path)
                : ''
            }
            t={t}
            close={() => setDirectoryDialog(null)}
            submit={async (name) => {
              if (directoryDialog.action === 'create') {
                await api('/directories', 'POST', { parentPath: directoryDialog.parentPath, name });
                await saveChain.current;
                await refresh();
              } else await directoryMutation(directoryDialog.directory, 'rename', name);
              setDirectoryDialog(null);
            }}
          />
        )}
      {directoryDialog &&
        (directoryDialog.action === 'trash' || directoryDialog.action === 'trashFile') && (
          <TrashModal
            t={t}
            title={directoryDialog.action === 'trash' ? t.trashDirectoryTitle : t.trashFileTitle}
            name={
              directoryDialog.action === 'trash'
                ? directoryDialog.directory.path
                : directoryDialog.file.name
            }
            files={
              directoryDialog.action === 'trash'
                ? catalog.files.filter((file) =>
                    containsPath(directoryDialog.directory.path, file.folder),
                  ).length
                : 1
            }
            folders={
              directoryDialog.action === 'trash'
                ? catalog.directories.filter(
                    (directory) =>
                      directory.id !== directoryDialog.directory.id &&
                      containsPath(directoryDialog.directory.path, directory.path),
                  ).length
                : 0
            }
            close={() => setDirectoryDialog(null)}
            submit={async () => {
              if (directoryDialog.action === 'trash')
                await directoryMutation(directoryDialog.directory, 'trash');
              else {
                await editFile(directoryDialog.file, { trashed: true });
                await saveChain.current;
                const data = await refresh();
                if (sessionRef.current) commitWorkspace(usable(sessionRef.current, data));
              }
              setDirectoryDialog(null);
            }}
          />
        )}
      {modal === 'upload' && (
        <Modal
          title={t.upload}
          close={() => {
            if (!busy) setModal(null);
          }}
          closeLabel={t.close}
        >
          <UploadForm
            t={t}
            busy={busy}
            progress={uploadProgress}
            catalog={catalog}
            initialDirectoryId={uploadDirectoryId}
            actions={treeActions}
            submit={(files, folder, directoryId) =>
              void run(() => addFiles(files, folder, directoryId))
            }
          />
          <div className="sample-material">
            <Button variant="ghost" disabled={busy} onClick={() => void run(example)}>
              {t.addDemo}
            </Button>
          </div>
        </Modal>
      )}
      {renamingSession && (
        <TextModal
          title={t.renameSession}
          label={t.name}
          initial={renamingSession.name}
          t={t}
          close={() => setRenamingSession(null)}
          submit={async (name) => {
            if (name.length > 160) throw new Error(t.sessionNameLimit);
            await saveChain.current;
            if (sessionRef.current?.id === renamingSession.id) {
              updateSession({ name });
              await saveChain.current;
            } else {
              const latest = await api<Catalog>('/catalog');
              const target = latest.sessions.find((item) => item.id === renamingSession.id);
              if (target) await api(`/sessions/${target.id}`, 'PUT', { ...target, name });
            }
            await refresh();
            setRenamingSession(null);
          }}
        />
      )}
      {modal === 'session' && (
        <TextModal
          title={t.newSession}
          label={t.name}
          initial={`${t.sessionName} ${catalog.sessions.length + 1}`}
          t={t}
          close={() => setModal(null)}
          submit={(value) =>
            void run(async () => {
              const created = await api<StudySession>('/sessions', 'POST', { name: value });
              setCatalog((c) => (c ? { ...c, sessions: [...c.sessions, created] } : c));
              selectSession(created);
              setModal(null);
            })
          }
        />
      )}
      {modal === 'rename' && rename && (
        <TextModal
          title={t.rename}
          label={t.filename}
          initial={rename.name}
          t={t}
          close={() => setModal(null)}
          submit={(value) =>
            void run(async () => {
              await editFile(rename, { name: value });
              setModal(null);
            })
          }
        />
      )}
      {modal === 'split' && (
        <Modal
          title={splitRequest?.mode === 'replace' ? t.replaceResource : t.chooseSplit}
          close={() => setModal(null)}
          closeLabel={t.close}
        >
          <input
            aria-label={t.search}
            placeholder={t.search}
            value={splitQuery}
            onChange={(event) => setSplitQuery(event.target.value)}
          />
          <DirectoryTree
            mode="file"
            directories={catalog.directories}
            files={catalog.files.filter((file) => {
              const original = resources.resourceTabs.find(
                (item) => item.id === splitRequest?.tabId,
              );
              return splitRequest?.mode === 'replace'
                ? !original?.sources.some((id) => id !== splitRequest.sourceId && id === file.id)
                : file.id !== splitRequest?.sourceId;
            })}
            t={t}
            query={splitQuery}
            actions={treeActions}
            storageKey="tl:tree:split-picker"
            chooseFile={(file) => {
              if (!sessionRef.current || !splitRequest) return;
              const base = catalog.files.find((source) => source.id === splitRequest.sourceId);
              if (!base || sourceState(base, catalog.directories) === 'trash') {
                setModal(null);
                return;
              }
              const current = usable(sessionRef.current);
              const state =
                splitRequest.tabId &&
                current.resourceTabs.some((item) => item.id === splitRequest.tabId)
                  ? { ...current, activeTabId: splitRequest.tabId }
                  : current;
              commitWorkspace(
                splitRequest.mode === 'replace' &&
                  state.resourceTabs.some(
                    (tab) => tab.id === splitRequest.tabId && tab.sources.length === 2,
                  )
                  ? replacePane(state, splitRequest.sourceId, file.id)
                  : openSplit(state, splitRequest.sourceId, file.id),
              );
              setModal(null);
              setArtifact(false);
              setSeek(null);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

function formatPosition(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
function Citations({
  ids,
  segments,
  onCite,
  t,
}: {
  ids: string[];
  segments: Segment[];
  onCite: (s: Segment) => void;
  t: T;
}) {
  return (
    <div className="citations" aria-label={t.sources}>
      {ids.map((id) => {
        const s = segments.find((x) => x.id === id);
        if (!s) return null;
        return (
          <button key={id} title={s.text} onClick={() => onCite(s)}>
            {s.start != null ? formatPosition(s.start) : s.page ? `${t.page} ${s.page}` : id}
          </button>
        );
      })}
    </div>
  );
}
function Practice({
  source,
  learning,
  t,
  onAttempt,
  onError,
  onCite,
}: {
  source: Source;
  learning: PublicLearning | null;
  t: T;
  onAttempt: (attempt: Attempt) => void;
  onError: (text: string) => void;
  onCite: (s: Segment) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, number>>({}),
    [written, setWritten] = useState<Record<string, string>>({}),
    [results, setResults] = useState<Record<string, Attempt>>({}),
    [pending, setPending] = useState<string | null>(null);
  const questions = learning?.synthesis.chapters.flatMap((c) => c.questions) || [];
  return (
    <>
      <div className="section-label">
        {t.practice}
        <Badge>{questions.length}</Badge>
      </div>
      {!questions.length && <p className="small-empty">{t.noQuestions}</p>}
      {questions.map((q, i) => (
        <section className="quiz-card" key={q.id}>
          <small>
            {String(i + 1).padStart(2, '0')} · {q.concept}
          </small>
          <h3>{q.prompt}</h3>
          <div className="quiz-options">
            {q.kind === 'short' ? (
              <textarea
                aria-label={q.prompt}
                disabled={!!results[q.id]}
                maxLength={4000}
                value={written[q.id] || ''}
                onChange={(e) => setWritten((v) => ({ ...v, [q.id]: e.target.value }))}
              />
            ) : (
              q.choices.map((choice, index) => (
                <label key={index} className={answers[q.id] === index ? 'chosen' : ''}>
                  <input
                    type="radio"
                    name={q.id}
                    disabled={!!results[q.id]}
                    checked={answers[q.id] === index}
                    onChange={() => setAnswers((a) => ({ ...a, [q.id]: index }))}
                  />
                  <span>{choice}</span>
                </label>
              ))
            )}
          </div>
          {results[q.id] ? (
            <div className={`quiz-result ${results[q.id].correct ? 'correct' : 'incorrect'}`}>
              <strong>
                {results[q.id].pendingReview
                  ? t.needsReview
                  : results[q.id].correct
                    ? t.correct
                    : t.incorrect}
              </strong>
              <p>{results[q.id].explanation}</p>
              <Citations ids={q.segmentIds} segments={learning!.segments} onCite={onCite} t={t} />
            </div>
          ) : (
            <Button
              disabled={
                (q.kind === 'short' ? !written[q.id]?.trim() : answers[q.id] == null) ||
                pending === q.id
              }
              onClick={async () => {
                setPending(q.id);
                try {
                  const result = await api<Attempt>('/attempts', 'POST', {
                    sourceId: source.id,
                    questionId: q.id,
                    ...(q.kind === 'short'
                      ? { answer: written[q.id] }
                      : { selected: answers[q.id] }),
                    requestId: crypto.randomUUID(),
                  });
                  setResults((r) => ({ ...r, [q.id]: result }));
                  onAttempt(result);
                } catch (e) {
                  onError(e instanceof Error ? e.message : t.error);
                } finally {
                  setPending(null);
                }
              }}
            >
              {t.checkAnswer}
            </Button>
          )}
        </section>
      ))}
    </>
  );
}
function Review({
  attempts,
  t,
  showPractice,
  showArtifact,
}: {
  attempts: Attempt[];
  t: T;
  showPractice: () => void;
  showArtifact: () => void;
}) {
  const summary = reviewSummary(attempts);
  return (
    <>
      <div className="section-label">{t.review}</div>
      {!summary.count ? (
        <div className="small-empty">
          <Activity size={26} />
          <p>{t.noAttempts}</p>
          <Button onClick={showPractice}>{t.practice}</Button>
        </div>
      ) : (
        <>
          <div className="review-score">
            <strong>{summary.percent}%</strong>
            <span>
              {summary.correct} / {summary.count}
            </span>
          </div>
          <p className="muted">{t.limited}</p>
          {summary.needsPractice.length > 0 && (
            <section className="review-concepts">
              <h3>{t.needsPractice}</h3>
              {summary.needsPractice.map((concept) => (
                <button key={concept} onClick={showPractice}>
                  <RotateCcw size={13} />
                  {concept}
                </button>
              ))}
            </section>
          )}
          <Button onClick={showArtifact}>
            <Activity size={14} />
            {t.artifact}
          </Button>
          <div className="attempt-log">
            {attempts.map((a) => (
              <div key={a.id}>
                <span className={a.correct ? 'success-text' : 'warning-text'}>
                  {a.correct ? '✓' : '↻'}
                </span>
                <span>
                  {a.concept}
                  <small>{new Date(a.createdAt).toLocaleString()}</small>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
function CodePanel({ t, onError }: { t: T; onError: (s: string) => void }) {
  const [available, setAvailable] = useState<boolean | null>(null),
    [draft, setDraft] = useState(''),
    [pending, setPending] = useState(false),
    [result, setResult] = useState('');
  useEffect(() => {
    api<{ available: boolean }>('/code/status')
      .then((s) => setAvailable(s.available))
      .catch(() => setAvailable(false));
  }, []);
  return (
    <>
      <div className="section-label">
        <Code2 size={15} />
        {t.miniapp}
      </div>
      <p className="muted">{t.miniappNotice}</p>
      {available === false && <div className="notice">{t.codeUnavailable}</div>}
      <textarea
        aria-label={t.miniapp}
        placeholder={t.codePrompt}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <Button
        disabled={!available || pending || !draft.trim()}
        onClick={async () => {
          setPending(true);
          try {
            const proposal = await api<unknown>('/code/sessions', 'POST', { prompt: draft });
            setResult(JSON.stringify(proposal, null, 2));
          } catch (e) {
            onError(e instanceof Error ? e.message : t.error);
          } finally {
            setPending(false);
          }
        }}
      >
        {pending ? <LoaderCircle className="spin" size={14} /> : <Code2 size={14} />} {t.startCode}
      </Button>
      <p className="muted">{t.readOnly}</p>
      {result && <pre className="code-output">{result}</pre>}
    </>
  );
}
function SettingsModal({
  initial,
  t,
  close,
  save,
  onError,
}: {
  initial: Settings;
  t: T;
  close: () => void;
  save: (value: unknown) => Promise<void>;
  onError: (s: string) => void;
}) {
  const [key, setKey] = useState(''),
    [locale, setLocale] = useState(initial.locale),
    [model, setModel] = useState(initial.model),
    [pending, setPending] = useState(false),
    [status, setStatus] = useState<'settingsSaved' | 'keyRemoved' | null>(null);
  return (
    <Modal title={t.keyTitle} close={close} closeLabel={t.close}>
      <p className="muted">{t.keyBody}</p>
      <form
        className="settings-form"
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          try {
            await save({ locale, model, ...(key.trim() ? { apiKey: key.trim() } : {}) });
            setKey('');
            setStatus('settingsSaved');
          } catch (e) {
            onError(e instanceof Error ? e.message : t.error);
          } finally {
            setPending(false);
          }
        }}
      >
        <label>
          {t.apiKey}
          <input
            autoComplete="off"
            type="password"
            aria-label={t.apiKey}
            placeholder={
              initial.configured ? `${t.replaceKey} · ••••${initial.keySuffix}` : t.keyPlaceholder
            }
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
        <div className="settings-grid">
          <label>
            {t.language}
            <select value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </label>
          <label>
            {t.model}
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="muse-spark-1.3">Muse Spark 1.3</option>
              <option value="muse-wonder-1.0">Muse Wonder</option>
            </select>
          </label>
        </div>
        <p className="credential-notice">{t.keyStorage}</p>
        {status && (
          <p role="status" className="success-text">
            {t[status]}
          </p>
        )}
        <div className="modal-actions">
          <Button type="submit" variant="primary" disabled={pending}>
            {t.save}
          </Button>
          <Button onClick={close}>{initial.configured ? t.close : t.explore}</Button>
          {initial.configured && (
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await save({ removeKey: true });
                  setKey('');
                  setStatus('keyRemoved');
                } catch (e) {
                  onError(e instanceof Error ? e.message : t.error);
                }
              }}
            >
              {t.removeKey}
            </Button>
          )}
        </div>
      </form>
    </Modal>
  );
}
function TextModal({
  title,
  label,
  initial,
  t,
  close,
  submit,
}: {
  title: string;
  label: string;
  initial: string;
  t: T;
  close: () => void;
  submit: (value: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState(initial),
    [pending, setPending] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title={title} close={close} closeLabel={t.close}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!value.trim() || pending) return;
          setPending(true);
          setError('');
          try {
            await submit(value.trim());
          } catch (error) {
            setError(error instanceof Error ? error.message : t.error);
          } finally {
            setPending(false);
          }
        }}
      >
        <label>
          {label}
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            maxLength={240}
          />
        </label>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <Button variant="primary" type="submit" disabled={!value.trim() || pending}>
            {t.save}
          </Button>
          <Button onClick={close}>{t.cancel}</Button>
        </div>
      </form>
    </Modal>
  );
}

function TrashModal({
  t,
  title,
  name,
  files,
  folders,
  close,
  submit,
}: {
  t: T;
  title: string;
  name: string;
  files: number;
  folders: number;
  close: () => void;
  submit: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title={title}
      close={() => {
        if (!pending) close();
      }}
      closeLabel={t.close}
    >
      <p>
        <strong>{name}</strong>
      </p>
      <p>{t.trashExplanation}</p>
      <p className="muted">
        {t.affectedItems.replace('{files}', String(files)).replace('{folders}', String(folders))}
      </p>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <Button
          variant="danger"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            setError('');
            try {
              await submit();
            } catch (error) {
              setError(error instanceof Error ? error.message : t.error);
            } finally {
              setPending(false);
            }
          }}
        >
          <Trash2 size={17} />
          {t.moveToTrash}
        </Button>
        <Button disabled={pending} onClick={close}>
          {t.cancel}
        </Button>
      </div>
    </Modal>
  );
}
