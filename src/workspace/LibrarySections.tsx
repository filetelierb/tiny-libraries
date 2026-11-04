import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  ClipboardPen,
  ClipboardPlus,
  ClipboardX,
  FileStack,
  LibraryBig,
  BookOpen,
  RefreshCw,
  Search,
} from 'lucide-react';
import type { T } from '../i18n';
import type { AssessmentSummary } from '../../shared/assessments';
import type { Source, StudySession } from '../../shared/domain';
import { api } from '../api';
import { Button, IconButton, LoadingRow } from '../design/components';

export const libraryTabs = ['library', 'sessions', 'artifacts', 'tests'] as const;
export type LibraryTab = (typeof libraryTabs)[number];
const tabKey = 'tl:library-tab';

export function useLibraryTab() {
  const [value, setValue] = useState<LibraryTab>(() => {
    try {
      const saved = localStorage.getItem(tabKey);
      return (libraryTabs as readonly string[]).includes(saved || '')
        ? (saved as LibraryTab)
        : 'library';
    } catch {
      return 'library';
    }
  });
  function change(next: LibraryTab) {
    setValue(next);
    try {
      localStorage.setItem(tabKey, next);
    } catch {}
  }
  return [value, change] as const;
}

const tabIcons = {
  library: LibraryBig,
  sessions: BookOpen,
  artifacts: FileStack,
  tests: ClipboardCheck,
};

