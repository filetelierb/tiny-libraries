import { useEffect, useRef, useState, lazy, Suspense, type CSSProperties } from 'react';
import {
  BookOpen,
  FileStack,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Settings as SettingsIcon,
  Search,
  Folder,
  FileText,
  Archive,
  X,
  Check,
  Sparkles,
  Bookmark,
  StickyNote,
  GraduationCap,
  MessageSquare,
  Activity,
  Columns2,
  Download,
  ArrowUp,
  ArrowLeft,
  CircleHelp,
  LoaderCircle,
  Pin,
  PinOff,
  FolderPlus,
  Trash2,
  ArrowLeftRight,
  FolderOpen,
  Lightbulb,
  Circle,
  PenLine,
  Highlighter,
  MessageCircleQuestion,
  Workflow,
  House,
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
  jobProgress,
} from '../shared/domain';
import { api, SessionExpiredError, uploadFile } from './api';
import type { QuestionAttachment } from '../shared/tutor-attachments';
import { dictionaries, type T } from './i18n';
import {
  Badge,
  Button,
  Empty,
  IconButton,
  LoadingRow,
  Modal,
  ToolbarButton,
} from './design/components';
import { StudyReader } from './study/StudyReader';
import { ChapterQuiz, questionChoices, type ChapterQuizRequest } from './study/ChapterQuiz';
import { FlashcardDeck, type DeckRequest } from './study/FlashcardDeck';
import { ReviewPanel } from './study/ReviewPanel';
import { reinforcementLearning } from '../shared/review';
import { GeneratedArtifact } from './GeneratedArtifact';
import { ArtifactVersions } from './artifacts/ArtifactVersions';
import { TutorArtifact } from './artifacts/TutorArtifact';
import { recordDraft, recoverPositions, settleDrafts } from './workspace/positionDrafts';
import { cardDue, type DeckView } from '../shared/flashcards';
import { SignalExplorer } from './SignalExplorer';
import { PanelResizer, useDrawerFocus, usePanels } from './workspace/Panels';
import { ProcessingPanel } from './workspace/ProcessingPanel';
import { usePreparation } from './workspace/usePreparation';
import { PreparationStrip } from './workspace/PreparationStrip';
import { AgentPanel } from './AgentPanel';
import {
  readWorkspace,
  workspacePatch,
  openResource,
  sessionsWithResource,
  openArtifact,
  closeResourceTab,
  reorderResourceTabs,
  splitWithResource,
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
import {
  StudyTabs,
  auxiliaryStudyTools,
  isPrimaryStudyTool,
  type StudyTab,
} from './workspace/StudyTabs';
import {
  ArtifactList,
  useLibraryArtifacts,
  type LibraryArtifact,
  LibraryTabs,
  PanelSection,
  TestsList,
  useLibraryTab,
  useTests,
} from './workspace/LibrarySections';
import { DirectoryTree, type TreeActions } from './workspace/DirectoryTree';
import { SplitWorkspace } from './workspace/SplitWorkspace';
import { UploadForm } from './workspace/UploadForm';
import { ConversationPanel } from './workspace/ConversationPanel';
import { conversationHasWork } from './tutor/turnDrafts';
import { AnnotationsPanel } from './annotations/AnnotationsPanel';
import { captureSource } from './annotations/capture';
import type { AnnotationRequest } from './annotations/AnnotationEditor';
import { TypingPauseContext, useProvideTypingPause } from './annotations/typingPause';
import { plainDocument } from '../shared/annotations';
import type { Annotation, SourceLocation } from '../shared/annotations';
import { useBookmarks } from './bookmarks/useBookmarks';
import { BookmarkEditor, type BookmarkIntent } from './bookmarks/BookmarkEditor';
import { BookmarksPanel, type BookmarkFilter } from './bookmarks/BookmarksPanel';
import { GlossaryPanel } from './glossary/GlossaryPanel';
const AnnotationEditor = lazy(() => import('./annotations/AnnotationEditor'));
const AssessmentWorkspace = lazy(() =>
  import('./study/AssessmentWorkspace').then((module) => ({ default: module.AssessmentWorkspace })),
);
import { sessionPreview, type QuestionContext } from '../shared/conversations';
import { ActionMenu } from './design/ActionMenu';
import { ContentBoundary } from './design/ContentBoundary';
import { containsPath, directoryName, sourceState } from '../shared/directories';

const localGet = (key: string, fallback: string) => localStorage.getItem(key) || fallback;
type DirectoryDialog =
  | { action: 'create'; parentPath: string }
  | { action: 'rename'; directory: Directory }
  | { action: 'deleteDirectory'; directory: Directory }
  | { action: 'deleteFile'; file: Source };

export function App() {
  const typingPause = useProvideTypingPause();
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [locale, setLocale] = useState<Locale>(() => localGet('tl:locale', 'en') as Locale),
    [session, setSession] = useState<StudySession | null>(null);
  const [annotationRequest, setAnnotationRequest] = useState<AnnotationRequest | null>(null);
  const [glossaryFocus, setGlossaryFocus] = useState<{ id: string; nonce: string } | null>(null);
  const [annotationTick, setAnnotationTick] = useState(0);
  const [quizRequest, setQuizRequest] = useState<ChapterQuizRequest | null>(null);
  const [assessmentOpen, setAssessmentOpen] = useState(false);
  const [assessmentStart, setAssessmentStart] = useState<{
    sessionId?: string;
    selection?: string | null;
  }>({});
  const [libraryTab, setLibraryTab] = useLibraryTab();
  const tests = useTests(assessmentOpen);
  const [deckRequest, setDeckRequest] = useState<DeckRequest | null>(null),
    [cardTick, setCardTick] = useState(0);
  const [resumePlayback, setResumePlayback] = useState<{ sourceId: string; nonce: number } | null>(
    null,
  );
  const playbackStates = useRef<Record<string, boolean>>({});
  const [bookmarkTick, setBookmarkTick] = useState(0);
  const [bookmarkIntent, setBookmarkIntent] = useState<BookmarkIntent | null>(null);
  const [bookmarkFilter, setBookmarkFilter] = useState<BookmarkFilter>(() => {
    const value = localGet('tl:bookmark-filter', 'all');
    return value === 'manual' || value === 'tutor' ? value : 'all';
  });
  const [incomingAttachment, setIncomingAttachment] = useState<{
    id: string;
    item: QuestionAttachment;
  } | null>(null);
  const [questionRequest, setQuestionRequest] = useState<{
    id: string;
    context: QuestionContext;
    prompt?: string;
  } | null>(null);
  const [selection, setSelection] = useState<{ sourceId: string; location: SourceLocation } | null>(
    null,
  );
  // Floating actions anchored above the current text selection.
  const [selectionMenu, setSelectionMenu] = useState<{
    sourceId: string;
    x: number;
    y: number;
  } | null>(null);
  useEffect(() => {
    if (!selectionMenu) return;
    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event.target instanceof Element && event.target.closest('.selection-menu')) return;
      setSelectionMenu(null);
    };
    const scrolled = () => setSelectionMenu(null);
    document.addEventListener('keydown', dismiss);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('scroll', scrolled, true);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('scroll', scrolled, true);
    };
  }, [selectionMenu]);
  // Expanded reading hides the library; the study panel stays available beside the content.
  const panels = usePanels();
  const left = panels.effective.left.open,
    right = panels.effective.right.open;
  const setLeft = (value: boolean) => panels.open('left', value);
  const setRight = (value: boolean) => panels.open('right', value);
  const leftPanelRef = useRef<HTMLElement>(null),
    rightPanelRef = useRef<HTMLElement>(null);
  const [tab, setTab] = useState<StudyTab>('assistant'),
    [query, setQuery] = useState('');
  function selectStudyTool(value: StudyTab) {
    setTab(value);
    requestAnimationFrame(() => {
      document
        .getElementById(isPrimaryStudyTool(value) ? `study-tab-${value}` : 'study-tool-title')
        ?.focus({ preventScroll: true });
    });
  }
  const [renamingSession, setRenamingSession] = useState<StudySession | null>(null);
  const [deletingSession, setDeletingSession] = useState<StudySession | null>(null),
    [removingSession, setRemovingSession] = useState(false),
    [sessionDeleteError, setSessionDeleteError] = useState('');
  const [directoryDialog, setDirectoryDialog] = useState<DirectoryDialog | null>(null);
  const [uploadDirectoryId, setUploadDirectoryId] = useState<string | null>(null);
  const [returnToSplit, setReturnToSplit] = useState(false);
  const [splitRequest, setSplitRequest] = useState<{
    mode: 'new' | 'replace';
    sourceId: string;
    tabId: string | null;
  } | null>(null);
  const [splitQuery, setSplitQuery] = useState('');
  useDrawerFocus('left', !!catalog && panels.drawer === 'left', leftPanelRef, () => setLeft(false));
  useDrawerFocus('right', !!catalog && panels.drawer === 'right', rightPanelRef, () =>
    setRight(false),
  );
  const [processing, setProcessing] = useState(false);
  // Files being prepared; a finished one brings its chapters and practice into view.
  const preparing = usePreparation(locale, () => void refresh().catch(() => {}));
  const [modal, setModal] = useState<'settings' | 'upload' | 'session' | 'rename' | 'split' | null>(
      null,
    ),
    [rename, setRename] = useState<Source | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [sessionExpired, setSessionExpired] = useState(false),
    [reviewing, setReviewing] = useState(false),
    [sessionChoice, setSessionChoice] = useState<{
      file: Source;
      mode: 'preview' | 'retain';
      sessions: StudySession[];
    } | null>(null),
    [uploadProgress, setUploadProgress] = useState<number | null>(null),
    [uploading, setUploading] = useState<{ name: string; index: number; total: number } | null>(
      null,
    );
  const uploadAbort = useRef<AbortController | null>(null);
  const [learningState, setLearning] = useState<PublicLearning | null>(null),
    [jobState, setJob] = useState<(Job & { segments?: Segment[] }) | null>(null),
    // Where the active reader puts its chapter button, at the start of the file toolbar.
    [chapterSlot, setChapterSlot] = useState<HTMLDivElement | null>(null),
    [seek, setSeek] = useState<{
      sourceId: string;
      value: number;
      nonce: number;
      segment?: Segment;
      heading?: string;
    } | null>(null),
    [artifact, setArtifact] = useState<string | false>(false),
    /** Source whose artifact is shown beside the cited source after following a citation. */
    [artifactSplit, setArtifactSplit] = useState<string | null>(null),
    [refreshTick, setRefreshTick] = useState(0);
  const sessionRef = useRef(session),
    saveChain = useRef(Promise.resolve()),
    t = dictionaries[locale] || dictionaries.en;
  const [materialCache, setMaterialCache] = useState<Record<string, PublicLearning | null>>({});
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
  // The artifact view follows the active tab.
  useEffect(() => {
    setArtifact(activeResourceTab?.view === 'artifact' ? activeResourceTab.sources[0] : false);
  }, [activeResourceTab?.id]);
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
  const libraryArtifacts = useLibraryArtifacts(catalog?.files);
  const sourceArtifacts = active
    ? (libraryArtifacts.items || []).filter(
        (item) =>
          item.sourceId === active.id && (!item.sessionId || item.sessionId === session?.id),
      )
    : [];
  const run = async (work: () => Promise<void>) => {
    setError('');
    setSessionExpired(false);
    try {
      await work();
    } catch (e) {
      if (e instanceof SessionExpiredError) setSessionExpired(true);
      setError(
        e instanceof SessionExpiredError
          ? t.sessionExpired
          : e instanceof Error
            ? e.message
            : t.error,
      );
    }
  };
  async function refresh() {
    const value = await api<Catalog>('/catalog');
    setCatalog(value);
    setBookmarkTick((value) => value + 1);
    return value;
  }
  const pendingConversations = !!catalog?.conversations.some(conversationHasWork);
  useEffect(() => {
    if (!pendingConversations) return;
    let cancelled = false,
      timer: number;
    const poll = async () => {
      try {
        await refresh();
      } catch {
        /* Stored work remains authoritative while the local server reconnects. */
      }
      if (!cancelled) timer = window.setTimeout(() => void poll(), 2500);
    };
    timer = window.setTimeout(() => void poll(), 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pendingConversations]);
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
      restoreDrafts(selected);
      if (!data.settings.configured && !localStorage.getItem('tl:explored')) setModal('settings');
    });
  }, []);
  // Media positions reach the server at most every 10 seconds per source; the latest
  // value waits in a browser draft so a reload can recover it.
  const positionWrites = useRef(
    new Map<string, { sent: number; timer?: ReturnType<typeof setTimeout> }>(),
  );
  function savePosition(source: Source, value: number) {
    const current = sessionRef.current;
    if (!current) return;
    recordDraft(current.id, source.id, value);
    const write = () =>
      sessionRef.current?.id === current.id &&
      updateSession({ positions: { ...sessionRef.current.positions, [source.id]: value } });
    if (source.kind !== 'audio' && source.kind !== 'video') return void write();
    const key = `${current.id}:${source.id}`,
      state = positionWrites.current.get(key) || { sent: 0 };
    if (state.timer) clearTimeout(state.timer);
    const delay = Math.max(0, state.sent + 10_000 - Date.now());
    const flush = () => {
      positionWrites.current.set(key, { sent: Date.now() });
      write();
    };
    if (!delay) flush();
    else positionWrites.current.set(key, { ...state, timer: setTimeout(flush, delay) });
  }
  function restoreDrafts(value: StudySession) {
    const positions = recoverPositions(value.id, value.positions);
    if (positions) updateSession({ positions });
  }
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
        settleDrafts(value.id, value.positions);
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
    restoreDrafts(value);
    setArtifact(false);
    setLearning(null);
    setSeek(null);
  }
  /**
   * Deletes a session with what was made in it. The open session is left first, for the most
   * recent other one or a new one, so no pending save reaches the deleted session.
   */
  async function removeSession(target: StudySession) {
    setRemovingSession(true);
    setSessionDeleteError('');
    try {
      if (sessionRef.current?.id === target.id) {
        const next =
          [...(catalog?.sessions || [])]
            .filter((item) => item.id !== target.id)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ||
          (await api<StudySession>('/sessions', 'POST', { name: t.sessionName }));
        setCatalog((c) =>
          c && !c.sessions.some((item) => item.id === next.id)
            ? { ...c, sessions: [...c.sessions, next] }
            : c,
        );
        selectSession(next);
      }
      await saveChain.current;
      await api(`/sessions/${target.id}`, 'DELETE');
      setCatalog((c) =>
        c
          ? {
              ...c,
              sessions: c.sessions.filter((item) => item.id !== target.id),
              conversations: c.conversations.filter((item) => item.sessionId !== target.id),
            }
          : c,
      );
      localStorage.removeItem(`tl:conversation:${target.id}`);
      setDeletingSession(null);
      await refresh();
    } catch (e) {
      setSessionDeleteError(e instanceof Error ? e.message : t.error);
    } finally {
      setRemovingSession(false);
    }
  }
  function commitWorkspace(next: ResourceWorkspace) {
    if (next.resourceTabs.length > MAX_RESOURCE_TABS) {
      setError(t.tabLimit);
      return;
    }
    updateSession(workspacePatch(next));
  }
  function showArtifact(sourceId: string) {
    if (!sessionRef.current) return;
    commitWorkspace(openArtifact(usable(sessionRef.current), sourceId));
    setArtifact(sourceId);
    setArtifactSplit(null);
    setSeek(null);
  }
  /** Saves the selected passage as a highlight annotation and shows it in Notes. */
  function openGlossaryConcept(id: string) {
    setGlossaryFocus({ id, nonce: crypto.randomUUID() });
    setRight(true);
    setTab('glossary');
  }
  async function saveHighlight(source: Source, location: SourceLocation) {
    const quote = location.quote?.trim();
    if (!quote || !sessionRef.current) return;
    const id = crypto.randomUUID();
    await api(`/annotations/${id}`, 'PUT', {
      kind: 'annotation',
      id,
      sessionId: sessionRef.current.id,
      sourceId: source.id,
      sourceVersion: source.version,
      title: quote.slice(0, 80),
      document: plainDocument(quote),
      location: { ...location, quote },
      strokes: [],
      expectedRevision: 0,
    });
    window.getSelection()?.removeAllRanges();
    setAnnotationTick((value) => value + 1);
    setTab('notes');
    setRight(true);
  }
  function openLibraryArtifact(item: LibraryArtifact, file: Source) {
    if (item.origin === 'source') showArtifact(file.id);
    else if (item.origin === 'tutor') openFile(file, 'retain');
    else {
      // Review artifacts live with their reinforcement in the Review tab.
      setRight(true);
      setTab('review');
    }
    if (panels.drawer === 'left') setLeft(false);
  }
  function openFile(file: Source, mode: 'preview' | 'retain' = 'preview', here = false) {
    if (!sessionRef.current) return;
    // A fresh, empty session first offers to resume a session that already studies this file.
    const others =
      !here && catalog && !usable(sessionRef.current).resourceTabs.length
        ? sessionsWithResource(catalog.sessions, sessionRef.current.id, file.id)
        : [];
    if (others.length) {
      setSessionChoice({ file, mode, sessions: others });
      return;
    }
    commitWorkspace(openResource(usable(sessionRef.current), file.id, mode));
    setArtifact(false);
    setArtifactSplit(null);
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
  function reorderResourceTab(sourceId: string, targetId: string) {
    if (sessionRef.current)
      commitWorkspace(reorderResourceTabs(usable(sessionRef.current), sourceId, targetId));
  }
  function splitResourceTab(sourceId: string) {
    if (!sessionRef.current || !catalog) return;
    const source = catalog.files.find((file) => file.id === sourceId);
    if (!source || sourceState(source, catalog.directories) === 'trash') return;
    commitWorkspace(splitWithResource(usable(sessionRef.current), sourceId));
    setArtifact(false);
    setSeek(null);
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
          setMaterialCache((previous) => ({ ...previous, [active.id]: material }));
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
  useEffect(() => {
    if (!catalog) return;
    // An open linked-artifact file reads its material from the recording it points at.
    const linkedSourceIds = [primary, split, active]
      .filter((source): source is Source => !!source && !!source.linkedSourceId)
      .map((source) => source.linkedSourceId!);
    const sources = [
      primary,
      split,
      ...catalog.files.filter((file) => linkedSourceIds.includes(file.id)),
    ].filter((source): source is Source => !!source && source.id !== active?.id);
    if (!sources.length) return;
    let cancelled = false;
    const load = async () => {
      const results = await Promise.all(
        sources.map(async (source) => {
          try {
            return [source.id, await api<PublicLearning | null>(`/learning/${source.id}`)] as const;
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      setMaterialCache((previous) => {
        let next = previous;
        for (const result of results) {
          if (!result) continue;
          const [id, value] = result,
            old = previous[id];
          if (
            old === undefined ||
            old?.createdAt !== value?.createdAt ||
            old?.sourceVersion !== value?.sourceVersion
          ) {
            if (next === previous) next = { ...previous };
            next[id] = value;
          }
        }
        return next;
      });
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [primary?.id, primary?.version, split?.id, split?.version, active?.id, refreshTick]);
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
  async function addFiles(
    files: File[],
    folder: string,
    directoryId?: string,
    uploaded?: (file: File) => void,
  ) {
    setBusy(true);
    const controller = new AbortController();
    uploadAbort.current = controller;
    try {
      for (const [index, file] of files.entries()) {
        if (!kindFor(file.name)) throw new Error(`${t.unsupported}: ${file.name}`);
        if (file.size > MAX_FILE_BYTES) throw new Error(t.maxSize);
        setUploadProgress(0);
        setUploading({ name: file.name, index, total: files.length });
        let source: Source;
        try {
          source = await uploadFile(
            file,
            folder,
            setUploadProgress,
            directoryId,
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) throw new Error(t.uploadCancelled);
          throw new Error(`${file.name}: ${error instanceof Error ? error.message : t.error}`);
        }
        uploaded?.(file);
        setCatalog((c) => (c ? { ...c, files: [...c.files, source] } : c));
        openFile(source, 'retain');
      }
      await saveChain.current;
      await refresh();
      setModal(returnToSplit ? 'split' : null);
      setReturnToSplit(false);
    } finally {
      uploadAbort.current = null;
      setBusy(false);
      setUploadProgress(null);
      setUploading(null);
    }
  }
  async function directoryMutation(
    directory: Directory,
    action: 'archive' | 'unarchive' | 'trash' | 'restore' | 'rename' | 'move',
    name?: string,
  ) {
    await api(
      `/directories/${directory.id}`,
      'PATCH',
      action === 'move' ? { action, parentPath: name } : { action, ...(name ? { name } : {}) },
    );
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
    upload: (directory) => showUpload(directory.id),
    renameFile: (file) => {
      setRename(file);
      setModal('rename');
    },
    archiveFile: (file, restore) => void run(() => editFile(file, { archived: !restore })),
    deleteFile: (file) => setDirectoryDialog({ action: 'deleteFile', file }),
    deleteDirectory: (directory) => setDirectoryDialog({ action: 'deleteDirectory', directory }),
    moveFile: (file, folder) => void run(() => editFile(file, { folder })),
    moveDirectory: (directory, parentPath) =>
      void run(() => directoryMutation(directory, 'move', parentPath)),
  };
  const position = active ? session?.positions[active.id] || 0 : 0;
  const archivedCount =
    catalog?.files.filter((f) => sourceState(f, catalog.directories) === 'archived').length || 0;
  // Archived folders show even when empty, so they can still be restored.
  const archivedAny =
    archivedCount > 0 ||
    !!catalog?.directories.some((directory) => directory.archived && !directory.trashed);
  function resourceLocation(source: Source): SourceLocation {
    if (selection?.sourceId === source.id) return selection.location;
    const position = sessionRef.current?.positions[source.id] || 0;
    return source.kind === 'pdf'
      ? { page: Math.max(1, Math.round(position) || 1) }
      : ['audio', 'video'].includes(source.kind)
        ? { seconds: position }
        : {};
  }
  function askAbout(source: Source, prompt?: string) {
    setQuestionRequest({
      id: crypto.randomUUID(),
      prompt,
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
  // Bookmarks are labelled inline in the bookmarks panel when it can show.
  const bookmarkInline = right && tab === 'bookmarks';
  useEffect(() => {
    if (!bookmarkIntent) return;
    setTab('bookmarks');
    setRight(true);
  }, [bookmarkIntent]);
  const bookmarkEditor = (inline: boolean) =>
    bookmarkIntent &&
    session && (
      <BookmarkEditor
        intent={bookmarkIntent}
        sessionId={session.id}
        t={t}
        inline={inline}
        close={() => setBookmarkIntent(null)}
        saved={() => {
          setBookmarkIntent(null);
          setBookmarkTick((value) => value + 1);
          setRight(true);
          setTab('bookmarks');
        }}
      />
    );
  // New and edited annotations open inline in the annotations panel when it can show.
  const annotationInline = right && tab === 'notes';
  useEffect(() => {
    if (!annotationRequest) return;
    setTab('notes');
    setRight(true);
  }, [annotationRequest?.id]);
  const annotationEditor = (inline: boolean) =>
    annotationRequest &&
    catalog &&
    session && (
      <ContentBoundary t={t} close={() => setAnnotationRequest(null)}>
        <Suspense fallback={<p role="status">{t.loadingAnnotations}</p>}>
          <AnnotationEditor
            catalog={catalog}
            treeActions={treeActions}
            key={annotationRequest.id}
            request={annotationRequest}
            sessionId={session.id}
            source={catalog.files.find((file) => file.id === annotationRequest.sourceId) || null}
            t={t}
            inline={inline}
            close={() => setAnnotationRequest(null)}
            saved={() => {
              setAnnotationTick((value) => value + 1);
              setAnnotationRequest(null);
              setTab('notes');
              setRight(true);
            }}
          />
        </Suspense>
      </ContentBoundary>
    );
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
  /** Citations inside an artifact keep the artifact and open the evidence beside it. */
  function citeFromArtifact(sourceId: string, segment: Segment) {
    setArtifactSplit(sourceId);
    setSeek({ sourceId, value: segment.start ?? segment.page ?? 0, nonce: Date.now(), segment });
    setLeft(false);
    setRight(false);
  }
  function citeFrom(sourceId: string, segment: Segment, heading?: string) {
    if (!activeResourceTab?.sources.includes(sourceId)) {
      const file = catalog?.files.find((item) => item.id === sourceId);
      if (!file || sourceState(file, catalog?.directories || []) === 'trash') {
        setError(t.evidenceUnavailable);
        return;
      }
      openFile(file, 'retain');
    } else focusPane(sourceId);
    setSeek({
      sourceId,
      value: segment.start ?? segment.page ?? 0,
      nonce: Date.now(),
      segment,
      heading,
    });
    setArtifact(false);
  }
  if (!catalog || !session)
    return (
      <div className="loading" role="status">
        {!error && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
        <p>{error || t.loading}</p>
        {error && (
          <div className="loading-actions">
            <Button onClick={() => location.reload()}>{t.retry}</Button>
            <a className="button button-ghost" href="/">
              {t.home}
            </a>
          </div>
        )}
      </div>
    );
  return (
    <TypingPauseContext.Provider value={typingPause}>
    <div
      className="app"
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
        hidden={!left}
        inert={!!panels.drawer && panels.drawer !== 'left'}
        className={`library-panel ${panels.resolved.left.docked ? 'docked' : 'floating'}${panels.narrow ? ' narrow' : ''}`}
        role={panels.drawer === 'left' ? 'dialog' : undefined}
        aria-modal={panels.drawer === 'left' ? true : undefined}
      >
        <div className="library-heading">
          <LibraryTabs value={libraryTab} change={setLibraryTab} t={t} />
          <div className="panel-heading-actions">
            <a
              className="button button-ghost icon-button"
              href="/"
              title={t.home}
              aria-label={t.home}
            >
              <House />
            </a>
            {panels.narrow ? (
              <IconButton label={t.showStudy} onClick={() => setRight(true)}>
                <PanelRightOpen />
              </IconButton>
            ) : (
              <IconButton
                label={panels.preferences.left.pinned ? t.unpinPanel : t.pinPanel}
                aria-pressed={panels.preferences.left.pinned}
                onClick={() => panels.pin('left')}
              >
                {panels.preferences.left.pinned ? <Pin /> : <PinOff />}
              </IconButton>
            )}
            {!panels.resolved.left.docked && (
              <IconButton
                data-drawer-close
                label={panels.drawer === 'left' ? t.backToSession : t.hideFiles}
                onClick={() => setLeft(false)}
              >
                <X />
              </IconButton>
            )}
          </div>
        </div>
        <div
          className="library-content"
          id="library-content"
          role="tabpanel"
          aria-labelledby={`library-tab-${libraryTab}`}
        >
          {libraryTab === 'library' && (
            <>
              <div className="library-search">
                <Search size={16} />
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
                <IconButton
                  label={t.preparationQueue}
                  aria-pressed={processing}
                  onClick={() => setProcessing((value) => !value)}
                >
                  <Workflow />
                </IconButton>
                <IconButton
                  label={
                    catalog.settings.configured ? t.settings : `${t.settings} · ${t.notConfigured}`
                  }
                  data-attention={catalog.settings.configured ? undefined : ''}
                  onClick={() => setModal('settings')}
                >
                  <SettingsIcon />
                </IconButton>
              </div>
              <PreparationStrip
                jobs={preparing}
                files={catalog.files}
                t={t}
                open={() => setProcessing(true)}
              />
              <PanelSection
                id="library-files"
                title={t.files}
                count={
                  catalog.files.filter((f) => sourceState(f, catalog.directories) === 'files')
                    .length
                }
                t={t}
                grow
              >
                <div className="file-tree">
                  <DirectoryTree
                    directories={catalog.directories.filter(
                      (dir) => !/(?:^|\/)(Artifacts|Artefactos)$/.test(dir.path),
                    )}
                    files={catalog.files.filter((file) => file.kind !== 'artifact')}
                    t={t}
                    active={active?.id}
                    view="files"
                    query={query}
                    chooseFile={openFile}
                    actions={treeActions}
                    storageKey="tl:tree:sidebar"
                    preparing={preparing}
                  />
                </div>
              </PanelSection>
              {archivedAny && (
                <PanelSection
                  id="library-archived"
                  title={t.archived}
                  icon={<Archive size={13} />}
                  count={archivedCount}
                  t={t}
                  defaultOpen={false}
                >
                  <p className="panel-section-hint">{t.archivedHint}</p>
                  <div className="file-tree">
                    <DirectoryTree
                      directories={catalog.directories.filter(
                        (dir) => !/(?:^|\/)(Artifacts|Artefactos)$/.test(dir.path),
                      )}
                      files={catalog.files.filter((file) => file.kind !== 'artifact')}
                      t={t}
                      active={active?.id}
                      view="archived"
                      query={query}
                      chooseFile={openFile}
                      actions={treeActions}
                      storageKey="tl:tree:sidebar"
                    />
                  </div>
                </PanelSection>
              )}
            </>
          )}
          {libraryTab === 'sessions' && (
            <PanelSection
              id="study-sessions"
              title={t.sessions}
              count={catalog.sessions.length}
              t={t}
              grow
              actions={
                <IconButton label={t.newSession} onClick={() => setModal('session')}>
                  <Plus />
                </IconButton>
              }
            >
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
                          <span>{item.name}</span>
                          <small title={preview.source?.name}>
                            {preview.source?.name || t.noOpenResources} · {preview.count}{' '}
                            {t.messagesShort}
                          </small>
                        </button>
                        <ActionMenu
                          label={`${t.sessionOptions}: ${item.name}`}
                          actions={[
                            { label: t.renameSession, run: () => setRenamingSession(item) },
                            {
                              label: t.deleteSession,
                              danger: true,
                              run: () => {
                                setSessionDeleteError('');
                                setDeletingSession(item);
                              },
                            },
                          ]}
                        />
                      </div>
                    );
                  })}
              </div>
            </PanelSection>
          )}
          {libraryTab === 'artifacts' && (
            <ArtifactList
              files={catalog.files.filter((f) => sourceState(f, catalog.directories) !== 'trash')}
              artifacts={libraryArtifacts}
              sessionId={session.id}
              sessions={catalog.sessions}
              open={(item, file) => openLibraryArtifact(item, file)}
              t={t}
            />
          )}
          {libraryTab === 'tests' && (
            <TestsList
              tests={tests}
              sessions={catalog.sessions}
              locale={locale}
              t={t}
              review={() => {
                setAssessmentStart({ selection: null });
                setAssessmentOpen(true);
                if (panels.drawer === 'left') setLeft(false);
              }}
              openTest={(test) => {
                setAssessmentStart({ sessionId: test.sessionId, selection: test.id });
                setAssessmentOpen(true);
                if (panels.drawer === 'left') setLeft(false);
              }}
            />
          )}
        </div>
        {panels.drawer === 'left' && !panels.narrow && (
          <PanelResizer
            side="left"
            className="floating-resizer"
            label={t.filePanelWidth}
            help={t.resizeHelp}
            width={panels.resolved.left.width}
            max={panels.drawerMax}
            change={(value) => panels.resize('left', value)}
          />
        )}
      </aside>
      {left && panels.resolved.left.docked && (
        <PanelResizer
          side="left"
          label={t.filePanelWidth}
          help={t.resizeHelp}
          width={panels.resolved.left.width}
          max={panels.resolved.left.max}
          change={(value) => panels.resize('left', value)}
        />
      )}
      {panels.drawer && !panels.narrow && (
        <button
          className="drawer-backdrop"
          tabIndex={-1}
          aria-label={t.dismissPanels}
          onClick={() => panels.open(panels.drawer!, false)}
        />
      )}
      <main className="workspace" inert={!!panels.drawer}>
        <div className="resource-tabs">
          <IconButton
            label={left ? t.hideFiles : t.openFiles}
            aria-controls="left-panel"
            aria-expanded={left}
            data-panel-toggle="left"
            onClick={() => setLeft(!left)}
          >
            {left ? <PanelLeftClose /> : <PanelLeftOpen />}
          </IconButton>
          <ResourceTabs
            workspace={resources}
            files={catalog.files}
            t={t}
            select={selectResourceTab}
            keep={keepResourceTab}
            close={closeFile}
            reorder={reorderResourceTab}
            rename={treeActions.renameFile}
            splitWith={splitResourceTab}
          />
          <IconButton
            label={right ? t.hideStudy : t.showStudy}
            aria-expanded={right}
            aria-controls="right-panel"
            data-panel-toggle="right"
            onClick={() => setRight(!right)}
          >
            {right ? <PanelRightClose /> : <PanelRightOpen />}
          </IconButton>
        </div>
        {error && (
          <div role="alert" className="error-bar">
            <CircleHelp size={16} />
            <span>{error}</span>
            {sessionExpired ? (
              <Button size="sm" onClick={() => location.reload()}>
                {t.renewSession}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void run(async () => void (await refresh()))}
              >
                {t.retry}
              </Button>
            )}
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
                <FolderOpen size={16} />
                {t.exploreFiles}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setTab('assistant');
                  setRight(true);
                }}
              >
                <MessageSquare size={16} />
                {t.startConversation}
              </Button>
            </div>
          </Empty>
        ) : (
          <>
            <div className="file-toolbar">
              <div className="chapter-action" ref={setChapterSlot} />
              {split && (
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
              )}
              <div className="reader-commands">
                <div className="toolbar-actions" role="toolbar" aria-label={t.resourceTools}>
                  <ToolbarButton
                    label={t.addBookmark}
                    icon={<Bookmark />}
                    onClick={() =>
                      setBookmarkIntent({ source: active, location: resourceLocation(active) })
                    }
                  />
                  <ToolbarButton
                    label={t.annotateResource}
                    text={t.annotateShort}
                    icon={<PenLine />}
                    onClick={() =>
                      void run(() => beginAnnotation(active.id, resourceLocation(active), true))
                    }
                  />
                  <ToolbarButton
                    label={t.askTutor}
                    text={t.askShort}
                    icon={<MessageCircleQuestion />}
                    onClick={() => askAbout(active)}
                  />
                  {split ? (
                    <>
                      <ToolbarButton
                        label={t.replaceResource}
                        icon={<FolderOpen />}
                        onClick={showSplitPicker}
                      />
                      <ToolbarButton
                        label={t.swapPanes}
                        icon={<ArrowLeftRight />}
                        onClick={() => {
                          if (sessionRef.current)
                            commitWorkspace(swapSplit(usable(sessionRef.current)));
                        }}
                      />
                      <ToolbarButton label={t.noSplit} icon={<X />} onClick={closeSplit} />
                    </>
                  ) : (
                    <ToolbarButton
                      label={t.split}
                      text={t.splitShort}
                      icon={<Columns2 />}
                      onClick={showSplitPicker}
                    />
                  )}
                  <ToolbarButton
                    label={active.reviewed ? t.reviewed : t.markReviewed}
                    variant={active.reviewed ? 'secondary' : 'ghost'}
                    aria-pressed={active.reviewed}
                    disabled={active.reviewed || reviewing}
                    icon={
                      reviewing ? (
                        <LoaderCircle className="spin" />
                      ) : active.reviewed ? (
                        <Check />
                      ) : (
                        <Circle />
                      )
                    }
                    onClick={() => {
                      setReviewing(true);
                      void run(() => editFile(active, { reviewed: true })).finally(() =>
                        setReviewing(false),
                      );
                    }}
                  />
                  <ActionMenu
                    label={`${t.sourceArtifacts}: ${sourceArtifacts.length}`}
                    icon={
                      <>
                        <FileStack size={16} />
                        <span className="toolbar-count">{sourceArtifacts.length}</span>
                      </>
                    }
                    options={{
                      heading: t.sourceArtifacts,
                      placement: 'below',
                      footnote: sourceArtifacts.some((item) => item.origin === 'source')
                        ? t.artifactTutorHint
                        : t.noArtifactUsesFileHint,
                    }}
                    actions={[
                      ...sourceArtifacts.map((item) => ({
                        label: [
                          item.origin === 'reinforcement' ? t.reviewArtifact : '',
                          item.title,
                          item.revision ? `v${item.revision}` : '',
                        ]
                          .filter(Boolean)
                          .join(' · '),
                        icon: <Activity size={16} />,
                        run: () => openLibraryArtifact(item, active),
                      })),
                      sourceArtifacts.some((item) => item.origin === 'source')
                        ? {
                            label: t.askTutorForArtifactVersion,
                            icon: <Sparkles size={16} />,
                            tone: 'primary' as const,
                            run: () => askAbout(active, t.artifactVersionPrompt),
                          }
                        : {
                            label: t.noArtifactUsesFile,
                            icon: <FileStack size={16} />,
                            disabled: true,
                            run: () => {},
                          },
                    ]}
                  />
                  <span className="toolbar-divider" aria-hidden="true" />
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
                    label={t.glossary}
                    onClick={() => {
                      setRight(true);
                      setTab('glossary');
                    }}
                  >
                    <Lightbulb />
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
              </div>
            </div>
            {job && job.status !== 'completed' && (
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
                  {jobProgress(job)}
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
                  if (source.kind === 'artifact') {
                    if (source.linkedSourceId) {
                      const linked = catalog.files.find((f) => f.id === source.linkedSourceId);
                      const linkedMaterial = linked ? materialCache[linked.id] : null;
                      if (!linked || linked.trashed) {
                        return (
                          <p className="muted" style={{ padding: 20 }}>
                            {t.evidenceUnavailable}
                          </p>
                        );
                      }
                      if (!linkedMaterial?.synthesis.artifact) {
                        return <p style={{ padding: 20 }}>{t.loading}</p>;
                      }
                      return (
                        <div className="artifact-host">
                          <GeneratedArtifact
                            study={{
                              sourceId: linked.id,
                              attempts: catalog.attempts,
                              quiz: (chapter, version) =>
                                setQuizRequest({
                                  source: linked,
                                  learning: { ...linkedMaterial, createdAt: version },
                                  chapter: {
                                    id: chapter.id,
                                    title: chapter.title,
                                    summary: chapter.summary,
                                    segmentIds: chapter.segmentIds,
                                    questions: chapter.questions,
                                  },
                                  wasPlaying: false,
                                  artifactStudy: true,
                                  ordinal: chapter.index + 1,
                                }),
                            }}
                            artifact={linkedMaterial.synthesis.artifact}
                            t={t}
                            segments={linkedMaterial.segments}
                            onCite={(segment) => citeFrom(linked.id, segment)}
                            sourceName={linked.name}
                            sourceUrl={`/api/files/${linked.id}/content`}
                            pictures={`/api/visuals/${linked.id}/${linkedMaterial.sourceVersion}`}
                            concepts={catalog.concepts}
                            openConcept={openGlossaryConcept}
                            saved={session.artifacts?.[linked.id]}
                            persist={(value) =>
                              updateSession({
                                artifacts: {
                                  ...sessionRef.current!.artifacts,
                                  [linked.id]: value,
                                },
                              })
                            }
                          />
                        </div>
                      );
                    }
                    return (
                      <TutorArtifact
                        file={source}
                        files={catalog.files}
                        t={t}
                        onCite={(sourceId, segment) => citeFrom(sourceId, segment)}
                      />
                    );
                  }
                  const material =
                    learning?.sourceId === source.id ? learning : materialCache[source.id];
                  const reader = (
                    <StudyReader
                      key={`${source.id}:v${source.version}:${material?.createdAt || 'unprepared'}`}
                      attempts={catalog.attempts}
                      chapterSlot={source.id === active?.id ? chapterSlot : null}
                      navigate={(segment, heading) => citeFrom(source.id, segment, heading)}
                      quiz={(chapter, wasPlaying) => {
                        if (!material) return;
                        focusPane(source.id);
                        setQuizRequest({ source, learning: material, chapter, wasPlaying });
                      }}
                      cardTick={cardTick}
                      openCards={(chapterId, dueOnly) => {
                        if (!material) return;
                        focusPane(source.id);
                        setDeckRequest({ source, learning: material, chapterId, dueOnly });
                      }}
                      suspended={
                        !!quizRequest ||
                        !!deckRequest ||
                        assessmentOpen ||
                        (right && tab === 'review')
                      }
                      resumeSignal={
                        resumePlayback?.sourceId === source.id ? resumePlayback.nonce : 0
                      }
                      onPlaying={(value) => {
                        playbackStates.current[source.id] = value;
                      }}
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
                      onSelection={(location) => {
                        setSelection({ sourceId: source.id, location });
                        const range = location.quote
                          ? window.getSelection()?.getRangeAt(0)
                          : undefined;
                        const box = range?.getBoundingClientRect();
                        setSelectionMenu(
                          box && box.width + box.height > 0
                            ? { sourceId: source.id, x: box.left + box.width / 2, y: box.top }
                            : null,
                        );
                      }}
                      position={session.positions[source.id] || 0}
                      onPosition={(value) => {
                        if (source.kind === 'pdf')
                          setSelection((current) =>
                            current?.sourceId === source.id && current.location.page !== value
                              ? null
                              : current,
                          );
                        if (sessionRef.current?.id === session.id) savePosition(source, value);
                      }}
                      seek={seek?.sourceId === source.id ? seek : null}
                    />
                  );
                  return (
                    <>
                      {artifact === source.id ? (
                        <div
                          className={
                            artifactSplit === source.id ? 'artifact-split' : 'artifact-host'
                          }
                        >
                          {material?.synthesis.artifact ? (
                            <ArtifactVersions
                              key={source.id}
                              sourceId={source.id}
                              latest={material.synthesis.artifact}
                              t={t}
                              onSaved={() => setRefreshTick((value) => value + 1)}
                              header={
                                <Button variant="ghost" onClick={() => openFile(source, 'retain')}>
                                  <ArrowLeft size={14} />
                                  {t.originalSource}
                                </Button>
                              }
                              render={(shown, latest) => (
                                <GeneratedArtifact
                                  study={
                                    latest
                                      ? {
                                          sourceId: source.id,
                                          attempts: catalog.attempts,
                                          quiz: (chapter, version) =>
                                            setQuizRequest({
                                              source,
                                              learning: { ...material, createdAt: version },
                                              chapter: {
                                                id: chapter.id,
                                                title: chapter.title,
                                                summary: chapter.summary,
                                                segmentIds: chapter.segmentIds,
                                                questions: chapter.questions,
                                              },
                                              wasPlaying: false,
                                              artifactStudy: true,
                                              ordinal: chapter.index + 1,
                                            }),
                                        }
                                      : undefined
                                  }
                                  artifact={shown}
                                  t={t}
                                  segments={material.segments}
                                  onCite={(segment) => citeFromArtifact(source.id, segment)}
                                  sourceName={source.name}
                                  sourceUrl={`/api/files/${source.id}/content`}
                                  pictures={`/api/visuals/${source.id}/${material.sourceVersion}`}
                                  concepts={catalog.concepts}
                                  openConcept={openGlossaryConcept}
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
                              )}
                            />
                          ) : (
                            <div className="artifact-stage">
                              <Button variant="ghost" onClick={() => openFile(source, 'retain')}>
                                <ArrowLeft size={14} />
                                {t.originalSource}
                              </Button>
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
                            </div>
                          )}
                          {artifactSplit === source.id && (
                            <div className="artifact-split-source">
                              <div className="artifact-split-head">
                                <span>{source.name}</span>
                                <IconButton
                                  label={t.closeEvidence}
                                  onClick={() => setArtifactSplit(null)}
                                >
                                  <X />
                                </IconButton>
                              </div>
                              {reader}
                            </div>
                          )}
                        </div>
                      ) : (
                        reader
                      )}
                    </>
                  );
                }}
              </SplitWorkspace>
            </div>
          </>
        )}
      </main>
      {right && panels.resolved.right.docked && (
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
        hidden={!right}
        inert={!!panels.drawer && panels.drawer !== 'right'}
        className={`study-panel ${panels.resolved.right.docked ? 'docked' : 'floating'}${panels.narrow ? ' narrow' : ''}`}
        role={panels.drawer === 'right' ? 'dialog' : undefined}
        aria-modal={panels.drawer === 'right' ? true : undefined}
      >
        <div className="study-heading">
          <StudyTabs value={tab} change={setTab} t={t} />
          <div className="panel-heading-actions">
            {panels.narrow ? (
              <IconButton label={t.openFiles} onClick={() => setLeft(true)}>
                <PanelLeftOpen />
              </IconButton>
            ) : (
              <IconButton
                label={panels.preferences.right.pinned ? t.unpinPanel : t.pinPanel}
                aria-pressed={panels.preferences.right.pinned}
                onClick={() => panels.pin('right')}
              >
                {panels.preferences.right.pinned ? <Pin /> : <PinOff />}
              </IconButton>
            )}
            {!panels.resolved.right.docked && (
              <IconButton
                data-drawer-close
                label={panels.drawer === 'right' ? t.backToSession : t.close}
                onClick={() => setRight(false)}
              >
                <X />
              </IconButton>
            )}
          </div>
        </div>
        {!isPrimaryStudyTool(tab) && (
          <div className="study-auxiliary-heading">
            <Button variant="ghost" onClick={() => selectStudyTool('assistant')}>
              <ArrowLeft size={14} />
              {t.backToTutor}
            </Button>
            <h2 id="study-tool-title" tabIndex={-1}>
              {t[tab]}
            </h2>
          </div>
        )}
        <div
          id="study-content"
          role={isPrimaryStudyTool(tab) ? 'tabpanel' : 'region'}
          aria-labelledby={isPrimaryStudyTool(tab) ? `study-tab-${tab}` : 'study-tool-title'}
          className="study-content"
        >
          <div hidden={tab !== 'glossary'} className="glossary-host">
            <GlossaryPanel
              focusRequest={glossaryFocus}
              catalog={catalog}
              source={active}
              openSourceIds={[...new Set(resources.resourceTabs.flatMap((tab) => tab.sources))]}
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
              openSourceIds={[...new Set(resources.resourceTabs.flatMap((tab) => tab.sources))]}
              t={t}
              onError={setError}
              changed={async () => {
                const value = await refresh();
                // Tutor actions may have changed notes and bookmarks too.
                setAnnotationTick((tick) => tick + 1);
                return value;
              }}
              cite={citeFrom}
              openTest={(sessionId, testId) => {
                setAssessmentStart({ sessionId, selection: testId });
                setAssessmentOpen(true);
              }}
              openFile={(id) => {
                const file = catalog.files.find((item) => item.id === id);
                if (file) openFile(file, 'retain');
                else void refresh();
              }}
              treeActions={treeActions}
              prepareSource={(file) => {
                openFile(file, 'retain');
                setRight(true);
                setTab('chapters');
              }}
              createAttachment={async () => {
                if (!active) return null;
                const location = resourceLocation(active);
                const image = await captureSource(active, location);
                if (['pdf', 'video', 'image'].includes(active.kind) && !image)
                  throw new Error(t.captureNotReady);
                return {
                  id: crypto.randomUUID(),
                  sourceId: active.id,
                  location,
                  ...(image ? { capture: image } : {}),
                };
              }}
              questionRequest={questionRequest}
              consumeQuestion={() => setQuestionRequest(null)}
              incomingAttachment={incomingAttachment}
              consumeAttachment={() => setIncomingAttachment(null)}
              openConcept={(id) => {
                setGlossaryFocus({ id, nonce: crypto.randomUUID() });
                setRight(true);
                setTab('glossary');
              }}
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
              changed={() => setAnnotationTick((value) => value + 1)}
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
              composer={annotationInline ? annotationEditor(true) : null}
              attach={(item) =>
                void run(async () => {
                  const prepared = await api<QuestionAttachment>('/tutor-attachments', 'POST', {
                    kind: 'annotation',
                    annotationId: item.id,
                    revision: item.revision,
                    ...(item.captures?.length
                      ? { captureIds: item.captures.map((capture) => capture.id) }
                      : {}),
                    id: crypto.randomUUID(),
                    sessionId: session.id,
                  });
                  setIncomingAttachment({ id: crypto.randomUUID(), item: prepared });
                  setTab('assistant');
                  setRight(true);
                })
              }
              onError={setError}
            />
          ) : tab === 'review' ? (
            <ReviewPanel
              key={session.id}
              catalog={catalog}
              session={session}
              active={active}
              t={t}
              openConcept={openGlossaryConcept}
              assess={() => {
                setAssessmentStart({});
                setAssessmentOpen(true);
              }}
              refresh={refresh}
              practice={(id) => {
                const file = catalog.files.find((f) => f.id === id);
                if (file) {
                  openFile(file, 'retain');
                  setTab('practice');
                }
              }}
              cite={citeFrom}
              persist={(key, value) =>
                updateSession({ artifacts: { ...sessionRef.current!.artifacts, [key]: value } })
              }
              practiceReinforcement={(record) => {
                const material = reinforcementLearning(record),
                  source = catalog.files.find((f) => f.id === record.sourceId);
                if (!material || !source) {
                  setError(t.sourceUnavailable);
                  return;
                }
                setQuizRequest({
                  source,
                  learning: material,
                  chapter: material.synthesis.chapters[0],
                  wasPlaying: false,
                  reinforcement: { id: record.id, version: record.version },
                });
              }}
            />
          ) : !active ? (
            <div className="small-empty">
              <BookOpen size={24} />
              <p>{t.noSelectionBody}</p>
            </div>
          ) : (
            <>
              {tab === 'artifacts' && (
                <section className="study-artifact-entry">
                  <h2>{t.artifacts}</h2>
                  {learning?.synthesis.artifact ? (
                    <button
                      type="button"
                      className="artifact-card"
                      onClick={() => {
                        showArtifact(active.id);
                        if (panels.drawer === 'right') setRight(false);
                      }}
                    >
                      <strong>{learning.synthesis.artifact.title}</strong>
                      <small>
                        {active.name} · {new Date(learning.createdAt).toLocaleString()}
                      </small>
                    </button>
                  ) : (
                    <p className="muted">{t.noSourceArtifacts}</p>
                  )}
                  <p className="muted artifact-tutor-hint">{t.artifactTutorHint}</p>
                </section>
              )}
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
                        <Button
                          variant="ghost"
                          onClick={() =>
                            setQuizRequest({
                              source: active,
                              learning,
                              chapter,
                              wasPlaying: !!playbackStates.current[active.id],
                            })
                          }
                        >
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
                  <button
                    type="button"
                    className="artifact-card artifact-link"
                    onClick={() => showArtifact(active.id)}
                  >
                    <strong>
                      <Activity size={14} />
                      {t.artifact}
                    </strong>
                    <small>{t.artifactBody}</small>
                  </button>
                </>
              )}
              {tab === 'bookmarks' && (
                <BookmarksPanel
                  items={activeBookmarks}
                  composer={bookmarkInline ? bookmarkEditor(true) : null}
                  sourceName={active?.name}
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
                  jumpTo={(sourceId, location) => navigateAnnotation(sourceId, location)}
                  remove={async (item) => {
                    await run(async () => {
                      await api(`/annotations/${item.id}`, 'DELETE');
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
                    setCatalog((c) =>
                      c
                        ? {
                            ...c,
                            attempts: [...c.attempts.filter((a) => a.id !== attempt.id), attempt],
                          }
                        : c,
                    )
                  }
                  onError={setError}
                  onCite={cite}
                />
              )}
            </>
          )}
        </div>
        {panels.drawer === 'right' && !panels.narrow && (
          <PanelResizer
            side="right"
            className="floating-resizer"
            label={t.studyPanelWidth}
            help={t.resizeHelp}
            width={panels.resolved.right.width}
            max={panels.drawerMax}
            change={(value) => panels.resize('right', value)}
          />
        )}
      </aside>
      {deckRequest && (
        <FlashcardDeck
          key={`${deckRequest.source.id}:${deckRequest.learning.createdAt}:${deckRequest.chapterId || 'due'}`}
          request={deckRequest}
          t={t}
          close={() => setDeckRequest(null)}
          changed={() => setCardTick((tick) => tick + 1)}
          cite={(segment) => {
            setDeckRequest(null);
            citeFrom(deckRequest.source.id, segment);
          }}
        />
      )}
      {quizRequest && (
        <ChapterQuiz
          key={`${quizRequest.source.id}:${quizRequest.chapter.id}:${quizRequest.learning.createdAt}`}
          request={quizRequest}
          sessionId={session.id}
          attempts={catalog.attempts}
          t={t}
          onAttempt={(attempt) =>
            setCatalog((current) =>
              current
                ? {
                    ...current,
                    attempts: [...current.attempts.filter((a) => a.id !== attempt.id), attempt],
                  }
                : current,
            )
          }
          close={(resume) => {
            const request = quizRequest;
            setQuizRequest(null);
            if (!resume) return;
            // After a finished quiz, the chapter's due cards come next when its deck is ready.
            void api<DeckView[]>(`/flashcards/${request.source.id}`)
              .then((decks) =>
                decks.some(
                  (deck) =>
                    deck.chapterId === request.chapter.id &&
                    deck.status === 'ready' &&
                    deck.cards.some((card) => cardDue(card)),
                ),
              )
              .catch(() => false)
              .then((due) => {
                if (due)
                  setDeckRequest({
                    source: request.source,
                    learning: request.learning,
                    chapterId: request.chapter.id,
                    dueOnly: true,
                  });
                else if (request.wasPlaying)
                  setResumePlayback({ sourceId: request.source.id, nonce: Date.now() });
              });
          }}
          cite={(segment) => {
            setQuizRequest(null);
            citeFrom(quizRequest.source.id, segment);
          }}
        />
      )}
      {selectionMenu &&
        (() => {
          const source = catalog.files.find((file) => file.id === selectionMenu.sourceId);
          if (!source) return null;
          const done = () => setSelectionMenu(null);
          return (
            <div
              className="selection-menu"
              role="toolbar"
              aria-label={t.selectionActions}
              style={{
                left: Math.min(Math.max(selectionMenu.x, 120), window.innerWidth - 120),
                top: Math.max(selectionMenu.y - 8, 56),
              }}
            >
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  done();
                  void run(() => saveHighlight(source, resourceLocation(source)));
                }}
              >
                <Highlighter size={14} />
                {t.highlightShort}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  done();
                  void run(() => beginAnnotation(source.id, resourceLocation(source)));
                }}
              >
                <PenLine size={14} />
                {t.annotateShort}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  done();
                  setBookmarkIntent({ source, location: resourceLocation(source) });
                }}
              >
                <Bookmark size={14} />
                {t.bookmarkShort}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  done();
                  askAbout(source);
                }}
              >
                <MessageCircleQuestion size={14} />
                {t.askShort}
              </Button>
              <IconButton label={t.close} onClick={done}>
                <X />
              </IconButton>
            </div>
          );
        })()}
      {bookmarkIntent && !bookmarkInline && bookmarkEditor(false)}
      {assessmentOpen && (
        <ContentBoundary t={t} close={() => setAssessmentOpen(false)}>
          <Suspense
            fallback={
              <Modal title={t.assessmentTitle} close={() => setAssessmentOpen(false)}>
                <p>{t.loading}</p>
              </Modal>
            }
          >
            <AssessmentWorkspace
              key={assessmentStart.sessionId || session.id}
              sessionId={assessmentStart.sessionId || session.id}
              initialSelection={assessmentStart.selection}
              catalog={catalog}
              actions={treeActions}
              t={t}
              close={() => setAssessmentOpen(false)}
              beforeCreate={() => saveChain.current}
              changed={() => {
                setBookmarkTick((value) => value + 1);
                void refresh().catch((e) => setError((e as Error).message));
              }}
              navigate={(id, segment) => {
                setAssessmentOpen(false);
                citeFrom(id, segment);
              }}
              bookmark={(id) => {
                setAssessmentOpen(false);
                void run(async () => {
                  const note = await api<Annotation>(`/annotations/${id}`);
                  if (!note.sourceId || note.deleted) throw new Error(t.evidenceUnavailable);
                  navigateAnnotation(note.sourceId, note.location, note.title);
                });
              }}
              prepareFile={(id) => {
                setAssessmentOpen(false);
                const file = catalog.files.find((file) => file.id === id);
                if (file) {
                  openFile(file, 'retain');
                  setRight(true);
                  setTab('chapters');
                }
              }}
            />
          </Suspense>
        </ContentBoundary>
      )}
      {annotationRequest && !annotationInline && annotationEditor(false)}
      {processing && catalog && (
        <ProcessingPanel
          files={catalog.files.filter((f) => sourceState(f, catalog.directories) === 'files')}
          locale={locale}
          t={t}
          open={(file) => openFile(file, 'retain')}
          changed={() => void refresh()}
          close={() => setProcessing(false)}
        />
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
        directoryDialog.action !== 'create' &&
        directoryDialog.action !== 'rename' &&
        (() => {
          const dialog = directoryDialog,
            folder = 'directory' in dialog ? dialog.directory : null,
            item = 'file' in dialog ? dialog.file : null,
            path = folder ? `/directories/${folder.id}` : `/files/${item!.id}`;
          // Study artifacts linked to the file being deleted (or to any file inside the folder).
          const insideFolder = folder
            ? (file: Source) => containsPath(folder.path, file.folder)
            : (file: Source) => file.id === item!.id;
          const linkedArtifacts = catalog.files
            .filter(
              (file) =>
                file.kind === 'artifact' &&
                !file.trashed &&
                file.linkedSourceId &&
                catalog.files.some(
                  (other) => other.id === file.linkedSourceId && insideFolder(other),
                ),
            )
            .map((file) => ({ id: file.id, name: file.name }));
          return (
            <DeleteModal
              t={t}
              title={folder ? t.deleteDirectoryTitle : t.deleteFileTitle}
              name={folder ? folder.path : item!.name}
              files={
                folder
                  ? catalog.files.filter((file) => containsPath(folder.path, file.folder)).length
                  : 1
              }
              folders={
                folder
                  ? catalog.directories.filter(
                      (directory) =>
                        directory.id !== folder.id && containsPath(folder.path, directory.path),
                    ).length
                  : 0
              }
              linkedArtifacts={linkedArtifacts}
              close={() => setDirectoryDialog(null)}
              purgePath={path}
              // Archiving is the reversible alternative, unless the item already is archived.
              archive={
                (folder ? folder.archived : item!.archived)
                  ? undefined
                  : async () => {
                      if (folder) await directoryMutation(folder, 'archive');
                      else await editFile(item!, { archived: true });
                      setDirectoryDialog(null);
                    }
              }
              submit={async (concepts, extraFileIds) => {
                await saveChain.current;
                await api(
                  concepts.length ? `${path}?concepts=${concepts.join(',')}` : path,
                  'DELETE',
                );
                for (const id of extraFileIds)
                  await api(`/files/${id}`, 'DELETE').catch(() => undefined);
                const data = await refresh();
                if (sessionRef.current) commitWorkspace(usable(sessionRef.current, data));
                setDirectoryDialog(null);
              }}
            />
          );
        })()}
      {sessionChoice && (
        <Modal
          title={t.sessionChoiceTitle}
          close={() => setSessionChoice(null)}
          closeLabel={t.close}
          className="session-choice"
        >
          <p>{t.sessionChoiceBody.replace('{file}', sessionChoice.file.name)}</p>
          <ul className="session-choice-list">
            {sessionChoice.sessions.map((item) => {
              const preview = sessionPreview(item, catalog.files, catalog.conversations);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSessionChoice(null);
                      selectSession(item);
                      if (panels.drawer === 'left') setLeft(false);
                    }}
                  >
                    <strong>{item.name}</strong>
                    <small>
                      {new Date(item.createdAt).toLocaleDateString(locale)} · {preview.count}{' '}
                      {t.messagesShort}
                    </small>
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="modal-actions">
            <Button
              onClick={() => {
                const { file, mode } = sessionChoice;
                setSessionChoice(null);
                openFile(file, mode, true);
              }}
            >
              {t.sessionChoiceHere}
            </Button>
          </div>
        </Modal>
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
            current={uploading}
            error={error}
            cancel={() => uploadAbort.current?.abort()}
            catalog={catalog}
            initialDirectoryId={uploadDirectoryId}
            actions={treeActions}
            submit={(files, folder, directoryId, uploaded) =>
              void run(() => addFiles(files, folder, directoryId, uploaded))
            }
          />
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
      {deletingSession &&
        (() => {
          const threads = (catalog?.conversations || []).filter(
              (item) => item.sessionId === deletingSession.id,
            ),
            answering = threads.find(conversationHasWork);
          return (
            <Modal
              title={t.deleteSessionTitle.replace('{name}', deletingSession.name)}
              close={() => !removingSession && setDeletingSession(null)}
              closeLabel={t.cancel}
            >
              <div className="home-delete">
                <p>
                  {t.deleteSessionWarning.replace(
                    '{conversations}',
                    `${threads.length} ${
                      threads.length === 1 ? t.sessionConversation : t.sessionConversations
                    }`,
                  )}
                </p>
                {sessionDeleteError && (
                  <p role="alert" className="notice">
                    {sessionDeleteError}
                  </p>
                )}
                {answering && (
                  <p role="alert" className="notice">
                    {t.deleteSessionAnswering.replace('{name}', answering.name)}
                  </p>
                )}
                <div className="home-delete-actions">
                  <Button
                    variant="ghost"
                    disabled={removingSession}
                    onClick={() => setDeletingSession(null)}
                  >
                    {t.cancel}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={removingSession || !!answering}
                    onClick={() => void removeSession(deletingSession)}
                  >
                    <Trash2 size={14} />
                    {removingSession ? t.deletingSession : t.deleteSessionAction}
                  </Button>
                </div>
              </div>
            </Modal>
          );
        })()}
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
          submit={async (value) => {
            await editFile(rename, { name: value });
            setModal(null);
          }}
        />
      )}
      {modal === 'split' && (
        <Modal
          title={splitRequest?.mode === 'replace' ? t.replaceResource : t.chooseSplit}
          close={() => setModal(null)}
          closeLabel={t.close}
        >
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <input
              aria-label={t.search}
              placeholder={t.search}
              value={splitQuery}
              onChange={(event) => setSplitQuery(event.target.value)}
            />
          </label>
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
      <AgentPanel
        t={t}
        locale={locale}
        project={location.pathname.match(/^\/projects\/([\w-]+)/)?.[1]}
      />
    </div>
    </TypingPauseContext.Provider>
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
  const [practiceRun] = useState(() => crypto.randomUUID());
  const operations = useRef<Record<string, { fingerprint: string; id: string }>>({});
  const checking = useRef(false);
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
                disabled={!!results[q.id] || !!pending}
                maxLength={4000}
                value={written[q.id] || ''}
                onChange={(e) => setWritten((v) => ({ ...v, [q.id]: e.target.value }))}
              />
            ) : (
              questionChoices(q, t).map((choice, index) => (
                <label key={index} className={answers[q.id] === index ? 'chosen' : ''}>
                  <input
                    type="radio"
                    name={q.id}
                    disabled={!!results[q.id] || !!pending}
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
                (q.kind === 'short' ? !written[q.id]?.trim() : answers[q.id] == null) || !!pending
              }
              onClick={async () => {
                if (checking.current) return;
                checking.current = true;
                setPending(q.id);
                try {
                  const input = {
                    sourceId: source.id,
                    sourceVersion: source.version,
                    learningVersion: learning!.createdAt,
                    runId: practiceRun,
                    questionId: q.id,
                    ...(q.kind === 'short'
                      ? { answer: written[q.id].trim() }
                      : { selected: answers[q.id] }),
                  };
                  const fingerprint = JSON.stringify(input),
                    previous = operations.current[q.id];
                  const operation =
                    previous?.fingerprint === fingerprint
                      ? previous
                      : { fingerprint, id: crypto.randomUUID() };
                  operations.current[q.id] = operation;
                  const result = await api<Attempt>('/attempts', 'POST', {
                    ...input,
                    requestId: operation.id,
                  });
                  setResults((r) => ({ ...r, [q.id]: result }));
                  onAttempt(result);
                } catch (e) {
                  onError(e instanceof Error ? e.message : t.error);
                } finally {
                  checking.current = false;
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
    [webAuto, setWebAuto] = useState(initial.webAuto),
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
            await save({ locale, model, webAuto, ...(key.trim() ? { apiKey: key.trim() } : {}) });
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
        <label className="settings-check">
          <input
            type="checkbox"
            checked={webAuto}
            onChange={(event) => setWebAuto(event.target.checked)}
          />
          <span>
            {t.webAuto}
            <small>{t.webAutoHint}</small>
          </span>
        </label>
        <p className="credential-notice">{t.keyStorage}</p>
        <p className="credential-notice">
          {initial.dataDir
            ? t.dataLocation.replace('{path}', initial.dataDir)
            : t.dataLocationDefault}
        </p>
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
          <Button variant="ghost" onClick={close}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function DeleteModal({
  t,
  title,
  name,
  files,
  folders,
  purgePath,
  linkedArtifacts = [],
  close,
  archive,
  submit,
}: {
  t: T;
  title: string;
  name: string;
  files: number;
  folders: number;
  /** The file or folder route, also used to find concepts that cite only it. */
  purgePath: string;
  /** Study artifacts that live beside this item and can be removed with it. */
  linkedArtifacts?: Array<{ id: string; name: string }>;
  close: () => void;
  archive?: () => Promise<void>;
  submit: (concepts: string[], extraFileIds: string[]) => Promise<void>;
}) {
  const [pending, setPending] = useState(false),
    [error, setError] = useState('');
  const [concepts, setConcepts] = useState<Array<{ id: string; term: string }> | null>(null),
    [chosen, setChosen] = useState<Set<string>>(new Set()),
    [removeArtifacts, setRemoveArtifacts] = useState<Set<string>>(
      () => new Set(linkedArtifacts.map((entry) => entry.id)),
    );
  useEffect(() => {
    let live = true;
    api<{ concepts: Array<{ id: string; term: string }> }>(`${purgePath}/purge-preview`)
      .then((value) => {
        if (!live) return;
        setConcepts(value.concepts);
        setChosen(new Set(value.concepts.map((concept) => concept.id)));
      })
      .catch(() => live && setConcepts([]));
    return () => {
      live = false;
    };
  }, [purgePath]);
  async function attempt(work: () => Promise<void>) {
    setPending(true);
    setError('');
    try {
      await work();
    } catch (error) {
      setError(error instanceof Error ? error.message : t.error);
    } finally {
      setPending(false);
    }
  }
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
      <p>{t.deletePermanentlyExplanation}</p>
      <p className="muted">
        {t.affectedItems.replace('{files}', String(files)).replace('{folders}', String(folders))}
      </p>
      {archive && <p className="muted">{t.archiveHint}</p>}
      {concepts === null && <LoadingRow>{t.loading}</LoadingRow>}
      {linkedArtifacts.length > 0 && (
        <fieldset className="purge-concepts">
          <legend>{t.linkedArtifactsTitle}</legend>
          <p className="muted">{t.linkedArtifactsBody}</p>
          <ul>
            {linkedArtifacts.map((artifact) => (
              <li key={artifact.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={removeArtifacts.has(artifact.id)}
                    onChange={(event) => {
                      const next = new Set(removeArtifacts);
                      if (event.target.checked) next.add(artifact.id);
                      else next.delete(artifact.id);
                      setRemoveArtifacts(next);
                    }}
                  />
                  {artifact.name}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {!!concepts?.length && (
        <fieldset className="purge-concepts">
          <legend>{t.purgeConceptsTitle.replace('{n}', String(concepts.length))}</legend>
          <p className="muted">{t.purgeConceptsBody}</p>
          <ul>
            {concepts.map((concept) => (
              <li key={concept.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(concept.id)}
                    onChange={(event) => {
                      const next = new Set(chosen);
                      if (event.target.checked) next.add(concept.id);
                      else next.delete(concept.id);
                      setChosen(next);
                    }}
                  />
                  {concept.term}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="modal-actions">
        {archive && (
          <Button disabled={pending} onClick={() => void attempt(archive)}>
            <Archive size={16} />
            {t.archiveInstead}
          </Button>
        )}
        <Button
          variant="danger"
          disabled={pending || concepts === null}
          onClick={() => void attempt(() => submit([...chosen], [...removeArtifacts]))}
        >
          <Trash2 size={16} />
          {t.deletePermanently}
        </Button>
        <Button variant="ghost" disabled={pending} onClick={close}>
          {t.cancel}
        </Button>
      </div>
    </Modal>
  );
}
