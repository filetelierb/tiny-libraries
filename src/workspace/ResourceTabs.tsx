import { useEffect, useRef } from 'react';
import { Columns2, FileImage, FileText, Film, Headphones, Pin, X } from 'lucide-react';
import type { Source } from '../../shared/domain';
import { IconButton } from '../design/components';
import type { T } from '../i18n';
import type { ResourceWorkspace } from './tabs';

export function ResourceTabs({
  workspace,
  files,
  t,
  select,
  keep,
  close,
}: {
  workspace: ResourceWorkspace;
  files: Source[];
  t: T;
  select: (id: string) => void;
  keep: (id: string) => void;
  close: (id: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  const visible = workspace.resourceTabs.filter((tab) =>
    tab.sources.every((id) => files.some((file) => file.id === id)),
  );
  useEffect(() => {
    const button = strip.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
    button?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    if (pendingFocus.current) {
      button?.focus();
      pendingFocus.current = false;
    }
  }, [workspace.activeTabId, workspace.resourceTabs.length]);
  return (
    <div role="tablist" aria-label={t.files} className="tab-list" ref={strip}>
      {visible.map((tab, index) => {
        const sources = tab.sources.map((id) => files.find((file) => file.id === id)!);
        const label = sources.map((file) => file.name).join(' + ');
        const kind = sources[0].kind;
        const Icon =
          sources.length === 2
            ? Columns2
            : kind === 'video'
              ? Film
              : kind === 'audio'
                ? Headphones
                : kind === 'image'
                  ? FileImage
                  : FileText;
        const selected = tab.id === workspace.activeTabId;
        return (
          <div
            className={`resource-tab ${sources.length === 2 ? 'split-tab' : ''} ${selected ? 'active' : ''} ${tab.preview ? 'preview' : ''}`}
            key={tab.id}
          >
            <button
              id={`resource-tab-${tab.id}`}
              role="tab"
              aria-selected={selected}
              aria-controls="resource-view"
              tabIndex={selected ? 0 : -1}
              title={`${label}${tab.preview ? ` · ${t.previewHint}` : ''}`}
              onClick={() => select(tab.id)}
              onDoubleClick={() => keep(tab.id)}
              onKeyDown={(event) => {
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
              <Icon size={14} />
              <span>{label}</span>
              {tab.preview && <span className="sr-only"> · {t.preview}</span>}
            </button>
            {tab.preview && (
              <IconButton label={`${t.keepOpen}: ${label}`} onClick={() => keep(tab.id)}>
                <Pin size={12} />
              </IconButton>
            )}
            <IconButton
              label={`${t.close} ${label}`}
              onClick={() => {
                pendingFocus.current = selected;
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
  );
}
