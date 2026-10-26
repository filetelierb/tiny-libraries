import { useState } from 'react';
import { Plus, Pencil, Trash2, RotateCcw, Play } from 'lucide-react';
import type { AnnotationSummary } from '../../shared/annotations';
import { Button, IconButton } from '../design/components';
import type { T } from '../i18n';
export type BookmarkFilter = 'all' | 'manual' | 'tutor';
export function BookmarksPanel({
  items,
  filter,
  changeFilter,
  t,
  create,
  edit,
  navigate,
  remove,
}: {
  items: AnnotationSummary[];
  filter: BookmarkFilter;
  changeFilter: (value: BookmarkFilter) => void;
  t: T;
  create: () => void;
  edit: (value: AnnotationSummary) => void;
  navigate: (value: AnnotationSummary) => void;
  remove: (value: AnnotationSummary) => Promise<void>;
}) {
  const [deleted, setDeleted] = useState(false),
    [target, setTarget] = useState<string | null>(null),
    [pending, setPending] = useState(false);
  const visible = items
    .filter((item) => item.deleted === deleted && (filter === 'all' || item.origin === filter))
    .sort(
      (a, b) =>
        (a.location.seconds ?? a.location.page ?? 0) - (b.location.seconds ?? b.location.page ?? 0),
    );
  return (
    <div className="bookmarks-panel">
      <header>
        <strong>{t.bookmarks}</strong>
        <IconButton label={t.newBookmark} onClick={create}>
          <Plus />
        </IconButton>
      </header>
      <label className="bookmark-filter">
        {t.show}
        <select
          aria-label={t.filterBookmarks}
          value={filter}
          onChange={(event) => changeFilter(event.target.value as BookmarkFilter)}
        >
          <option value="all">{t.allBookmarks}</option>
          <option value="manual">{t.personalBookmarks}</option>
          <option value="tutor">{t.suggestedBookmarks}</option>
        </select>
      </label>
      <label className="annotation-trash">
        <input
          type="checkbox"
          checked={deleted}
          onChange={(event) => setDeleted(event.target.checked)}
        />
        {t.showDeletedBookmarks}
      </label>
      {!visible.length && (
        <p className="small-empty">
          {filter === 'manual'
            ? t.noPersonalBookmarks
            : filter === 'tutor'
              ? t.noSuggestedBookmarks
              : t.noBookmarks}
        </p>
      )}
      {visible.map((item) => (
        <article className="bookmark-card" key={item.id}>
          <div>
            <Button onClick={() => navigate(item)} aria-label={`${t.openBookmark}: ${item.title}`}>
              <Play size={14} />
              {item.location.page
                ? `${t.page} ${item.location.page}`
                : item.location.seconds != null
                  ? `${Math.floor(item.location.seconds / 60)}:${String(Math.floor(item.location.seconds % 60)).padStart(2, '0')}`
                  : t.open}
            </Button>
            <small>{item.origin === 'tutor' ? t.suggestedOrigin : t.personalOrigin}</small>
            {!deleted && (
              <IconButton label={`${t.editBookmark}: ${item.title}`} onClick={() => edit(item)}>
                <Pencil />
              </IconButton>
            )}
            <IconButton
              label={deleted ? t.restoreBookmark : `${t.deleteBookmark}: ${item.title}`}
              disabled={pending}
              onClick={() => {
                if (deleted) void remove(item);
                else setTarget(item.id);
              }}
            >
              {deleted ? <RotateCcw /> : <Trash2 />}
            </IconButton>
          </div>
          <p>{item.title || item.text}</p>
          {target === item.id && (
            <div className="bookmark-delete-confirm">
              <p>{t.confirmBookmarkTrash}</p>
              <Button disabled={pending} onClick={() => setTarget(null)}>
                {t.cancel}
              </Button>
              <Button
                variant="danger"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  void remove(item).finally(() => {
                    setPending(false);
                    setTarget(null);
                  });
                }}
              >
                {t.deleteBookmark}
              </Button>
            </div>
          )}
        </article>
      ))}
    </div>
  );
}
