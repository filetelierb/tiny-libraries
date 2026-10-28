import { useLayoutEffect, useRef, useState } from 'react';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  CircleCheck,
  File,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  PenLine,
  Plus,
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
import { ResourceIcon } from '../design/ResourceIcon';
import type { T } from '../i18n';

export type TreeActions = {
  create: (parentPath: string) => void;
  renameDirectory: (directory: Directory) => void;
  archiveDirectory: (directory: Directory, restore: boolean) => void;
  upload: (directory: Directory) => void;
  renameFile: (source: Source) => void;
  archiveFile: (source: Source, restore: boolean) => void;
  /** Deleting is permanent; the confirmation offers archiving instead. */
  deleteFile: (source: Source) => void;
  deleteDirectory: (directory: Directory) => void;
  moveFile?: (source: Source, folder: string) => void;
  moveDirectory?: (directory: Directory, parentPath: string) => void;
};
/** Drag payload for a library file; the tutor composer accepts it as a reference. */
export const RESOURCE_DRAG_TYPE = 'application/x-tailored-resource';
type TreeDrag = { kind: 'file'; item: Source } | { kind: 'directory'; item: Directory };

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
  editable = true,
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
  /** False for choose-only pickers that never create or edit folders. */
  editable?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`${storageKey}:collapsed`) || '[]'));
    } catch {
      return new Set();
    }
  });
  // Deep folders start collapsed; this remembers the ones the student opened.
  const [expandedDeep, setExpandedDeep] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(`${storageKey}:expanded`) || '[]'));
    } catch {
      return new Set();
    }
  });
  const scroller = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<TreeDrag | null>(null),
    [dropTarget, setDropTarget] = useState<string | null>(null);
  const movable = editable && mode === 'manage' && view === 'files';
  const canDrop = (destination: string) =>
    !!dragged &&
    (dragged.kind === 'file'
      ? dragged.item.folder !== destination
      : parentPath(dragged.item.path) !== destination &&
        !containsPath(dragged.item.path, destination));
  const drop = (destination: string) => {
    if (!dragged || !canDrop(destination)) return;
    if (dragged.kind === 'file') actions.moveFile?.(dragged.item, destination);
    else actions.moveDirectory?.(dragged.item, destination);
    setDragged(null);
    setDropTarget(null);
  };
  const dropZone = (destination: string) =>
    movable
      ? {
          onDragOver: (event: React.DragEvent) => {
            if (!dragged) return;
            event.stopPropagation();
            if (!canDrop(destination)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropTarget(destination);
          },
          onDragLeave: (event: React.DragEvent) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDropTarget((current) => (current === destination ? null : current));
          },
          onDrop: (event: React.DragEvent) => {
            if (!dragged) return;
            event.preventDefault();
            event.stopPropagation();
            drop(destination);
          },
        }
      : {};
  const dragSource = (drag: TreeDrag) => ({
    draggable: mode === 'manage' && view === 'files',
    onDragStart: (event: React.DragEvent) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = 'copyMove';
      if (drag.kind === 'file')
        event.dataTransfer.setData(
          RESOURCE_DRAG_TYPE,
          JSON.stringify({ id: drag.item.id, name: drag.item.name }),
        );
      event.dataTransfer.setData(
        'text/plain',
        drag.kind === 'file' ? drag.item.name : drag.item.path,
      );
      if (movable) setDragged(drag);
    },
    onDragEnd: () => {
      setDragged(null);
      setDropTarget(null);
    },
  });
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
  const isCollapsed = (directory: Directory) =>
    collapsed.has(directory.id) ||
    (collapsedByDefault(directory) && !expandedDeep.has(directory.id));
  const toggle = (directory: Directory) => {
    const open = isCollapsed(directory);
    const update = (set: Set<string>, add: boolean, key: string) => {
      const next = new Set(set);
      if (add) next.add(directory.id);
      else next.delete(directory.id);
      try {
        localStorage.setItem(`${storageKey}:${key}`, JSON.stringify([...next]));
      } catch {}
      return next;
    };
    setCollapsed((previous) => update(previous, !open, 'collapsed'));
    if (collapsedByDefault(directory))
      setExpandedDeep((previous) => update(previous, open, 'expanded'));
  };
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
            icon: <ArchiveRestore size={16} />,
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
        run: () => actions.deleteDirectory(directory),
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
    return [
      ...(mode === 'manage'
        ? [
            {
              label: t.openCurrent,
              icon: <File size={16} />,
              tone: 'primary' as const,
              run: () => chooseFile?.(file, 'preview'),
            },
            {
              label: t.openSeparate,
              icon: <Plus size={16} />,
              tone: 'primary' as const,
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
            icon: <ArchiveRestore size={16} />,
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
        run: () => actions.deleteFile(file),
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
          const expanded = !!needle || !isCollapsed(directory),
            contextOnly = mode !== 'filter' && directoryState(directory.path, directories) !== view;
          const Icon = expanded ? FolderOpen : Folder;
          return (
            <li
              className={`directory-node ${contextOnly ? 'context-directory' : ''}`}
              key={directory.id}
              {...(contextOnly ? {} : dropZone(directory.path))}
            >
              <div
                className={`tree-row directory-row ${selectedFolderId === directory.id ? 'selected' : ''} ${dropTarget === directory.path ? 'drop-target' : ''}`}
                onContextMenu={context}
              >
                <button
                  type="button"
                  {...(contextOnly ? {} : dragSource({ kind: 'directory', item: directory }))}
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
                <button
                  type="button"
                  className="directory-disclosure"
                  aria-label={`${expanded ? t.collapse : t.expand}: ${directoryName(directory.path)}`}
                  aria-expanded={expanded}
                  onClick={() => toggle(directory)}
                >
                  <ChevronDown size={12} />
                </button>
                {editable && !contextOnly && mode !== 'filter' && (
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
          const icon = <ResourceIcon kind={file.kind} />;
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
                    {icon}
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
                    {...dragSource({ kind: 'file', item: file })}
                    data-file-choice={file.id}
                    title={mode === 'manage' ? `${file.name} · ${t.doubleClickHint}` : file.name}
                    onClick={() => chooseFile?.(file, 'preview')}
                    onDoubleClick={() => chooseFile?.(file, 'retain')}
                  >
                    {icon}
                    <span>{file.name}</span>
                    {file.reviewed && (
                      <CircleCheck className="reviewed-marker" size={16} aria-label={t.reviewed}>
                        <title>{t.reviewed}</title>
                      </CircleCheck>
                    )}
                  </button>
                )}
                {mode !== 'filter' && (
                  <ActionMenu
                    label={`${t.options}: ${file.name}`}
                    actions={fileActions(file)}
                    options={
                      mode === 'manage'
                        ? {
                            variant: 'file',
                            placement: 'right-start',
                            heading: t.openResource,
                            footnote: t.doubleClickHint,
                          }
                        : { variant: 'file' }
                    }
                  />
                )}
              </div>
            </li>
          );
        })}
    </ul>
  );
  return (
    <div
      className={`directory-tree ${dropTarget === '' ? 'drop-root' : ''}`}
      ref={scroller}
      {...dropZone('')}
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
      {editable && mode !== 'manage' && mode !== 'filter' && (
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

/** Below the second level only resource and class folders open by default, to keep the tree short. */
function collapsedByDefault(directory: Directory) {
  return (
    directory.path.split('/').length > 2 &&
    !/recursos|clases|resources|classes/i.test(directory.path.split('/').at(-1)!)
  );
}
