import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowUp,
  History,
  LoaderCircle,
  Plus,
  Pencil,
  X,
  Paperclip,
} from 'lucide-react';
import type { Conversation } from '../../shared/conversations';
import type { Catalog, Source, Segment, PublicLearning } from '../../shared/domain';
import { fold } from '../../shared/domain';
import { sourceState } from '../../shared/directories';
import { api } from '../api';
import { Button, IconButton, Modal } from '../design/components';
import type { T } from '../i18n';
import { DirectoryTree, type TreeActions } from './DirectoryTree';

function stored(key: string) {
  try {
    return localStorage.getItem(key) || '';
  } catch {
    return '';
  }
}
function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export function ConversationPanel({
  sessionId,
  source,
  catalog,
  t,
  onError,
  changed,
  cite,
  treeActions,
  annotate,
}: {
  sessionId: string;
  source: Source | null;
  catalog: Catalog;
  t: T;
  treeActions: TreeActions;
  annotate: (content: string, sourceIds: string[]) => void;
  onError: (message: string) => void;
  changed: () => Promise<unknown>;
  cite: (sourceId: string, segment: Segment) => void;
}) {
  const selectionKey = `tl:conversation:${sessionId}`;
  const [threads, setThreads] = useState<Conversation[]>([]),
    [selected, select] = useState(() => stored(selectionKey)),
    [history, setHistory] = useState(false),
    [query, setQuery] = useState(''),
    [loading, setLoading] = useState(true),
    [creating, setCreating] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void api<Conversation[]>(`/sessions/${sessionId}/conversations`)
      .then((value) => {
        if (cancelled) return;
        setThreads(value);
        select((current) =>
          value.some((item) => item.id === current) ? current : value[0]?.id || '',
        );
      })
      .catch((error) => onError(error.message))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, catalog.conversations]);
  useEffect(() => {
    store(selectionKey, selected);
  }, [selectionKey, selected]);
  const current = threads.find((item) => item.id === selected);
  const receive = async (value: Conversation) => {
    if (alive.current) setThreads((old) => [...old.filter((item) => item.id !== value.id), value]);
    await changed();
  };
  const create = async () => {
    setCreating(true);
    try {
      const created = await api<Conversation>(`/sessions/${sessionId}/conversations`, 'POST', {
        name: `${t.conversation} ${threads.length + 1}`,
        sourceIds: source ? [source.id] : [],
      });
      await receive(created);
      if (alive.current) {
        select(created.id);
        setHistory(false);
      }
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
    } finally {
      if (alive.current) setCreating(false);
    }
  };
  return (
    <div className="conversation-panel">
      <div className="conversation-heading">
        <strong title={current?.name}>
          {history ? t.conversationHistory : current?.name || t.assistant}
        </strong>
        <IconButton
          label={history ? t.backToConversation : t.conversationHistory}
          onClick={() => setHistory(!history)}
        >
          {history ? <ArrowLeft /> : <History />}
        </IconButton>
        <IconButton
          label={t.newConversation}
          disabled={creating || loading}
          onClick={() => void create()}
        >
          <Plus />
        </IconButton>
      </div>
      {history ? (
        <div className="conversation-history">
          <input
            type="search"
            aria-label={t.searchConversations}
            placeholder={t.searchConversations}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {[...threads]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .filter((item) =>
              fold(`${item.name} ${item.messages.map((m) => m.content).join(' ')}`).includes(
                fold(query),
              ),
            )
            .map((item) => (
              <button
                className={`conversation-row ${item.id === selected ? 'active' : ''}`}
                key={item.id}
                onClick={() => {
                  select(item.id);
                  setHistory(false);
                }}
              >
                <strong>{item.name}</strong>
                <span>{item.messages.at(-1)?.content.slice(0, 120) || t.noMessages}</span>
                <small>
                  {item.messages.length} {t.messages} ·{' '}
                  {new Date(item.updatedAt).toLocaleDateString()}
                </small>
              </button>
            ))}
          {!threads.length && <p className="small-empty">{t.noMessages}</p>}
        </div>
      ) : loading ? (
        <p role="status">{t.loading}</p>
      ) : current ? (
        <ConversationThread
          key={current.id}
          conversation={current}
          catalog={catalog}
          t={t}
          receive={receive}
          onError={onError}
          cite={cite}
          treeActions={treeActions}
          annotate={annotate}
        />
      ) : (
        <div className="small-empty">
          <p>{t.startConversationBody}</p>
          <Button variant="primary" disabled={creating} onClick={() => void create()}>
            {t.startConversation}
          </Button>
        </div>
      )}
    </div>
  );
}

