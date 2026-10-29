import { useEffect, useRef, useState } from 'react';
import { CircleCheck, FileText, Folder, LoaderCircle, Search, Upload, X } from 'lucide-react';
import type { Catalog } from '../../shared/domain';
import { directoryState } from '../../shared/directories';
import { Button } from '../design/components';
import type { T } from '../i18n';
import { DirectoryTree, type TreeActions } from './DirectoryTree';

export function UploadForm({
  t,
  busy,
  progress,
  current,
  error,
  cancel,
  catalog,
  initialDirectoryId,
  actions,
  submit,
}: {
  t: T;
  busy: boolean;
  progress: number | null;
  current: { name: string; index: number; total: number } | null;
  error: string;
  cancel: () => void;
  catalog: Catalog;
  initialDirectoryId: string | null;
  actions: TreeActions;
  submit: (
    files: File[],
    folder: string,
    directoryId: string | undefined,
    uploaded: (file: File) => void,
  ) => void;
}) {
  const [directoryId, setDirectoryId] = useState(initialDirectoryId),
    [files, setFiles] = useState<File[]>([]),
    [done, setDone] = useState<Set<File>>(new Set()),
    [query, setQuery] = useState(''),
    [dragging, setDragging] = useState(false),
    // The tree opens only to choose a destination: when none was given, or on request.
    [picking, setPicking] = useState(!initialDirectoryId),
    input = useRef<HTMLInputElement>(null);
  const remaining = files.filter((file) => !done.has(file));
  useEffect(() => {
    setDirectoryId(initialDirectoryId);
    setPicking(!initialDirectoryId);
  }, [initialDirectoryId]);
  const selected = catalog.directories.find((directory) => directory.id === directoryId);
  useEffect(() => {
    if (
      directoryId &&
      (!selected || directoryState(selected.path, catalog.directories) !== 'files')
    ) {
      setDirectoryId(null);
      setPicking(true);
    }
  }, [directoryId, catalog.directories]);
  const { upload: _, ...pickerActions } = actions;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        // A retry sends only the files that have not finished uploading.
        submit(remaining, selected?.path || '', selected?.id, (file) =>
          setDone((previous) => new Set(previous).add(file)),
        );
      }}
    >
      <fieldset className="upload-section destination-picker" disabled={busy}>
        <h3>{t.destination}</h3>
        {picking ? (
          <>
            <p className="upload-section-hint">{t.destinationHint}</p>
            <p className="destination-path">{selected?.path || t.libraryRoot}</p>
            <label className="search-field">
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                aria-label={t.searchFolders}
                placeholder={t.searchFolders}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <DirectoryTree
              mode="folder"
              directories={catalog.directories}
              files={catalog.files}
              t={t}
              query={query}
              selectedFolderId={directoryId}
              chooseFolder={(directory) => {
                setDirectoryId(directory?.id || null);
                setPicking(false);
                setQuery('');
              }}
              actions={pickerActions}
              storageKey="tl:tree:upload-picker"
            />
          </>
        ) : (
          <div className="destination-summary">
            <Folder size={16} aria-hidden="true" />
            <p className="destination-path">{selected?.path || t.libraryRoot}</p>
            <Button size="sm" variant="ghost" onClick={() => setPicking(true)}>
              {t.changeDestination}
            </Button>
          </div>
        )}
      </fieldset>
      <section
        className={`upload-section upload-files ${dragging ? 'drop-active' : ''}`}
        onDragOver={(event) => {
          if (busy || !event.dataTransfer.types.includes('Files')) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          setDragging(false);
          if (busy || !event.dataTransfer.files.length) return;
          event.preventDefault();
          setFiles([...event.dataTransfer.files]);
          setDone(new Set());
        }}
      >
        <h3>{t.uploadFiles}</h3>
        <p className="upload-section-hint">PDF · MP4 · MP3 · WAV · PNG · JPG · MD · TXT</p>
        <Button className="upload-choose" disabled={busy} onClick={() => input.current?.click()}>
          <Upload size={16} />
          {t.chooseFiles}
        </Button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          aria-label={t.chooseFiles}
          disabled={busy}
          accept=".pdf,.mp4,.webm,.mov,.mkv,.wav,.mp3,.m4a,.ogg,.flac,.png,.jpg,.jpeg,.webp,.md,.txt,.csv,.vtt,.srt"
          onChange={(event) => {
            setFiles([...(event.target.files || [])]);
            setDone(new Set());
          }}
        />
      </section>
      {files.map((file, index) => (
        <p className={`upload-file ${done.has(file) ? 'done' : ''}`} key={index}>
          {done.has(file) ? <CircleCheck size={14} /> : <FileText size={14} />}
          {file.name}
          <span>
            {done.has(file)
              ? t.uploaded
              : current?.name === file.name && progress != null
                ? `${progress} %`
                : `${(file.size / 1024 / 1024).toFixed(1)} MB`}
          </span>
        </p>
      ))}
      {current && progress != null && (
        <div className="upload-current" role="status">
          <span>
            {current.name} · {progress} %
            {current.total > 1 && ` · ${current.index + 1}/${current.total}`}
          </span>
          <Button size="sm" variant="ghost" onClick={cancel}>
            <X size={14} />
            {t.cancel}
          </Button>
          <progress max={100} value={progress} aria-label={t.progress} />
        </div>
      )}
      {error && !busy && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="muted">
        {t.maxSize} {t.noKeyNeeded}
      </p>
      <div className="modal-actions">
        <Button type="submit" variant="primary" disabled={!remaining.length || busy}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
          {done.size && remaining.length ? t.retryUpload : t.upload}
        </Button>
      </div>
    </form>
  );
}
