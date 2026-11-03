import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BookOpen,
  FilePlus,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleDashed,
  CircleDot,
  CircleHelp,
  Film,
  Hammer,
  Headphones,
  Languages,
  LayoutList,
  LoaderCircle,
  Sparkles,
  SquareStack,
} from 'lucide-react';
import type { AgentEvent, AgentTool } from '../shared/agent-events';
import type { ProjectSummary } from '../shared/projects';
import { api } from './api';
import { AgentFlow } from './AgentFlow';
import { useAgentEvents } from './useAgentEvents';
import type { T } from './i18n';

const OPEN_KEY = 'tl:agent-panel:open';
const HEIGHT_KEY = 'tl:agent-panel:height';
const VIEW_KEY = 'tl:agent-panel:view';
type View = 'list' | 'flow';
const MIN = 120,
  DEFAULT = Math.round(window.innerHeight / 3);

const toolIcons: Record<AgentTool, React.ComponentType<{ size?: number }>> = {
  preparation: Hammer,
  tutor: Sparkles,
  glossary: BookOpen,
  flashcards: SquareStack,
};

const actionIcons: Record<string, React.ComponentType<{ size?: number }>> = {
  'library.upload': FilePlus,
  'preparation.queued': CircleDashed,
  'normalize.start': Film,
  'normalize.done': Film,
  'transcribe.chunk': Headphones,
  'translate.done': Languages,
  'synthesize.part': LayoutList,
  'synthesize.done': LayoutList,
  'glossary.round': BookOpen,
  'glossary.ingest': BookOpen,
  'preparation.done': CircleDot,
  'flashcards.generate': SquareStack,
  'tutor.turn.start': Sparkles,
  'tutor.turn.done': CircleDot,
  'tutor.turn.failed': CircleAlert,
};

/** How long ago, in words, for the relative time beside each event. */
function timeAgo(at: string, locale: 'en' | 'es') {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
    seconds = Math.round((new Date(at).getTime() - Date.now()) / 1000);
  if (Math.abs(seconds) < 60) return format.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  return format.format(Math.round(minutes / 60), 'hour');
}

function elapsed(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000),
    seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

type EventRow = AgentEvent & { count: number; firstAt: string };

/**
 * Consecutive events of the same file/action (`transcribe.chunk`, `glossary.round`,
 * `synthesize.part`) collapse into a single running row, so a long preparation reads easily.
 */
function groupEvents(events: AgentEvent[]): EventRow[] {
  const grouped = ['transcribe.chunk', 'glossary.round', 'synthesize.part'];
  const rows: EventRow[] = [];
  for (const event of events) {
    const last = rows[rows.length - 1];
    if (
      last &&
      event.action === last.action &&
      event.fileId === last.fileId &&
      grouped.includes(event.action)
    ) {
      last.count += 1;
      last.firstAt = event.at;
      // The newest event's summary and progress win, so the latest step is visible.
      last.summary = event.summary;
      last.progress = event.progress;
      last.elapsedMs = event.elapsedMs;
      continue;
    }
    rows.push({ ...event, count: 1, firstAt: event.at });
  }
  return rows;
}

/**
 * A bottom panel that shows what the AI tools and the Librarian agent are doing, step by step.
 * It can be minimised to a thin bar; a handle at the top edge resizes it.
 */