function ConversationThread({
  conversation,
  catalog,
  t,
  receive,
  onError,
  cite,
  treeActions,
  annotate,
}: {
  conversation: Conversation;
  catalog: Catalog;
  t: T;
  treeActions: TreeActions;
  annotate: (content: string, sourceIds: string[]) => void;
  receive: (conversation: Conversation) => Promise<void>;
  onError: (message: string) => void;
  cite: (sourceId: string, segment: Segment) => void;
}) {
  const draftKey = `tl:conversation-draft:${conversation.id}`;
  const [draft, setDraft] = useState(() => stored(draftKey)),
    [pending, setPending] = useState(false),
    [running, setRunning] = useState(false),
    [prompt, setPrompt] = useState(''),
    [picker, setPicker] = useState(false),
    [rename, setRename] = useState(false),
    [title, setTitle] = useState(conversation.name),
    [query, setQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0),
    [mentionDismissed, setMentionDismissed] = useState(false);
  const mentionQuery = draft.match(/(?:^|\s)@([^\n@]*)$/)?.[1];
  const mentions =
    !mentionDismissed && mentionQuery !== undefined
      ? catalog.files
          .filter(
            (file) =>
              sourceState(file, catalog.directories) === 'files' &&
              fold(file.name).includes(fold(mentionQuery.trim())),
          )
          .slice(0, 8)
      : [];
  const draftRef = useRef(draft),
    alive = useRef(true);
  draftRef.current = draft;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const value = await api<Conversation & { pending: boolean }>(
          `/conversations/${conversation.id}`,
        );
        if (cancelled) return;
        setRunning(value.pending);
        if (value.updatedAt !== conversation.updatedAt) await receive(value);
      } catch {
        /* A transient polling failure must not discard this conversation. */
      }
    };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [conversation.id, conversation.updatedAt]);
  const changeDraft = (value: string) => {
    setDraft(value);
    draftRef.current = value;
    store(draftKey, value);
  };
  const patch = async (value: Partial<Conversation>) => {
    try {
      await receive(await api<Conversation>(`/conversations/${conversation.id}`, 'PATCH', value));
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
      return false;
    }
  };
  const resolve = async (sourceId: string, segmentId: string) => {
    try {
      const learning = await api<PublicLearning | null>(`/learning/${sourceId}`);
      const segment = learning?.segments.find((item) => item.id === segmentId);
      if (segment) cite(sourceId, segment);
      else onError(t.evidenceUnavailable);
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
    }
  };
  const mention = async (file: Source) => {
    if (!conversation.sourceIds.includes(file.id)) {
      if (conversation.sourceIds.length >= 20) {
        onError(t.referenceLimit);
        return;
      }
      if (!(await patch({ sourceIds: [...conversation.sourceIds, file.id] }))) return;
    }
    changeDraft(`${draftRef.current.slice(0, draftRef.current.lastIndexOf('@'))}@${file.name} `);
    setMentionDismissed(true);
  };
  const citationMarkdown = (content: string, ids: string[]) =>
    content.replace(/\[([\w:.-]+)\](?!\()/g, (text, id: string) => {
      const separator = id.indexOf(':');
      const sourceId = separator > 0 ? id.slice(0, separator) : ids.length === 1 ? ids[0] : null;
      const segmentId = separator > 0 ? id.slice(separator + 1) : id;
      return sourceId && ids.includes(sourceId)
        ? `[${segmentId}](#evidence/${sourceId}/${encodeURIComponent(segmentId)})`
        : text;
    });
  async function send() {
    const text = draftRef.current.trim();
    if (!text || pending || running) return;
    const retryKey = `tl:conversation-request:${conversation.id}`;
    let previous: { prompt?: string; requestId?: string } = {};
    try {
      previous = JSON.parse(stored(retryKey) || '{}');
    } catch {}
    const requestId =
      previous.prompt === text && previous.requestId ? previous.requestId : crypto.randomUUID();
    store(retryKey, JSON.stringify({ prompt: text, requestId }));
    setPending(true);
    setPrompt(text);
    changeDraft('');
    try {
      const next = await api<Conversation>(`/conversations/${conversation.id}/turns`, 'POST', {
        prompt: text,
        requestId,
      });
      await receive(next);
      store(retryKey, '');
    } catch (error) {
      // Do not overwrite a new draft typed while this reply was running.
      if (!stored(draftKey)) {
        store(draftKey, text);
        if (alive.current) setDraft(text);
      }
      onError(error instanceof Error ? error.message : t.error);
    } finally {
      if (alive.current) {
        setPending(false);
        setPrompt('');
      }
    }
  }
  return (
    <div className="assistant">
      <div className="conversation-actions">
        <Button variant="ghost" onClick={() => setPicker(true)}>
          <Paperclip size={14} />
          {t.references} ({conversation.sourceIds.length})
        </Button>
        <IconButton
          label={t.renameConversation}
          onClick={() => {
            setTitle(conversation.name);
            setRename(true);
          }}
        >
          <Pencil />
        </IconButton>
      </div>
      <div className="context-tray" aria-label={t.references}>
        {conversation.sourceIds.map((id) => {
          const file = catalog.files.find((item) => item.id === id);
          return (
            <span key={id}>
              <span title={file?.name}>{file?.name || t.missingReference}</span>
              <IconButton
                label={`${t.removeReference}: ${file?.name || id}`}
                disabled={pending}
                onClick={() =>
                  void patch({ sourceIds: conversation.sourceIds.filter((value) => value !== id) })
                }
              >
                <X />
              </IconButton>
            </span>
          );
        })}
      </div>
      <p className="muted">
        {conversation.sourceIds.length ? t.referencesNotice : t.generalTutorNotice}
      </p>
      <div className="conversation-messages" aria-live="polite" aria-relevant="additions text">
        {conversation.messages.map((message, index) => (
          <div
            className={`chat-message ${message.role}`}
            key={`${message.requestId || 'history'}-${index}`}
          >
            <Markdown
              remarkPlugins={[remarkGfm]}
              components={{
                a: ({ href, children }) => {
                  const match = href?.match(/^#evidence\/([\w-]+)\/(.+)$/);
                  return match ? (
                    <button
                      className="evidence-link"
                      onClick={() => void resolve(match[1], decodeURIComponent(match[2]))}
                    >
                      {children}
                    </button>
                  ) : (
                    <a href={href} target="_blank" rel="noreferrer">
                      {children}
                    </a>
                  );
                },
              }}
            >
              {citationMarkdown(message.content, message.sourceIds || conversation.sourceIds)}
            </Markdown>
            {message.role === 'assistant' && (
              <Button
                variant="ghost"
                onClick={() =>
                  annotate(message.content, message.sourceIds || conversation.sourceIds)
                }
              >
                <Pencil size={14} />
                {t.saveAsAnnotation}
              </Button>
            )}
            {message.tools?.length ? (
              <small>
                {t.toolsUsed}: {[...new Set(message.tools)].join(', ')}
              </small>
            ) : null}
          </div>
        ))}
        {pending && (
          <>
            <div className="chat-message user">
              <p>{prompt}</p>
            </div>
            <p role="status" className="muted">
              <LoaderCircle className="spin" size={14} /> {t.thinking}
            </p>
          </>
        )}
        {!pending && running && (
          <p role="status" className="muted">
            <LoaderCircle className="spin" size={14} /> {t.thinking}
          </p>
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label={t.assistant}
          placeholder={t.chatPlaceholder}
          maxLength={8000}
          value={draft}
          aria-autocomplete="list"
          aria-controls={mentions.length ? `mentions-${conversation.id}` : undefined}
          aria-expanded={mentions.length > 0}
          onChange={(event) => {
            changeDraft(event.target.value);
            setMentionIndex(0);
            setMentionDismissed(false);
          }}
          onKeyDown={(event) => {
            if (!mentions.length) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              setMentionIndex(
                (index) =>
                  (index + (event.key === 'ArrowDown' ? 1 : mentions.length - 1)) % mentions.length,
              );
            } else if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setMentionDismissed(true);
            } else if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void mention(mentions[Math.min(mentionIndex, mentions.length - 1)]);
            }
          }}
        />
        {mentions.length > 0 && (
          <div
            className="mention-list"
            role="listbox"
            id={`mentions-${conversation.id}`}
            aria-label={t.mentionSource}
          >
            {mentions.map((file, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === mentionIndex}
                key={file.id}
                onClick={() => void mention(file)}
              >
                {file.name}
              </button>
            ))}
          </div>
        )}
        <Button variant="primary" type="submit" disabled={pending || running || !draft.trim()}>
          <ArrowUp size={15} />
          {t.send}
        </Button>
      </form>
      {rename && (
        <Modal title={t.renameConversation} close={() => setRename(false)} closeLabel={t.close}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void patch({ name: title }).then((ok) => {
                if (ok) setRename(false);
              });
            }}
          >
            <label>
              {t.name}
              <input
                autoFocus
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="modal-actions">
              <Button variant="primary" type="submit" disabled={!title.trim()}>
                {t.save}
              </Button>
              <Button onClick={() => setRename(false)}>{t.cancel}</Button>
            </div>
          </form>
        </Modal>
      )}
      {picker && (
        <Modal title={t.references} close={() => setPicker(false)} closeLabel={t.close}>
          <p className="muted">{t.referencesNotice}</p>
          <input
            type="search"
            aria-label={t.search}
            placeholder={t.search}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <DirectoryTree
            actions={treeActions}
            mode="file"
            directories={catalog.directories}
            files={catalog.files.filter(
              (file) =>
                !conversation.sourceIds.includes(file.id) &&
                sourceState(file, catalog.directories) !== 'trash',
            )}
            t={t}
            view="files"
            query={query}
            storageKey="tl:tree:references"
            chooseFile={(file) => {
              if (conversation.sourceIds.length >= 20) {
                onError(t.referenceLimit);
                return;
              }
              void patch({ sourceIds: [...conversation.sourceIds, file.id] }).then(() =>
                setPicker(false),
              );
            }}
          />
        </Modal>
      )}
    </div>
  );
}