export function LibraryTabs({
  value,
  change,
  t,
}: {
  value: LibraryTab;
  change: (value: LibraryTab) => void;
  t: T;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const focusAfterChange = useRef(false);
  useEffect(() => {
    if (!focusAfterChange.current) return;
    strip.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    focusAfterChange.current = false;
  }, [value]);
  const labels: Record<LibraryTab, string> = {
    library: t.library,
    sessions: t.sessionsTab,
    artifacts: t.artifacts,
    tests: t.tests,
  };
  return (
    <div className="library-tabs" role="tablist" aria-label={t.libraryTabs} ref={strip}>
      {libraryTabs.map((tab, index) => {
        const Icon = tabIcons[tab];
        return (
          <button
            key={tab}
            id={`library-tab-${tab}`}
            type="button"
            role="tab"
            aria-selected={value === tab}
            aria-controls="library-content"
            tabIndex={value === tab ? 0 : -1}
            title={labels[tab]}
            className={value === tab ? 'active' : ''}
            onClick={() => change(tab)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === 'ArrowRight') next = (index + 1) % libraryTabs.length;
              else if (event.key === 'ArrowLeft')
                next = (index + libraryTabs.length - 1) % libraryTabs.length;
              else if (event.key === 'Home') next = 0;
              else if (event.key === 'End') next = libraryTabs.length - 1;
              else return;
              event.preventDefault();
              focusAfterChange.current = true;
              change(libraryTabs[next]);
            }}
          >
            <Icon size={14} aria-hidden="true" />
            <span className="library-tab-label">{labels[tab]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A collapsible panel section whose open state persists in this browser. */
export function PanelSection({
  id,
  title,
  icon,
  actions,
  count,
  t,
  grow = false,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  count?: number;
  t: T;
  grow?: boolean;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const key = `tl:panel-section:${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? defaultOpen : saved === 'open';
    } catch {
      return defaultOpen;
    }
  });
  function toggle() {
    setOpen(!open);
    try {
      localStorage.setItem(key, open ? 'closed' : 'open');
    } catch {}
  }
  const bodyId = `panel-section-${id}`;
  return (
    <section className={`panel-section ${open ? 'open' : ''} ${grow && open ? 'grow' : ''}`}>
      <div className="panel-section-heading">
        <button
          type="button"
          className="panel-section-toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          title={open ? t.collapse : t.expand}
          onClick={toggle}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {icon}
          <span>{title}</span>
          {count !== undefined && <small className="panel-section-count">{count}</small>}
        </button>
        {actions && <div className="panel-section-actions">{actions}</div>}
      </div>
      {open && (
        <div className="panel-section-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  );
}

export type LibraryArtifact = {
  id: string;
  /** Tutor artifacts are library files of their own; sourceId is that file. */
  origin: 'source' | 'reinforcement' | 'tutor';
  sourceId: string;
  /** Review artifacts belong to the session that created them; source artifacts to the library. */
  sessionId?: string;
  title: string;
  kind: string;
  /** Latest version number; review artifacts have a single version. */
  revision?: number;
  createdAt: string;
};
const ARTIFACT_PAGE = 20;
export function useLibraryArtifacts(refreshKey: unknown) {
  const [items, setItems] = useState<LibraryArtifact[] | null>(null),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    api<LibraryArtifact[]>('/artifacts')
      .then((value) => live && (setItems(value), setError('')))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [refreshKey, reload]);
  return { items, error, reload: () => setReload((value) => value + 1) };
}

export function ArtifactList({
  files,
  artifacts,
  sessionId,
  sessions = [],
  open,
  t,
}: {
  files: Source[];
  artifacts: ReturnType<typeof useLibraryArtifacts>;
  sessionId: string;
  sessions?: StudySession[];
  open: (item: LibraryArtifact, file: Source) => void;
  t: T;
}) {
  const { items, error, reload } = artifacts;
  const [query, setQuery] = useState(''),
    [allSessions, setAllSessions] = useState(false),
    [limit, setLimit] = useState(ARTIFACT_PAGE);
  const sessionName = new Map(sessions.map((session) => [session.id, session.name]));
  const byId = new Map(files.map((file) => [file.id, file]));
  const available = (items || []).filter(
    (item) =>
      byId.has(item.sourceId) && (allSessions || !item.sessionId || item.sessionId === sessionId),
  );
  const needle = query.trim().toLocaleLowerCase();
  const visible = available.filter((item) =>
    `${item.title} ${byId.get(item.sourceId)!.name}`.toLocaleLowerCase().includes(needle),
  );
  const toolbar = (
    <div className="artifact-list-tools">
      <p className="panel-section-hint">{t.artifactListHint}</p>
      <label className="search-field">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          aria-label={t.filterArtifacts}
          placeholder={t.filterArtifacts}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <IconButton label={t.refreshArtifacts} onClick={reload}>
        <RefreshCw />
      </IconButton>
      <label className="artifact-scope">
        <input
          type="checkbox"
          checked={allSessions}
          onChange={(event) => setAllSessions(event.target.checked)}
        />
        {t.showAllSessions}
      </label>
    </div>
  );
  if (error)
    return (
      <>
        {toolbar}
        <p className="panel-section-note error" role="alert">
          {error}
        </p>
      </>
    );
  if (!items) return <LoadingRow>{t.loading}</LoadingRow>;
  if (!available.length)
    return (
      <>
        {toolbar}
        <p className="panel-section-note">{t.noLibraryArtifacts}</p>
      </>
    );
  return (
    <>
      {toolbar}
      {!visible.length && <p className="panel-section-note">{t.noResults}</p>}
      <ul className="artifact-list">
        {visible.slice(0, limit).map((item) => {
          const file = byId.get(item.sourceId)!;
          const session = item.sessionId && sessionName.get(item.sessionId);
          return (
            <li key={item.id}>
              <button type="button" onClick={() => open(item, file)}>
                <FileStack size={16} aria-hidden="true" />
                <span>
                  <span>{item.title}</span>
                  <small title={file.name}>
                    {[
                      item.origin === 'reinforcement'
                        ? t.reviewArtifact
                        : item.origin === 'tutor'
                          ? t.tutorArtifact
                          : '',
                      item.revision ? `v${item.revision}` : '',
                      session || '',
                      file.name,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {visible.length > limit && (
        <Button size="sm" variant="ghost" onClick={() => setLimit(limit + ARTIFACT_PAGE)}>
          {t.loadMore}
        </Button>
      )}
    </>
  );
}

export function useTests(refreshKey: unknown) {
  const [state, setState] = useState<{
    items: AssessmentSummary[];
    more: boolean;
    error: string;
    loaded: boolean;
  }>({ items: [], more: false, error: '', loaded: false });
  useEffect(() => {
    let live = true;
    api<{ items: AssessmentSummary[]; nextCursor: string | null }>('/assessments')
      .then(
        (value) =>
          live &&
          setState({ items: value.items, more: !!value.nextCursor, error: '', loaded: true }),
      )
      .catch(
        (e) =>
          live &&
          setState((current) => ({ ...current, error: (e as Error).message, loaded: true })),
      );
    return () => {
      live = false;
    };
  }, [refreshKey]);
  return state;
}

/** How a test reads at a glance in the list: its chip and icon. */
const testState = (status: AssessmentSummary['status']) =>
  status === 'completed'
    ? 'complete'
    : status === 'cancelled'
      ? 'cancelled'
      : status === 'failed' || status === 'interrupted'
        ? 'attention'
        : 'open';
const testIcons = {
  complete: ClipboardCheck,
  cancelled: ClipboardX,
  attention: ClipboardX,
  open: ClipboardPen,
} as const;

export function TestsList({
  tests,
  sessions,
  review,
  openTest,
  t,
  locale,
}: {
  tests: ReturnType<typeof useTests>;
  sessions: StudySession[];
  review: () => void;
  openTest: (test: AssessmentSummary) => void;
  t: T;
  locale: string;
}) {
  const names = new Map(sessions.map((session) => [session.id, session.name]));
  // Most recent activity first: answering a question or finishing a test moves it up.
  const items = [...tests.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <>
      <div className="tests-header">
        <h3>{t.myTests}</h3>
        <IconButton label={t.reviewLearning} title={t.reviewLearningHint} onClick={review}>
          <ClipboardPlus />
        </IconButton>
      </div>
      {tests.error && <p className="panel-section-note error">{tests.error}</p>}
      {!tests.loaded ? (
        <LoadingRow>{t.loading}</LoadingRow>
      ) : !items.length ? (
        <p className="panel-section-note">{t.noTests}</p>
      ) : (
        <ul className="test-list">
          {items.map((test) => {
            const state = testState(test.status),
              Icon = testIcons[state];
            return (
              <li key={test.id}>
                <button type="button" data-state={state} onClick={() => openTest(test)}>
                  <Icon size={16} aria-hidden="true" />
                  <span>
                    <span title={test.title}>{test.title}</span>
                    <small>
                      <span
                        className={`test-chip ${state}`}
                        title={t[`assessmentStatus_${test.status}`]}
                      >
                        {t[`testState_${state}`]}
                      </span>{' '}
                      {date.format(new Date(test.updatedAt))}
                    </small>
                    <small title={names.get(test.sessionId)}>
                      {t.testSessionLabel}: {names.get(test.sessionId) || '—'}
                    </small>
                  </span>
                  <ChevronRight size={13} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
