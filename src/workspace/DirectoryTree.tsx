import { useLayoutEffect, useRef, useState } from 'react';
import {
  Archive,
  ChevronRight,
  CircleCheck,
  FileImage,
  FileText,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Headphones,
  PenLine,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
import { fold, type Directory, type Source } from '../../shared/domain';
import {
  containsPath,
  directoryName,
  directoryState,
  parentPath,
  sourceState,
  type CatalogView,
} from '../../shared/directories';
import { ActionMenu, type MenuAction } from '../design/ActionMenu';
import { Button } from '../design/components';
import type { T } from '../i18n';

export type TreeActions = {
  create: (parentPath: string) => void;
  renameDirectory: (directory: Directory) => void;
  archiveDirectory: (directory: Directory, restore: boolean) => void;
  trashDirectory: (directory: Directory) => void;
  restoreDirectory: (directory: Directory) => void;
  upload: (directory: Directory) => void;
  renameFile: (source: Source) => void;
  archiveFile: (source: Source, restore: boolean) => void;
  trashFile: (source: Source) => void;
  restoreFile: (source: Source) => void;
};

export function DirectoryTree({
  directories,
  files,
  t,
  mode = 'manage',
  view = 'files',
  query = '',
  active,
  selectedFolderId,
  chooseFile,
  chooseFolder,
  actions,
  storageKey,
  selectedFileIds,
  fileCounts,
  toggleFile,
  disabledFileIds,
  fileStatuses,
}: {
  directories: Directory[];
  files: Source[];
  t: T;
  mode?: 'manage' | 'file' | 'folder' | 'filter';
  view?: CatalogView;
  query?: string;
  active?: string;
  selectedFolderId?: string | null;
  chooseFile?: (file: Source, mode: 'preview' | 'retain') => void;
  chooseFolder?: (directory: Directory | null) => void;
  actions: TreeActions;
  storageKey: string;
  selectedFileIds?: Set<string>;
  fileCounts?: Map<string, number>;
  toggleFile?: (file: Source, checked: boolean) => void;
  disabledFileIds?: Set<string>;
  fileStatuses?: Map<string, string>;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`${storageKey}:collapsed`) || '[]'));
    } catch {
      return new Set();
    }
  });
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    let wasVisible = false;
    const restore = () => {
      const visible = node.clientHeight > 0;
      if (visible && !wasVisible) {
        try {
          node.scrollTop = Number(localStorage.getItem(`${storageKey}:${view}:scroll`)) || 0;
        } catch {}
      }
      wasVisible = visible;
    };
    const observer = new ResizeObserver(restore);
    observer.observe(node);
    restore();
    return () => observer.disconnect();
  }, [storageKey, view]);
  const toggle = (directory: Directory) =>
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(directory.id)) next.delete(directory.id);
      else next.add(directory.id);
      try {
        localStorage.setItem(`${storageKey}:collapsed`, JSON.stringify([...next]));
      } catch {}
      return next;
    });
  const needle = fold(query);
  const visibleFiles =
    mode === 'folder'
      ? []
      : files.filter(
          (file) =>
            (mode === 'filter'
              ? sourceState(file, directories) !== 'trash'
              : sourceState(file, directories) === view) &&
            fold(`${file.folder}/${file.name}`).includes(needle),
        );
  const matchingDirectories = directories.filter(
    (directory) =>
      (mode === 'filter'
        ? visibleFiles.some((file) => containsPath(directory.path, file.folder))
        : directoryState(directory.path, directories) === view) &&
      (!needle ||
        fold(directory.path).includes(needle) ||
        visibleFiles.some((file) => containsPath(directory.path, file.folder))),
  );
  const paths = new Set<string>();
  for (const path of [
    ...matchingDirectories.map((directory) => directory.path),
    ...visibleFiles.map((file) => file.folder),
  ]) {
    let current = path;
    while (current) {
      paths.add(current);
      current = parentPath(current);
    }
  }
  const directoryActions = (directory: Directory): MenuAction[] => {
    const state = directoryState(directory.path, directories),
      parentState = directoryState(parentPath(directory.path), directories);
    if (state === 'trash')
      return directory.trashed
        ? [
            {
              label: t.restore,
              icon: <RotateCcw size={16} />,
              disabled: parentState === 'trash',
              run: () => actions.restoreDirectory(directory),
            },
          ]
        : [];
    return [
      ...(state === 'files'
        ? [
            {
              label: t.createSubfolder,
              icon: <FolderPlus size={16} />,
              run: () => actions.create(directory.path),
            },
            { label: t.upload, icon: <Upload size={16} />, run: () => actions.upload(directory) },
          ]
        : []),
      {
        label: t.rename,
        icon: <PenLine size={16} />,
        separator: state === 'files',
        run: () => actions.renameDirectory(directory),
      },
      state === 'archived'
        ? {
            label: t.restore,
            icon: <RotateCcw size={16} />,
            disabled: !directory.archived || parentState !== 'files',
            run: () => actions.archiveDirectory(directory, true),
          }
        : {
            label: t.archive,
            icon: <Archive size={16} />,
            run: () => actions.archiveDirectory(directory, false),
          },
      {
        label: t.deleteDirectory,
        icon: <Trash2 size={16} />,
        danger: true,
        separator: true,
        run: () => actions.trashDirectory(directory),
      },
    ];
  };
  const fileActions = (file: Source): MenuAction[] => {
    if (mode === 'file')
      return [
        {
          label: t.chooseFile,
          icon: <FileText size={16} />,
          run: () => chooseFile?.(file, 'preview'),
        },
      ];
    const parentState = directoryState(file.folder, directories);
    if (view === 'trash')
      return file.trashed
        ? [
            {
              label: t.restore,
              icon: <RotateCcw size={16} />,
              disabled: parentState === 'trash',
              run: () => actions.restoreFile(file),
            },
          ]
        : [];
    return [
      ...(mode === 'manage'
        ? [
            {
              label: t.openCurrent,
              icon: <FileText size={16} />,
              run: () => chooseFile?.(file, 'preview'),
            },
            {
              label: t.openSeparate,
              icon: <Plus size={16} />,
              run: () => chooseFile?.(file, 'retain'),
            },
          ]
        : []),
      {
        label: t.rename,
        icon: <PenLine size={16} />,
        separator: mode === 'manage',
        run: () => actions.renameFile(file),
      },
      view === 'archived'
        ? {
            label: t.restore,
            icon: <RotateCcw size={16} />,
            disabled: !file.archived || parentState !== 'files',
            run: () => actions.archiveFile(file, true),
          }
        : {
            label: t.archive,
            icon: <Archive size={16} />,
            run: () => actions.archiveFile(file, false),
          },
      {
        label: t.deleteFile,
        icon: <Trash2 size={16} />,
        danger: true,
        separator: true,
        run: () => actions.trashFile(file),
      },
    ];
  };
  const context = (event: React.MouseEvent) => {
    const button = event.currentTarget.querySelector<HTMLButtonElement>('[data-menu-trigger]');
    if (button) {
      event.preventDefault();
      button.click();
    }
  };
  const render = (parent: string): React.ReactNode => (
    <ul>
      {directories
        .filter((directory) => parentPath(directory.path) === parent && paths.has(directory.path))
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((directory) => {
          const expanded = !!needle || !collapsed.has(directory.id),
            contextOnly = mode !== 'filter' && directoryState(directory.path, directories) !== view;
          const Icon = expanded ? FolderOpen : Folder;
          return (
            <li
              className={`directory-node ${contextOnly ? 'context-directory' : ''}`}
              key={directory.id}
            >
              <div
                className={`tree-row directory-row ${selectedFolderId === directory.id ? 'selected' : ''}`}
                onContextMenu={context}
              >
                <button
                  type="button"
                  className="directory-disclosure"
                  aria-label={`${expanded ? t.collapse : t.expand}: ${directoryName(directory.path)}`}
                  aria-expanded={expanded}
                  onClick={() => toggle(directory)}
                >
                  <ChevronRight size={13} />
                </button>
                <button
                  type="button"
                  className="directory-label"
                  title={directory.path}
                  onClick={() =>
                    mode === 'folder' && !contextOnly
                      ? chooseFolder?.(directory)
                      : toggle(directory)
                  }
                >
                  <Icon size={16} />
                  <span>{directoryName(directory.path)}</span>
                </button>
                {!contextOnly && mode !== 'filter' && (
                  <ActionMenu
                    label={`${t.directoryOptions}: ${directory.path}`}
                    icon={<Plus size={16} />}
                    actions={directoryActions(directory)}
                  />
                )}
              </div>
              {expanded && render(directory.path)}
            </li>
          );
        })}
      {visibleFiles
        .filter((file) => file.folder === parent)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((file) => {
          const Icon =
            file.kind === 'video'
              ? Film
              : file.kind === 'audio'
                ? Headphones
                : file.kind === 'image'
                  ? FileImage
                  : FileText;
          return (
            <li key={file.id}>
              <div
                className={`tree-row file-row ${active === file.id ? 'active' : ''}`}
                onContextMenu={context}
              >
                {mode === 'filter' ? (
                  <label className="tree-file-select">
                    <input
                      type="checkbox"
                      aria-label={`${t.includeResource}: ${file.name}`}
                      checked={!!selectedFileIds?.has(file.id)}
                      disabled={disabledFileIds?.has(file.id)}
                      onChange={(event) => toggleFile?.(file, event.target.checked)}
                    />
                    <Icon size={16} />
                    <span title={file.name}>{file.name}</span>
                    {fileStatuses?.has(file.id) && <small>{fileStatuses.get(file.id)}</small>}
                    <small
                      aria-label={`${fileCounts?.get(file.id) || 0} ${fileCounts?.get(file.id) === 1 ? t.annotationSingular : t.annotationCount}`}
                    >
                      {fileCounts?.get(file.id) || 0}
                    </small>
                  </label>
                ) : (
                  <button
                    type="button"
                    data-file-choice={file.id}
                    title={view === 'trash' ? `${file.name} · ${t.restoreToOpen}` : file.name}
                    disabled={view === 'trash'}
                    onClick={() => chooseFile?.(file, 'preview')}
                    onDoubleClick={() => chooseFile?.(file, 'retain')}
                  >
                    <Icon size={16} />
                    <span>{file.name}</span>
                    {file.reviewed && (
                      <CircleCheck className="reviewed-marker" size={16} aria-label={t.reviewed}>
                        <title>{t.reviewed}</title>
                      </CircleCheck>
                    )}
                  </button>
                )}
                {mode !== 'filter' && (
                  <ActionMenu label={`${t.options}: ${file.name}`} actions={fileActions(file)} />
                )}
              </div>
            </li>
          );
        })}
    </ul>
  );
  return (
    <div
      className="directory-tree"
      ref={scroller}
      onScroll={(event) => {
        if (!event.currentTarget.clientHeight) return;
        try {
          localStorage.setItem(
            `${storageKey}:${view}:scroll`,
            String(event.currentTarget.scrollTop),
          );
        } catch {}
      }}
    >
      {mode === 'folder' && (
        <button
          type="button"
          className={`directory-root ${!selectedFolderId ? 'selected' : ''}`}
          onClick={() => chooseFolder?.(null)}
        >
          <Folder size={16} />
          {t.libraryRoot}
        </button>
      )}
      {mode !== 'manage' && mode !== 'filter' && (
        <div className="tree-picker-actions">
          <Button onClick={() => actions.create('')}>
            <FolderPlus size={16} />
            {t.newFolder}
          </Button>
        </div>
      )}
      {render('')}
      {!matchingDirectories.length && !visibleFiles.length && (
        <p className="small-empty">{needle ? t.noResults : t.noFiles}</p>
      )}
    </div>
  );
}
