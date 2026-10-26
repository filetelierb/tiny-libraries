import { useEffect, useState } from 'react';
import { FileText, LoaderCircle, Upload } from 'lucide-react';
import type { Catalog } from '../../shared/domain';
import { directoryState } from '../../shared/directories';
import { Button } from '../design/components';
import type { T } from '../i18n';
import { DirectoryTree, type TreeActions } from './DirectoryTree';

export function UploadForm({
  t,
  busy,
  progress,
  catalog,
  initialDirectoryId,
  actions,
  submit,
}: {
  t: T;
  busy: boolean;
  progress: number | null;
  catalog: Catalog;
  initialDirectoryId: string | null;
  actions: TreeActions;
  submit: (files: File[], folder: string, directoryId?: string) => void;
}) {
  const [directoryId, setDirectoryId] = useState(initialDirectoryId),
    [files, setFiles] = useState<File[]>([]),
    [query, setQuery] = useState('');
  useEffect(() => setDirectoryId(initialDirectoryId), [initialDirectoryId]);
  const selected = catalog.directories.find((directory) => directory.id === directoryId);
  useEffect(() => {
    if (
      directoryId &&
      (!selected || directoryState(selected.path, catalog.directories) !== 'files')
    )
      setDirectoryId(null);
  }, [directoryId, catalog.directories]);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit(files, selected?.path || '', selected?.id);
      }}
    >
      <fieldset className="destination-picker" disabled={busy}>
        <legend>{t.destination}</legend>
        <p className="destination-path">{selected?.path || t.libraryRoot}</p>
        <input
          type="search"
          aria-label={t.searchFolders}
          placeholder={t.searchFolders}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <DirectoryTree
          mode="folder"
          directories={catalog.directories}
          files={catalog.files}
          t={t}
          query={query}
          selectedFolderId={directoryId}
          chooseFolder={(directory) => setDirectoryId(directory?.id || null)}
          actions={actions}
          storageKey="tl:tree:upload-picker"
        />
      </fieldset>
      <label className="upload-drop">
        <Upload size={28} />
        <strong>{t.chooseFile}</strong>
        <span>PDF · MP4 · MP3 · WAV · PNG · JPG · MD · TXT</span>
        <input
          type="file"
          multiple
          aria-label={t.chooseFile}
          disabled={busy}
          accept=".pdf,.mp4,.webm,.mov,.mkv,.wav,.mp3,.m4a,.ogg,.flac,.png,.jpg,.jpeg,.webp,.md,.txt,.csv"
          onChange={(event) => setFiles([...(event.target.files || [])])}
        />
      </label>
      {files.map((file, index) => (
        <p className="upload-file" key={index}>
          <FileText size={14} />
          {file.name}
          <span>{(file.size / 1024 / 1024).toFixed(1)} MB</span>
        </p>
      ))}
      {progress != null && <progress max={100} value={progress} aria-label={t.progress} />}
      <p className="muted">
        {t.maxSize} {t.noKeyNeeded}
      </p>
      <div className="modal-actions">
        <Button type="submit" variant="primary" disabled={!files.length || busy}>
          {busy ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}
          {t.upload}
        </Button>
      </div>
    </form>
  );
}
