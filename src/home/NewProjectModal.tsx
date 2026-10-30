import { useEffect, useState, type FormEvent } from 'react';
import { BookOpen, Sparkles } from 'lucide-react';
import type { ProjectSummary } from '../../shared/projects';
import { api } from '../api';
import { Button, Modal } from '../design/components';
import type { Locale } from '../../shared/domain';
import type { T } from '../i18n';

type Course = {
  path: string;
  title: string;
  files: number;
  videos: number;
  documents: number;
  bytes: number;
  pack: { files: number; locale: string; exportedAt: string } | null;
  project: string | null;
};
const size = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
/** The downloaded courses to start a project from, with what each one holds. */
function CourseList({
  t,
  selected,
  choose,
}: {
  t: T;
  selected: Course | null;
  choose: (course: Course) => void;
}) {
  const [courses, setCourses] = useState<{ root: string | null; courses: Course[] } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    void api<{ root: string | null; courses: Course[] }>('/courses')
      .then(setCourses)
      .catch((e) => setError((e as Error).message));
  }, []);
  if (error)
    return (
      <p role="alert" className="notice">
        {error}
      </p>
    );
  if (!courses) return <p className="muted">{t.loading}</p>;
  if (!courses.root) return <p className="muted">{t.noCoursesFolder}</p>;
  if (!courses.courses.length)
    return <p className="muted">{t.noCourses.replace('{folder}', courses.root)}</p>;
  return (
    <ul className="course-choices" role="radiogroup" aria-label={t.courseChoose}>
      {courses.courses.map((course) => (
        <li key={course.path}>
          <button
            type="button"
            role="radio"
            aria-checked={selected?.path === course.path}
            disabled={!!course.project}
            onClick={() => choose(course)}
          >
            <BookOpen size={16} aria-hidden="true" />
            <span>
              <strong>{course.title}</strong>
              <small>
                {t.courseContents
                  .replace('{videos}', String(course.videos))
                  .replace('{documents}', String(course.documents))
                  .replace('{size}', size(course.bytes))}
              </small>
              <small>
                {course.project
                  ? t.courseAlreadyProject.replace('{name}', course.project)
                  : course.pack
                    ? t.coursePrepared.replace('{n}', String(course.pack.files))
                    : t.courseNotPrepared}
              </small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Names a new project, which starts empty or from a downloaded course: the course's files are
 * copied into the library in their folders, with or without the material prepared for them.
 */
export function NewProjectModal({
  t,
  locale,
  close,
  created,
}: {
  t: T;
  locale: Locale;
  close: () => void;
  created: (project: ProjectSummary) => void;
}) {
  const [start, setStart] = useState<'empty' | 'course'>('empty'),
    [course, setCourse] = useState<Course | null>(null),
    [withPack, setWithPack] = useState(false),
    [prepare, setPrepare] = useState<'none' | 'videos' | 'all'>('none'),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const ready = !!name.trim() && (start === 'empty' || !!course);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      created(
        await api<ProjectSummary>(
          '/projects',
          'POST',
          start === 'course'
            ? {
                name,
                course: course!.path,
                pack: withPack,
                prepare: withPack ? 'none' : prepare,
                locale,
              }
            : { name },
        ),
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t.newProject}
      close={() => !busy && close()}
      closeLabel={t.cancel}
      className="new-project-modal"
    >
      <form className="new-project" onSubmit={(e) => void submit(e)}>
        <div className="new-project-start" role="tablist" aria-label={t.projectStart}>
          {(['empty', 'course'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={start === value}
              onClick={() => setStart(value)}
            >
              {value === 'empty' ? t.projectStartEmpty : t.projectStartCourse}
            </button>
          ))}
        </div>
        {start === 'course' && (
          <CourseList
            t={t}
            selected={course}
            choose={(value) => {
              setCourse(value);
              setWithPack(!!value.pack);
              if (!name.trim() || name === course?.title) setName(value.title.slice(0, 120));
            }}
          />
        )}
        <label>
          <span>{t.projectName}</span>
          <input
            autoFocus
            value={name}
            maxLength={120}
            placeholder={t.projectNamePlaceholder}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {start === 'course' && course && (
          <fieldset>
            <legend>{t.courseImport}</legend>
            <label className="new-project-choice">
              <input
                type="radio"
                name="mode"
                checked={withPack}
                disabled={!course.pack}
                onChange={() => setWithPack(true)}
              />
              <span>
                <Sparkles size={14} aria-hidden="true" /> {t.courseWithPack}
                <small>{course.pack ? t.courseWithPackHint : t.courseWithPackMissing}</small>
              </span>
            </label>
            <label className="new-project-choice">
              <input
                type="radio"
                name="mode"
                checked={!withPack}
                onChange={() => setWithPack(false)}
              />
              <span>
                {t.courseFilesOnly}
                <small>{t.courseFilesOnlyHint}</small>
              </span>
            </label>
            {!withPack && (
              <label className="new-project-prepare">
                <span>{t.coursePrepareNow}</span>
                <select
                  value={prepare}
                  onChange={(e) => setPrepare(e.target.value as typeof prepare)}
                >
                  <option value="none">{t.coursePrepareNone}</option>
                  <option value="videos">{t.coursePrepareVideos}</option>
                  <option value="all">{t.coursePrepareAll}</option>
                </select>
                <small>{t.coursePrepareNowHint}</small>
              </label>
            )}
          </fieldset>
        )}
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        <div className="home-delete-actions">
          <Button variant="ghost" disabled={busy} onClick={close}>
            {t.cancel}
          </Button>
          <Button type="submit" variant="primary" disabled={!ready || busy}>
            {busy ? t.creatingProject : t.createProject}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
