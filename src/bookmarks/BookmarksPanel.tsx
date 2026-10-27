import { useState, type ReactNode } from 'react';
import { Bookmark, Plus, Pencil, Trash2, RotateCcw, Play } from 'lucide-react';
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
  sourceName,
  composer,
}: {
  items: AnnotationSummary[];
  filter: BookmarkFilter;
  changeFilter: (value: BookmarkFilter) => void;
  t: T;
  create: () => void;
  edit: (value: AnnotationSummary) => void;
  navigate: (value: AnnotationSummary) => void;
  remove: (value: AnnotationSummary) => Promise<void>;
  sourceName?: string;
  composer?: ReactNode;
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
      <div className="annotation-panel-head">
        <div className="panel-title-row">
          <div>
            <p>{t.bookmarks}</p>
            <small>{sourceName || t.selectMaterial}</small>
          </div>
          <IconButton
            label={t.showDeletedBookmarks}
            aria-pressed={deleted}
            onClick={() => setDeleted(!deleted)}
          >
            <Trash2 />
          </IconButton>
          <IconButton label={t.newBookmark} onClick={create}>
            <Plus />
          </IconButton>
        </div>
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
      </div>
      <div className="annotation-list">
        {composer}
        {!visible.length && (
          <div className="panel-empty">
            <Bookmark />
            <strong>{deleted ? t.noDeletedBookmarks : t.noBookmarksTitle}</strong>
            <p>
              {filter === 'manual'
                ? t.noPersonalBookmarks
                : filter === 'tutor'
                  ? t.noSuggestedBookmarks
                  : t.noBookmarks}
            </p>
          </div>
        )}
        {visible.map((item) => (
          <article className="bookmark-card" key={item.id}>
            <div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => navigate(item)}
                aria-label={`${t.openBookmark}: ${item.title}`}
              >
                <Play />
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
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => setTarget(null)}
                  >
                    {t.cancel}
                  </Button>
                  <Button
                    size="sm"
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
                    <Trash2 />
                    {t.delete}
                  </Button>
                </div>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
