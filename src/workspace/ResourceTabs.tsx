import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Columns2, MoreHorizontal, Pencil, Pin, X } from 'lucide-react';
import type { Source } from '../../shared/domain';
import { IconButton } from '../design/components';
import { ResourceIcon } from '../design/ResourceIcon';
import { ActionMenuSurface, type MenuAction, type MenuAnchor } from '../design/ActionMenu';
import type { T } from '../i18n';
import type { ResourceWorkspace } from './tabs';

const dragType = 'application/x-tailored-library-tab';
export function ResourceTabs({
  workspace,
  files,
  t,
  select,
  keep,
  close,
  reorder,
  rename,
  splitWith,
}: {
  workspace: ResourceWorkspace;
  files: Source[];
  t: T;
  select: (id: string) => void;
  keep: (id: string) => void;
  close: (id: string) => void;
  reorder: (sourceId: string, targetId: string) => void;
  rename: (file: Source) => void;
  splitWith: (sourceId: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null),
    pendingFocus = useRef<string | true | null>(null),
    scrollMoved = useRef<string | null>(null),
    helperId = useId(),
    menuId = useId();
  const [context, setContext] = useState<
      ({ tabId: string; focusLast: boolean } & MenuAnchor) | null
    >(null),
    [dragging, setDragging] = useState<string | null>(null),
    [dropTarget, setDropTarget] = useState<string | null>(null),
    [notice, setNotice] = useState('');
  const visible = workspace.resourceTabs.filter((tab) =>
      tab.sources.every((id) => files.some((file) => file.id === id)),
    ),
    order = JSON.stringify(visible.map((tab) => tab.id)),
    active = visible.find((tab) => tab.id === workspace.activeTabId),
    currentSource =
      active?.focusedSource && active.sources.includes(active.focusedSource)
        ? active.focusedSource
        : active?.sources[0];
  const buttonFor = (id: string) =>
    [...(strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') || [])].find(
      (button) => button.id === `resource-tab-${id}`,
    );
  useEffect(() => {
    if (workspace.activeTabId)
      buttonFor(workspace.activeTabId)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [workspace.activeTabId, visible.length]);
  useEffect(() => {
    const id = pendingFocus.current === true ? workspace.activeTabId : pendingFocus.current;
    if (id) {
      const button = buttonFor(id);
      button?.focus({ preventScroll: true });
      button?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    } else if (scrollMoved.current)
      buttonFor(scrollMoved.current)?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    pendingFocus.current = null;
    scrollMoved.current = null;
  }, [order, workspace.activeTabId]);
  useEffect(() => {
    if (context && !visible.some((tab) => tab.id === context.tabId)) setContext(null);
  }, [order, context?.tabId]);
  function closeMenu(restore = true) {
    setContext(null);
    if (restore && context?.element.isConnected) context.element.focus({ preventScroll: true });
  }
  function move(sourceId: string, targetId: string, focus = false) {
    const from = visible.findIndex((tab) => tab.id === sourceId),
      to = visible.findIndex((tab) => tab.id === targetId);
    if (from < 0 || to < 0 || from === to) return;
    if (focus) pendingFocus.current = sourceId;
    else if (sourceId === workspace.activeTabId) scrollMoved.current = sourceId;
    reorder(sourceId, targetId);
    const label = visible[from].sources
      .map((id) => files.find((file) => file.id === id)?.name)
      .join(' + ');
    setNotice(`${t.tabMoved}: ${label} · ${t.tabPosition} ${to + 1} ${t.of} ${visible.length}`);
  }
  const contextTab = visible.find((tab) => tab.id === context?.tabId),
    contextIndex = contextTab ? visible.indexOf(contextTab) : -1,
    contextFile =
      contextTab?.sources.length === 1
        ? files.find((file) => file.id === contextTab.sources[0])
        : null,
    contextLabel =
      contextTab?.sources.map((id) => files.find((file) => file.id === id)?.name).join(' + ') || '';
  const actions: MenuAction[] = contextTab
    ? [
        ...(contextTab.preview
          ? [{ label: t.keepOpen, icon: <Pin size={16} />, run: () => keep(contextTab.id) }]
          : []),
        ...(contextFile
          ? [
              { label: t.rename, icon: <Pencil size={16} />, run: () => rename(contextFile) },
              {
                label: t.splitWithCurrent,
                icon: <Columns2 size={16} />,
                disabled: !currentSource || currentSource === contextFile.id,
                run: () => {
                  splitWith(contextFile.id);
                  requestAnimationFrame(() =>
                    strip.current
                      ?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
                      ?.focus({ preventScroll: true }),
                  );
                },
              },
            ]
          : []),
        {
          label: t.moveTabLeft,
          icon: <ArrowLeft size={16} />,
          separator: !!contextFile,
          disabled: contextIndex === 0,
          run: () => {
            if (contextIndex > 0) move(contextTab.id, visible[contextIndex - 1].id, true);
          },
        },
        {
          label: t.moveTabRight,
          icon: <ArrowRight size={16} />,
          disabled: contextIndex === visible.length - 1,
          run: () => {
            if (contextIndex < visible.length - 1)
              move(contextTab.id, visible[contextIndex + 1].id, true);
          },
        },
        {
          label: contextFile ? t.closeTab : t.noSplit,
          icon: <X size={16} />,
          separator: true,
          run: () => {
            pendingFocus.current = true;
            close(contextTab.id);
          },
        },
      ]
    : [];
  return (
    <>
      <span className="sr-only" id={helperId}>
        {t.resourceTabHelp}
      </span>
      <span className="sr-only" role="status">
        {notice}
      </span>
      <div role="tablist" aria-label={t.files} className="tab-list" ref={strip}>
        {visible.map((tab, index) => {
          const sources = tab.sources.map((id) => files.find((file) => file.id === id)!);
          const label = sources.map((file) => file.name).join(' + '),
            kind = sources[0].kind;
          const icon = sources.length === 2 ? <Columns2 size={16} /> : <ResourceIcon kind={kind} />;
          const selected = tab.id === workspace.activeTabId,
            expanded = context?.tabId === tab.id;
          return (
            <div
              key={tab.id}
              role="presentation"
              draggable
              className={`resource-tab ${sources.length === 2 ? 'split-tab' : ''} ${selected ? 'active' : ''} ${tab.preview ? 'preview' : ''} ${dragging === tab.id ? 'dragging' : ''} ${dropTarget === tab.id && dragging !== tab.id ? 'drop-target' : ''}`}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                const element = buttonFor(tab.id);
                if (element)
                  setContext({
                    tabId: tab.id,
                    element,
                    point: { x: event.clientX, y: event.clientY },
                    focusLast: false,
                  });
              }}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(dragType, tab.id);
                closeMenu(false);
                setDragging(tab.id);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(dragType)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropTarget(tab.id);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setDropTarget(null);
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.types.includes(dragType)) return;
                event.preventDefault();
                event.stopPropagation();
                move(event.dataTransfer.getData(dragType), tab.id);
                setDropTarget(null);
                setDragging(null);
              }}
              onDragEnd={() => {
                setDropTarget(null);
                setDragging(null);
              }}
            >
              <button
                id={`resource-tab-${tab.id}`}
                role="tab"
                aria-selected={selected}
                aria-controls="resource-view"
                aria-describedby={helperId}
                aria-haspopup="menu"
                aria-expanded={expanded}
                aria-keyshortcuts="Alt+Shift+ArrowLeft Alt+Shift+ArrowRight Shift+F10"
                tabIndex={selected ? 0 : -1}
                title={`${label}${tab.preview ? ` · ${t.previewHint}` : ''}`}
                onClick={() => select(tab.id)}
                onDoubleClick={() => keep(tab.id)}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                    event.preventDefault();
                    event.stopPropagation();
                    setContext({ tabId: tab.id, element: event.currentTarget, focusLast: false });
                    return;
                  }
                  if (
                    event.altKey &&
                    event.shiftKey &&
                    ['ArrowLeft', 'ArrowRight'].includes(event.key)
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    const next = index + (event.key === 'ArrowLeft' ? -1 : 1);
                    if (visible[next]) move(tab.id, visible[next].id, true);
                    return;
                  }
                  let next = index;
                  if (event.key === 'ArrowRight') next = (index + 1) % visible.length;
                  else if (event.key === 'ArrowLeft')
                    next = (index + visible.length - 1) % visible.length;
                  else if (event.key === 'Home') next = 0;
                  else if (event.key === 'End') next = visible.length - 1;
                  else if (event.key === 'Delete') {
                    event.preventDefault();
                    pendingFocus.current = true;
                    close(tab.id);
                    return;
                  } else return;
                  event.preventDefault();
                  pendingFocus.current = true;
                  select(visible[next].id);
                }}
              >
                {icon}
                <span>{label}</span>
                {tab.preview && <span className="sr-only"> · {t.preview}</span>}
              </button>
              {tab.preview && (
                <IconButton label={`${t.keepOpen}: ${label}`} onClick={() => keep(tab.id)}>
                  <Pin size={12} />
                </IconButton>
              )}
              <IconButton
                label={`${t.tabActions}: ${label}`}
                aria-haspopup="menu"
                aria-expanded={expanded}
                aria-controls={expanded ? menuId : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  if (expanded) closeMenu();
                  else
                    setContext({ tabId: tab.id, element: event.currentTarget, focusLast: false });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    event.stopPropagation();
                    setContext({
                      tabId: tab.id,
                      element: event.currentTarget,
                      focusLast: event.key === 'ArrowUp',
                    });
                  }
                }}
              >
                <MoreHorizontal size={12} />
              </IconButton>
              <IconButton
                label={`${t.close} ${label}`}
                onClick={() => {
                  pendingFocus.current = true;
                  close(tab.id);
                }}
              >
                <X size={12} />
              </IconButton>
            </div>
          );
        })}
        {!visible.length && <span className="no-open-resources">{t.noOpenResources}</span>}
      </div>
      {context && contextTab && (
        <ActionMenuSurface
          id={menuId}
          label={`${t.tabActions}: ${contextLabel}`}
          actions={actions}
          anchor={context}
          close={closeMenu}
          focusLast={context.focusLast}
        />
      )}
    </>
  );
}