export function AgentPanel({
  t,
  locale,
  project,
}: {
  t: T;
  locale: 'en' | 'es';
  /** Only this project's events are shown; omit for the home page to see every project. */
  project?: string;
}) {
  const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) === 'yes');
  const [height, setHeight] = useState(() => Number(localStorage.getItem(HEIGHT_KEY)) || DEFAULT);
  const [view, setView] = useState<View>(
    () => (localStorage.getItem(VIEW_KEY) as View | null) || 'flow',
  );
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, view);
  }, [view]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const events = useAgentEvents(open);
  useEffect(() => {
    void api<ProjectSummary[]>('/projects')
      .then(setProjects)
      .catch(() => {});
  }, []);
  useEffect(() => {
    localStorage.setItem(OPEN_KEY, open ? 'yes' : 'no');
  }, [open]);
  useEffect(() => {
    if (open) localStorage.setItem(HEIGHT_KEY, String(height));
  }, [height, open]);
  // Pages add their own padding below so the panel never covers content.
  useEffect(() => {
    const value = open ? `${height}px` : '44px';
    document.documentElement.style.setProperty('--agent-panel-height', value);
    return () => {
      document.documentElement.style.removeProperty('--agent-panel-height');
    };
  }, [open, height]);
  // Drag the top handle to resize the panel between MIN and 80% of the viewport.
  const dragging = useRef(false);
  useEffect(() => {
    const move = (event: MouseEvent) => {
      if (!dragging.current) return;
      event.preventDefault();
      const max = Math.max(MIN + 1, Math.round(window.innerHeight * 0.8));
      setHeight(Math.min(max, Math.max(MIN, window.innerHeight - event.clientY)));
    };
    const stop = () => {
      dragging.current = false;
      document.body.classList.remove('agent-dragging');
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
    };
  }, []);
  const scoped = useMemo(
    () => (project ? events.filter((event) => event.project === project) : events),
    [events, project],
  );
  const rows = useMemo(() => groupEvents(scoped), [scoped]);
  // A file still being prepared has an open step that no later `preparation.done` closes.
  const activeFiles = useMemo(() => {
    const seen = new Map<string, 'open' | 'done'>();
    for (const event of scoped) {
      if (event.tool !== 'preparation' || !event.fileId) continue;
      // Uploading a file does not count as a preparation step running.
      if (event.action === 'library.upload') continue;
      if (seen.has(event.fileId)) continue;
      seen.set(event.fileId, event.action === 'preparation.done' ? 'done' : 'open');
    }
    return [...seen.values()].filter((status) => status === 'open').length;
  }, [scoped]);
  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const projectColor = (id: string) => {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return `oklch(72% 0.12 ${hash % 360})`;
  };
  const toggle = () => setOpen((value) => !value);
  return (
    <aside
      className={`agent-panel ${open ? 'open' : 'closed'}`}
      style={open ? { height: `${height}px` } : undefined}
      aria-label={t.agentPanel}
    >
      <div
        className="agent-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t.agentPanelResize}
        tabIndex={open ? 0 : -1}
        onMouseDown={(event) => {
          if (!open) return;
          dragging.current = true;
          document.body.classList.add('agent-dragging');
          event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (!open) return;
          const max = Math.max(MIN + 1, Math.round(window.innerHeight * 0.8));
          if (event.key === 'ArrowUp') setHeight((h) => Math.min(max, h + 40));
          if (event.key === 'ArrowDown') setHeight((h) => Math.max(MIN, h - 40));
        }}
      />
      <div className="agent-header">
        <button type="button" className="agent-header-toggle" onClick={toggle} aria-expanded={open}>
          <Activity size={14} aria-hidden="true" />
          <strong>{t.agentPanel}</strong>
          <span className="agent-counts">
            {activeFiles > 0 ? (
              <>
                <LoaderCircle size={12} className="spin" aria-hidden="true" />
                {t.agentActive.replace('{n}', String(activeFiles))}
              </>
            ) : scoped.length ? (
              t.agentIdle.replace('{n}', String(scoped.length))
            ) : (
              t.agentWaiting
            )}
          </span>
        </button>
        {open && (
          <div className="agent-view-switch" role="tablist" aria-label={t.agentView}>
            {(['flow', 'list'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={view === option}
                onClick={() => setView(option)}
              >
                {option === 'flow' ? t.agentViewFlow : t.agentViewList}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="agent-header-chevron"
          onClick={toggle}
          aria-label={open ? t.collapse : t.expand}
        >
          {open ? (
            <ChevronDown size={16} aria-hidden="true" />
          ) : (
            <ChevronUp size={16} aria-hidden="true" />
          )}
        </button>
      </div>
      {open && view === 'flow' && (
        <div className="agent-flow-wrap">
          {rows.length ? (
            <AgentFlow events={scoped} locale={locale} t={t} />
          ) : (
            <p className="agent-empty">
              <CircleHelp size={14} aria-hidden="true" />
              <span>{t.agentEmpty}</span>
            </p>
          )}
        </div>
      )}
      {open && view === 'list' && (
        <ol className="agent-events" aria-live="polite">
          {rows.length === 0 ? (
            <li className="agent-empty">
              <CircleHelp size={14} aria-hidden="true" />
              <span>{t.agentEmpty}</span>
            </li>
          ) : (
            rows.map((row) => {
              const ToolIcon = toolIcons[row.tool] || Activity;
              const ActionIcon = actionIcons[row.action] || ToolIcon;
              const name = projectName.get(row.project) || t.projectUnknown;
              return (
                <li key={row.id} className={`agent-event ${row.tool}`}>
                  <span
                    className="agent-dot"
                    style={{ background: projectColor(row.project) }}
                    title={name}
                    aria-label={name}
                  />
                  <ActionIcon size={14} aria-hidden="true" />
                  <span className="agent-summary">
                    <strong>{row.summary}</strong>
                    <small>
                      {t[`agentTool_${row.tool}` as keyof T] as string}
                      {row.fileName ? ` · ${row.fileName}` : ''}
                      {row.count > 1
                        ? ` · ${t.agentRepeated.replace('{n}', String(row.count))}`
                        : ''}
                      {row.elapsedMs !== undefined ? ` · ${elapsed(row.elapsedMs)}` : ''}
                      {' · '}
                      {timeAgo(row.at, locale)}
                    </small>
                    {row.progress && (
                      <progress
                        max={row.progress.total}
                        value={row.progress.current}
                        aria-label={`${row.progress.current} of ${row.progress.total}`}
                      />
                    )}
                    {row.detail && <small className="agent-detail">{row.detail}</small>}
                  </span>
                </li>
              );
            })
          )}
        </ol>
      )}
    </aside>
  );
}
