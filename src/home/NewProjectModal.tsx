import { useEffect, useState, type FormEvent } from 'react';
import { ChevronLeft, Folder, HardDrive } from 'lucide-react';
import type { ProjectSummary } from '../../shared/projects';
import { api } from '../api';
import { Button, Modal } from '../design/components';
import type { T } from '../i18n';

type Listing = { path: string | null; parent: string | null; folders: string[] };
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

/**
 * Names a new project and chooses where its files go: the library's own storage, or a folder
 * on this computer, such as one on an external disk, where they are kept as ordinary files.
 */
export function NewProjectModal({
  t,
  close,
  created,
}: {
  t: T;
  close: () => void;
  created: (project: ProjectSummary) => void;
}) {
  const [name, setName] = useState(''),
    [storage, setStorage] = useState<'library' | 'folder'>('library'),
    [folder, setFolder] = useState(''),
    [browsing, setBrowsing] = useState(false),
    [adopt, setAdopt] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const ready = !!name.trim() && (storage === 'library' || folder.trim().startsWith('/'));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      created(
        await api<ProjectSummary>('/projects', 'POST', {
          name,
          ...(storage === 'folder' ? { folder: folder.trim(), adopt } : {}),
        }),
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
                <Button onClick={() => setBrowsing((value) => !value)}>{t.browseFolders}</Button>
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
              <input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} />
              <span>
                {t.adoptFolderFiles}
                <small>{t.adoptFolderFilesHint}</small>
              </span>
            </label>
          </div>
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
