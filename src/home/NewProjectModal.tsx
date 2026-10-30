import { useEffect, useState, type FormEvent } from 'react';
import { BookOpen, ChevronLeft, Folder, HardDrive, Sparkles } from 'lucide-react';
import type { ProjectSummary } from '../../shared/projects';
import { api } from '../api';
import { Button, Modal } from '../design/components';
import type { Locale } from '../../shared/domain';
import type { T } from '../i18n';

type Listing = { path: string | null; parent: string | null; folders: string[] };
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
const nameOf = (path: string) => path.split('/').filter(Boolean).pop() || path;

/** Sub-folders of a folder on this computer, starting from the home folder and the disks. */
function FolderBrowser({ t, choose }: { t: T; choose: (path: string) => void }) {
  const [listing, setListing] = useState<Listing | null>(null),
    [error, setError] = useState('');
  const open = (path?: string) =>
    api<Listing>(`/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`)
      .then((value) => {
        setListing(value);
        setError('');
      })
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void open();
  }, []);
  return (
    <div className="folder-browser">
      <div className="folder-browser-heading">
        {listing?.path ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void open(listing.parent || undefined)}
            aria-label={t.folderUp}
          >
            <ChevronLeft size={14} />
          </Button>
        ) : null}
        <strong title={listing?.path || undefined}>{listing?.path || t.folderPlaces}</strong>
        {listing?.path && (
          <Button size="sm" onClick={() => choose(listing.path!)}>
            {t.useThisFolder}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      <ul>
        {listing?.folders.map((path) => (
          <li key={path}>
            <button type="button" onClick={() => void open(path)}>
              {listing.path ? <Folder size={14} /> : <HardDrive size={14} />}
              <span>{listing.path ? nameOf(path) : path}</span>
            </button>
          </li>
        ))}
        {listing && !listing.folders.length && <li className="muted">{t.noSubfolders}</li>}
      </ul>
    </div>
  );
}

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
                  ? t.courseAlreadyProject
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
 * Names a new project and chooses where its files go: the library's own storage, or a folder
 * on this computer, such as one on an external disk, where they are kept as ordinary files.
 * A project can also start from a downloaded course, with or without its prepared material.
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
    [prepareNow, setPrepareNow] = useState(false),
    [name, setName] = useState(''),
    [storage, setStorage] = useState<'library' | 'folder'>('library'),
    [folder, setFolder] = useState(''),
    [browsing, setBrowsing] = useState(false),
    [adopt, setAdopt] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const ready =
    !!name.trim() &&
    (start === 'course' ? !!course : storage === 'library' || folder.trim().startsWith('/'));
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
                folder: course!.path,
                adopt: true,
                pack: withPack,
                prepare: !withPack && prepareNow ? 'videos' : 'none',
                locale,
              }
            : { name, ...(storage === 'folder' ? { folder: folder.trim(), adopt } : {}) },
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
              <label className="settings-check">
                <input
                  type="checkbox"
                  checked={prepareNow}
                  onChange={(e) => setPrepareNow(e.target.checked)}
                />
                <span>
                  {t.coursePrepareNow}
                  <small>{t.coursePrepareNowHint}</small>
                </span>
              </label>
            )}
          </fieldset>
        )}
        {start === 'empty' && (
          <>
            <fieldset>
              <legend>{t.projectStorage}</legend>
              <label className="new-project-choice">
                <input
                  type="radio"
                  name="storage"
                  checked={storage === 'library'}
                  onChange={() => setStorage('library')}
                />
                <span>
                  {t.projectStorageLibrary}
                  <small>{t.projectStorageLibraryHint}</small>
                </span>
              </label>
              <label className="new-project-choice">
                <input
                  type="radio"
                  name="storage"
                  checked={storage === 'folder'}
                  onChange={() => setStorage('folder')}
                />
                <span>
                  {t.projectStorageFolder}
                  <small>{t.projectStorageFolderHint}</small>
                </span>
              </label>
            </fieldset>
            {storage === 'folder' && (
              <div className="new-project-folder">
                <label>
                  <span>{t.projectFolderPath}</span>
                  <div className="new-project-path">
                    <input
                      value={folder}
                      spellCheck={false}
                      placeholder={t.projectFolderPlaceholder}
                      onChange={(e) => setFolder(e.target.value)}
                    />
                    <Button onClick={() => setBrowsing((value) => !value)}>
                      {t.browseFolders}
                    </Button>
                  </div>
                </label>
                {browsing && (
                  <FolderBrowser
                    t={t}
                    choose={(path) => {
                      setFolder(path);
                      setBrowsing(false);
                    }}
                  />
                )}
                <label className="settings-check">
                  <input
                    type="checkbox"
                    checked={adopt}
                    onChange={(e) => setAdopt(e.target.checked)}
                  />
                  <span>
                    {t.adoptFolderFiles}
                    <small>{t.adoptFolderFilesHint}</small>
                  </span>
                </label>
              </div>
            )}
          </>
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
