import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  FileStack,
  LibraryBig,
  BookOpen,
} from 'lucide-react';
import type { T } from '../i18n';
import type { AssessmentSummary } from '../../shared/assessments';
import type { Source, StudySession } from '../../shared/domain';
import { api } from '../api';
import { Button } from '../design/components';

export const libraryTabs = ['library', 'sessions', 'tests'] as const;
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

const tabIcons = { library: LibraryBig, sessions: BookOpen, tests: ClipboardCheck };

export function LibraryTabs({
  value,
  change,
  counts,
  t,
}: {
  value: LibraryTab;
  change: (value: LibraryTab) => void;
  counts: Record<LibraryTab, number | string>;
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
            <span className="library-tab-count">{counts[tab]}</span>
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
  t,
  grow = false,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
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
  sourceId: string;
  title: string;
  kind: string;
  createdAt: string;
};

export function ArtifactList({
  files,
  refreshKey,
  open,
  t,
}: {
  files: Source[];
  refreshKey: unknown;
  open: (file: Source) => void;
  t: T;
}) {
  const [items, setItems] = useState<LibraryArtifact[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    api<LibraryArtifact[]>('/artifacts')
      .then((value) => live && (setItems(value), setError('')))
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [refreshKey]);
  const byId = new Map(files.map((file) => [file.id, file]));
  const visible = (items || []).filter((item) => byId.has(item.sourceId));
  if (error) return <p className="panel-section-note error">{error}</p>;
  if (!items) return <p className="panel-section-note">{t.loading}</p>;
  if (!visible.length) return <p className="panel-section-note">{t.noLibraryArtifacts}</p>;
  return (
    <ul className="artifact-list">
      {visible.map((item) => {
        const file = byId.get(item.sourceId)!;
        return (
          <li key={item.sourceId}>
            <button type="button" onClick={() => open(file)}>
              <FileStack size={16} aria-hidden="true" />
              <span>
                <span>{item.title}</span>
                <small title={file.name}>{file.name}</small>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
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

export function TestsList({
  tests,
  sessions,
  currentSessionId,
  review,
  openTest,
  t,
  locale,
}: {
  tests: ReturnType<typeof useTests>;
  sessions: StudySession[];
  currentSessionId: string;
  review: () => void;
  openTest: (test: AssessmentSummary) => void;
  t: T;
  locale: string;
}) {
  const names = new Map(sessions.map((session) => [session.id, session.name]));
  const finished = (test: AssessmentSummary) => ['completed', 'cancelled'].includes(test.status);
  const groups = [
    { id: 'tests-open', title: t.testsInProgress, items: tests.items.filter((x) => !finished(x)) },
    { id: 'tests-done', title: t.testsCompleted, items: tests.items.filter(finished) },
  ];
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <>
      <div className="tests-review">
        <Button variant="primary" onClick={review}>
          <Activity size={15} />
          {t.reviewLearning}
        </Button>
        <p>{t.reviewLearningHint}</p>
      </div>
      {tests.error && <p className="panel-section-note error">{tests.error}</p>}
      {!tests.loaded ? (
        <p className="panel-section-note">{t.loading}</p>
      ) : !tests.items.length ? (
        <p className="panel-section-note">{t.noTests}</p>
      ) : (
        groups.map(
          (group) =>
            group.items.length > 0 && (
              <PanelSection key={group.id} id={group.id} title={group.title} t={t}>
                <ul className="test-list">
                  {group.items.map((test) => (
                    <li key={test.id}>
                      <button
                        type="button"
                        className={test.sessionId === currentSessionId ? 'current-session' : ''}
                        onClick={() => openTest(test)}
                      >
                        <ClipboardCheck size={16} aria-hidden="true" />
                        <span>
                          <span title={test.title}>{test.title}</span>
                          <small>
                            {t[`assessmentStatus_${test.status}`]} ·{' '}
                            {date.format(new Date(test.updatedAt))}
                          </small>
                          <small title={names.get(test.sessionId)}>
                            {t.testSessionLabel}: {names.get(test.sessionId) || '—'}
                          </small>
                        </span>
                        <ChevronRight size={13} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </PanelSection>
            ),
        )
      )}
    </>
  );
}
