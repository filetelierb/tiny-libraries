import { useEffect, useState, type FormEvent } from 'react';
import { BookOpen, Check, GraduationCap, PackageOpen, Pencil, Plus, Trash2, X } from 'lucide-react';
import {
  heatmapStart,
  localDay,
  type ActivityDay,
  type ProjectSummary,
} from '../../shared/projects';
import type { Locale, Settings } from '../../shared/domain';
import { api } from '../api';
import { Button, IconButton, LoadingRow, Modal } from '../design/components';
import { dictionaries, type T } from '../i18n';
import { ActivityHeatmap } from './ActivityHeatmap';
import { NewProjectModal } from './NewProjectModal';

function relativeTime(value: string, locale: Locale) {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }),
    minutes = Math.round((new Date(value).getTime() - Date.now()) / 60000);
  if (Math.abs(minutes) < 60) return format.format(minutes, 'minute');
  if (Math.abs(minutes) < 60 * 24) return format.format(Math.round(minutes / 60), 'hour');
  return format.format(Math.round(minutes / 60 / 24), 'day');
}
const plural = (n: number, one: string, other: string) => `${n} ${n === 1 ? one : other}`;

/** The start page: every project with its own library and sessions, and the activity graph. */
export function HomePage() {
  const [locale, setLocale] = useState<Locale>(
      () => (localStorage.getItem('tl:locale') as Locale) || 'en',
    ),
    [projects, setProjects] = useState<ProjectSummary[] | null>(null),
    [activity, setActivity] = useState<ActivityDay[]>([]),
    [error, setError] = useState(''),
    [creating, setCreating] = useState(false),
    [notice, setNotice] = useState(''),
    [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null),
    [deleting, setDeleting] = useState<ProjectSummary | null>(null),
    [confirmation, setConfirmation] = useState(''),
    [busy, setBusy] = useState(false);
  const t: T = dictionaries[locale];
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = 'Tailored Library';
  }, [locale]);
  function loadActivity() {
    // A week of margin covers either first day of the week.
    const start = heatmapStart(new Date(), 0);
    start.setDate(start.getDate() - 7);
    return api<ActivityDay[]>(`/activity?since=${localDay(start)}`).then(setActivity);
  }
  useEffect(() => {
    void Promise.all([
      api<Settings>('/settings').then((settings) => setLocale(settings.locale)),
      api<ProjectSummary[]>('/projects').then(setProjects),
      loadActivity(),
    ]).catch((e) => setError((e as Error).message));
  }, []);
  // A course still being copied updates its card until it is done.
  const copying = !!projects?.some(
    (project) => project.importing && project.importing.status !== 'failed',
  );
  useEffect(() => {
    if (!copying) return;
    const timer = setInterval(
      () =>
        void api<ProjectSummary[]>('/projects')
          .then(setProjects)
          .catch(() => {}),
      3000,
    );
    return () => clearInterval(timer);
  }, [copying]);
  async function remove() {
    if (!deleting || confirmation.trim() !== deleting.name.trim() || busy) return;
    setBusy(true);
    try {
      await api(`/projects/${deleting.id}`, 'DELETE');
      setProjects((current) => current!.filter((item) => item.id !== deleting.id));
      setDeleting(null);
      await loadActivity();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  /** Saves the project's prepared material beside its course, for projects made from it later. */
  async function exportPack(project: ProjectSummary) {
    if (busy) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      const { files } = await api<{ files: number }>(
        '/pack/export',
        'POST',
        {},
        { 'X-Project': project.id },
      );
      setNotice(t.exportedPack.replace('{n}', String(files)).replace('{name}', project.name));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function rename(event: FormEvent) {
    event.preventDefault();
    if (!renaming?.name.trim() || busy) return;
    setBusy(true);
    try {
      const project = await api<ProjectSummary>(`/projects/${renaming.id}`, 'PATCH', {
        name: renaming.name,
      });
      setProjects((current) =>
        current!.map((item) => (item.id === project.id ? { ...item, name: project.name } : item)),
      );
      setRenaming(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const sorted = [...(projects || [])].sort((a, b) =>
    (b.lastActiveAt || b.createdAt).localeCompare(a.lastActiveAt || a.createdAt),
  );
  return (
    <main className="home">
      <header className="home-header">
        <span className="home-mark" aria-hidden="true">
          <BookOpen size={18} />
        </span>
        <div>
          <h1>Tailored Library</h1>
          <p>{t.homeSubtitle}</p>
        </div>
      </header>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <section className="home-section" aria-labelledby="home-projects">
        <div className="home-section-heading">
          <h2 id="home-projects">{t.projects}</h2>
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus size={14} />
            {t.newProject}
          </Button>
        </div>
        {!projects ? (
          <LoadingRow>{t.loading}</LoadingRow>
        ) : (
          <ul className="home-projects">
            {sorted.map((project) => (
              <li key={project.id} className="home-project">
                {renaming?.id === project.id ? (
                  <form className="home-project-rename" onSubmit={(e) => void rename(e)}>
                    <label>
                      <span className="sr-only">{t.projectName}</span>
                      <input
                        autoFocus
                        value={renaming.name}
                        maxLength={120}
                        onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                        onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)}
                      />
                    </label>
                    <IconButton label={t.cancel} onClick={() => setRenaming(null)}>
                      <X size={14} />
                    </IconButton>
                    <IconButton
                      label={t.save}
                      type="submit"
                      disabled={!renaming.name.trim() || busy}
                    >
                      <Check size={14} />
                    </IconButton>
                  </form>
                ) : (
                  <>
                    <a
                      className="home-project-link"
                      href={`/projects/${project.id}`}
                      aria-label={t.openProjectLabel.replace('{name}', project.name)}
                    >
                      <span className="home-project-icon" aria-hidden="true">
                        {project.name.trim().charAt(0).toUpperCase()}
                      </span>
                      <strong>{project.name}</strong>
                      <span className="home-project-meta">
                        {plural(project.files, t.projectFile, t.projectFiles)} ·{' '}
                        {plural(project.sessions, t.projectSession, t.projectSessions)}
                      </span>
                      {project.course && (
                        <span className="home-project-course" title={project.course}>
                          <GraduationCap size={12} aria-hidden="true" />
                          {project.importing
                            ? project.importing.status === 'failed'
                              ? t.courseImportFailed.replace(
                                  '{error}',
                                  project.importing.error || '',
                                )
                              : project.importing.status === 'importing'
                                ? t.courseImportFinishing
                                : t.courseImportCopying
                                    .replace('{done}', String(project.importing.done))
                                    .replace('{total}', String(project.importing.total))
                            : project.course.split('/').pop()}
                        </span>
                      )}
                      <small>
                        {project.lastActiveAt
                          ? t.projectLastActive.replace(
                              '{when}',
                              relativeTime(project.lastActiveAt, locale),
                            )
                          : t.projectNoActivity}
                      </small>
                    </a>
                    <div className="home-project-tools">
                      {project.course && !project.importing && (
                        <IconButton
                          label={t.exportPack}
                          disabled={busy}
                          onClick={() => void exportPack(project)}
                        >
                          <PackageOpen size={14} />
                        </IconButton>
                      )}
                      <IconButton
                        label={t.renameProject}
                        onClick={() => setRenaming({ id: project.id, name: project.name })}
                      >
                        <Pencil size={14} />
                      </IconButton>
                      {/* The first library keeps the app settings, so it cannot be deleted. */}
                      {project.id !== 'default' && (
                        <IconButton
                          label={t.deleteProject}
                          onClick={() => {
                            setConfirmation('');
                            setDeleting(project);
                          }}
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      )}
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="home-section" aria-labelledby="home-activity">
        <div className="home-section-heading">
          <h2 id="home-activity">{t.activity}</h2>
        </div>
        <div className="home-card">
          <ActivityHeatmap
            activity={activity}
            projectNames={new Map((projects || []).map((p) => [p.id, p.name]))}
            locale={locale}
            t={t}
          />
        </div>
      </section>
      {creating && (
        <NewProjectModal
          t={t}
          locale={locale}
          close={() => setCreating(false)}
          created={(project) => (location.href = `/projects/${project.id}`)}
        />
      )}
      {deleting && (
        <Modal
          title={t.deleteProjectTitle.replace('{name}', deleting.name)}
          close={() => !busy && setDeleting(null)}
          closeLabel={t.cancel}
          className="home-delete-modal"
        >
          <form
            className="home-delete"
            onSubmit={(event) => {
              event.preventDefault();
              void remove();
            }}
          >
            <p>
              {t.deleteProjectWarning
                .replace('{files}', plural(deleting.files, t.projectFile, t.projectFiles))
                .replace(
                  '{sessions}',
                  plural(deleting.sessions, t.projectSession, t.projectSessions),
                )}
            </p>
            {deleting.course && <p className="muted">{t.deleteProjectCourseKept}</p>}
            <label>
              <span>{t.deleteProjectConfirm.replace('{name}', deleting.name)}</span>
              <input
                autoFocus
                autoComplete="off"
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </label>
            <div className="home-delete-actions">
              <Button variant="ghost" disabled={busy} onClick={() => setDeleting(null)}>
                {t.cancel}
              </Button>
              <Button
                type="submit"
                variant="danger"
                disabled={busy || confirmation.trim() !== deleting.name.trim()}
              >
                <Trash2 size={14} />
                {busy ? t.deletingProject : t.deleteProjectAction}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </main>
  );
}
