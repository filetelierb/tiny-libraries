import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, FileAudio, FileImage, FileText, FileVideo, Sparkles } from 'lucide-react';
import type { Catalog, Kind, Source } from '../../shared/domain';
import { sourceState } from '../../shared/directories';
import {
  matchConcept,
  normalizeConcept,
  summarizeConcept,
  type GlossaryEntry,
} from '../../shared/glossary';
import type {
  ComposerMenuCommands,
  ComposerSuggestion,
  MentionRecord,
} from '../workspace/TipTapComposer';

type MenuItem =
  | { kind: 'file'; id: string; label: string; description: string; icon: React.ReactNode; file: Source }
  | { kind: 'concept'; id: string; label: string; description: string; icon: React.ReactNode; entry: GlossaryEntry };

const iconForFile = (file: Source): React.ReactNode => {
  const byKind: Record<Kind, React.ReactNode> = {
    video: <FileVideo />,
    audio: <FileAudio />,
    pdf: <FileText />,
    image: <FileImage />,
    markdown: <FileText />,
    text: <FileText />,
    artifact: <Sparkles />,
  };
  return byKind[file.kind] ?? <FileText />;
};

const pathFor = (file: Source, _catalog: Catalog): string =>
  file.path || file.folder || '';

/**
 * The floating unified menu the composer opens on `@`. One scrollable list of files and
 * glossary concepts, each row an icon + label + muted description — the row layout the user
 * asked to port from t3code. The parent drives the open state by passing a non-null
 * `suggestion`; the menu commits the highlighted row through TipTap's `command`.
 */
export const MentionCommandMenu = forwardRef<
  ComposerMenuCommands,
  {
    suggestion: ComposerSuggestion;
    catalog: Catalog;
    anchor: HTMLElement | null;
    onPickFile: (file: Source, command: (attrs: MentionRecord) => void) => void;
    onPickConcept: (entry: GlossaryEntry, command: (attrs: MentionRecord) => void) => void;
  }
>(function MentionCommandMenu({ suggestion, catalog, anchor, onPickFile, onPickConcept }, ref) {
  const { query, command } = suggestion;
  const items = useMemo<MenuItem[]>(() => {
    const normalizedConcepts = catalog.concepts
      .filter((c) => !c.archived && !c.mergedInto)
      .map(normalizeConcept);
    const summaries = normalizedConcepts.map(summarizeConcept);
    const files = catalog.files
      .filter((f) => sourceState(f, catalog.directories) === 'files')
      .filter((f) => {
        const q = query.trim().toLocaleLowerCase('es');
        if (!q) return true;
        return (
          f.name.toLocaleLowerCase('es').includes(q) ||
          (pathFor(f, catalog) || '').toLocaleLowerCase('es').includes(q)
        );
      })
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 30)
      .map<MenuItem>((file) => ({
        kind: 'file',
        id: `file:${file.id}`,
        label: file.name,
        description: pathFor(file, catalog),
        icon: iconForFile(file),
        file,
      }));
    const concepts = normalizedConcepts
      .filter((entry) => matchConcept(summarizeConcept(entry), query, summaries))
      .sort((a, b) => a.term.localeCompare(b.term))
      .slice(0, 30)
      .map<MenuItem>((entry) => ({
        kind: 'concept',
        id: `concept:${entry.id}`,
        label: entry.term,
        description: entry.definition.replace(/\s+/g, ' ').slice(0, 140),
        icon: <BookOpen />,
        entry,
      }));
    return [...files, ...concepts];
  }, [catalog, query]);

  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
  }, [query, items.length]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const commit = (): boolean => {
    const item = items[index];
    if (!item) return false;
    if (item.kind === 'file') onPickFile(item.file, command);
    else onPickConcept(item.entry, command);
    return true;
  };

  useImperativeHandle(ref, () => ({
    highlightPrev: () => setIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0)),
    highlightNext: () => setIndex((i) => (items.length ? (i + 1) % items.length : 0)),
    commit,
  }), [items, index]);

  // Position the overlay above the editor surface, matching its width. Tracked across scroll
  // and resize so dragging the window or scrolling the pane keeps it attached.
  const [box, setBox] = useState<{ left: number; bottom: number; width: number; maxHeight: number } | null>(null);
  useEffect(() => {
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const maxHeight = Math.max(160, rect.top - 24);
      setBox({
        left: rect.left,
        bottom: window.innerHeight - rect.top + 8,
        width: rect.width,
        maxHeight,
      });
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchor]);

  if (!box) return null;

  return createPortal(
    <div
      className="mention-command-menu"
      style={{
        position: 'fixed',
        left: box.left,
        bottom: box.bottom,
        width: box.width,
        maxHeight: box.maxHeight,
      }}
      role="listbox"
      aria-label="Menciones"
    >
      <div ref={listRef} className="mention-command-list" style={{ maxHeight: box.maxHeight - 36 }}>
        {items.length === 0 && (
          <p className="mention-command-empty">Sin coincidencias.</p>
        )}
        {items.map((item, i) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={i === index}
            data-menu-index={i}
            className={`mention-command-item${i === index ? ' is-active' : ''}`}
            onMouseMove={() => setIndex(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              setIndex(i);
              if (item.kind === 'file') onPickFile(item.file, command);
              else onPickConcept(item.entry, command);
            }}
          >
            <span className="mention-command-icon">{item.icon}</span>
            <span className="mention-command-label">{item.label}</span>
            <span className="mention-command-description">{item.description}</span>
          </button>
        ))}
      </div>
      <div className="mention-command-footer">
        <span>↑↓ navegar</span>
        <span>↵ seleccionar</span>
        <span>Esc cerrar</span>
      </div>
    </div>,
    document.body,
  );
});
