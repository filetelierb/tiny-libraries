import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SavedTutorMessage } from '../tutor/SavedTutorMessage';
import { ArtifactProgress } from '../tutor/ArtifactProgress';
import { ActionLog } from '../tutor/ActionLog';
import {
  ChevronLeft,
  Search,
  ArrowUp,
  History,
  LoaderCircle,
  Plus,
  Pencil,
  X,
  Paperclip,
  Globe,
  Globe2,
  CornerDownRight,
  ChevronDown,
  FileStack,
  FileText,
  StickyNote,
  Pause,
  Play,
  Trash2,
} from 'lucide-react';
import { readWebDraft, type WebDraft } from '../../shared/tutor-web';
import {
  questionContextSchema,
  type Conversation,
  type QuestionContext,
  type ChatMessage,
} from '../../shared/conversations';
import type { Catalog, Source, Segment, PublicLearning } from '../../shared/domain';
import { fold, kindFor } from '../../shared/domain';
import { sourceState } from '../../shared/directories';
import { api, ApiResponseError, uploadFile } from '../api';
import {
  turnInputFingerprint,
  type ConversationDetail,
  type TurnAction,
  type TurnView,
} from '../../shared/tutor-turns';
import {
  acknowledgeTutorDraft,
  acknowledgeWebDraft,
  restoreWebDraft,
  acknowledgeTutorAttachments,
  restoreTutorDraft,
  readTutorDraft,
  readTutorSubmission,
  newerConversation,
  type TutorDraft,
  type TutorSubmission,
} from '../tutor/turnDrafts';
import { TurnProgress, TurnOutbox, tutorToolLabel } from '../tutor/TurnProgress';
import { Badge, Button, IconButton, Modal, LoadingRow } from '../design/components';
import type { T } from '../i18n';
import { DirectoryTree, RESOURCE_DRAG_TYPE, type TreeActions } from './DirectoryTree';
import {
  conceptMentionsSchema,
  conceptMention,
  recoverCitations,
  MAX_QUESTION_CONCEPTS,
  type ConceptMention,
  type TutorCitation,
} from '../../shared/tutor-context';
import { normalizeConcept, type GlossaryEntry } from '../../shared/glossary';
import { ConceptInspector } from '../tutor/ConceptInspector';
import { MentionCommandMenu } from '../tutor/MentionCommandMenu';
import { ReferencesPanel } from '../tutor/ReferencesPanel';
import {
  TipTapComposer,
  type ComposerMenuCommands,
  type ComposerSuggestion,
  type TipTapComposerHandle,
} from './TipTapComposer';
import { useCitationRecovery } from '../tutor/useCitationRecovery';
import { AttachmentPicker } from '../tutor/AttachmentPicker';
import { AttachmentInspector } from '../tutor/AttachmentInspector';
import { GenerationControl, GenerationLabel } from '../tutor/GenerationControl';
import {
  tutorPreferenceSchema,
  defaultTutorPreference,
  resolveTutorGeneration,
  type TutorPreference,
} from '../../shared/tutor-generation';
import type { AnnotationRequest } from '../annotations/AnnotationEditor';
import {
  questionAttachmentSchema,
  attachmentImages,
  questionImageBudget,
  MAX_QUESTION_ATTACHMENTS,
  type QuestionAttachment,
} from '../../shared/tutor-attachments';

// ChipComposer and its caret helpers moved to the TipTap-backed TipTapComposer. The parent
// now talks to it via the suggestion state + menu commands refs, not a plain-text caret.
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
  questionRequest,
  consumeQuestion,
  incomingAttachment,
  consumeAttachment,
  openConcept,
  prepareSource,
  createAttachment,
  openFile,
  openTest,
  openSourceIds,
}: {
  sessionId: string;
  source: Source | null;
  catalog: Catalog;
  t: T;
  treeActions: TreeActions;
  annotate: (content: string, sourceIds: string[], context?: QuestionContext) => void;
  questionRequest: { id: string; context: QuestionContext; prompt?: string } | null;
  consumeQuestion: () => void;
  incomingAttachment: { id: string; item: QuestionAttachment } | null;
  consumeAttachment: () => void;
  openConcept: (id: string) => void;
  prepareSource: (source: Source) => void;
  createAttachment: () => Promise<AnnotationRequest | null>;
  onError: (message: string) => void;
  changed: () => Promise<unknown>;
  cite: (sourceId: string, segment: Segment) => void;
  openFile: (id: string) => void;
  openTest: (sessionId: string, testId: string) => void;
  /** The session's open resource-tab source ids, deduped. Permanent references for every
   * conversation in this session derive from this list; closing a tab removes the reference,
   * opening one adds it. The chip popover only lets students pause or resume them. */
  openSourceIds: string[];
}) {
  const selectionKey = `tl:conversation:${sessionId}`;
  const [threads, setThreads] = useState<ConversationDetail[]>([]),
    [selected, select] = useState(() => stored(selectionKey)),
    [history, setHistory] = useState(false),
    [renameRequest, setRenameRequest] = useState(0),
    [query, setQuery] = useState(''),
    [loading, setLoading] = useState(true),
    // A new conversation lives only here until its first message is sent, which saves it.
    [draft, setDraft] = useState<ConversationDetail | null>(null),
    [deleting, setDeleting] = useState<string | null>(null),
    [removing, setRemoving] = useState(false);
  const alive = useRef(true),
    draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void api<ConversationDetail[]>(`/sessions/${sessionId}/conversations`)
      .then((value) => {
        if (cancelled) return;
        setThreads((old) =>
          value.map((item) =>
            newerConversation(
              old.find((c) => c.id === item.id),
              item,
            ),
          ),
        );
        select((current) =>
          value.some((item) => item.id === current) || current === draftRef.current?.id
            ? current
            : value[0]?.id || '',
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
  const current =
    threads.find((item) => item.id === selected) || (draft?.id === selected ? draft : undefined);
  const startDraft = () => {
    const now = new Date().toISOString();
    const value = {
      id: crypto.randomUUID(),
      sessionId,
      name: `${t.conversation} ${threads.length + 1}`,
      sourceIds: questionRequest ? [] : source ? [source.id] : [],
      messages: [],
      createdAt: now,
      updatedAt: now,
      pending: false,
    } as ConversationDetail;
    draftRef.current = value;
    setDraft(value);
    select(value.id);
    setHistory(false);
  };
  // With nothing selected, the panel opens a draft so the full composer is ready.
  useEffect(() => {
    if (!loading && !current) startDraft();
  }, [loading, current?.id]);
  const receive = async (value: ConversationDetail, refresh = true) => {
    // Changes to the draft, such as its name or references, stay local until it is saved.
    if (value.id === draftRef.current?.id) {
      draftRef.current = value;
      if (alive.current) setDraft(value);
      return;
    }
    if (alive.current)
      setThreads((old) => [
        ...old.filter((item) => item.id !== value.id),
        newerConversation(
          old.find((item) => item.id === value.id),
          value,
        ),
      ]);
    if (refresh)
      await changed().catch((error) => onError(error instanceof Error ? error.message : t.error));
  };
  /** Saves the draft with its id, so the first message is sent to a conversation that exists. */
  const persist = async () => {
    const value = draftRef.current;
    if (!value) return;
    const created = await api<ConversationDetail>(`/sessions/${sessionId}/conversations`, 'POST', {
      id: value.id,
      name: value.name,
      sourceIds: value.sourceIds,
      ...(value.pausedSourceIds ? { pausedSourceIds: value.pausedSourceIds } : {}),
    });
    draftRef.current = null;
    if (alive.current) setDraft(null);
    await receive(created);
  };
  /** Deletes a saved conversation; with it selected, the next one opens, or a new draft. */
  const remove = async (id: string) => {
    setRemoving(true);
    try {
      await api(`/conversations/${id}`, 'DELETE');
      const rest = threads.filter((item) => item.id !== id);
      if (alive.current) {
        setThreads(rest);
        setDeleting(null);
        if (selected === id)
          select([...rest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id || '');
      }
      await changed();
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
    } finally {
      if (alive.current) setRemoving(false);
    }
  };
  return (
    <div className="conversation-panel">
      {history ? (
        <div className="conversation-heading">
          <IconButton label={t.backToConversation} onClick={() => setHistory(false)}>
            <ChevronLeft />
          </IconButton>
          <strong>{t.conversationHistory}</strong>
        </div>
      ) : (
        <div className="conversation-float">
          <IconButton label={t.conversationHistory} onClick={() => setHistory(true)}>
            <History />
          </IconButton>
          <IconButton
            label={t.newConversation}
            disabled={loading || (!!draft && current?.id === draft.id)}
            onClick={startDraft}
          >
            <Plus />
          </IconButton>
        </div>
      )}
      {history ? (
        <div className="conversation-history">
          <div className="search-field">
            <Search />
            <input
              type="search"
              aria-label={t.searchConversations}
              placeholder={t.searchConversations}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {[...threads]
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .filter((item) =>
              fold(`${item.name} ${item.messages.map((m) => m.content).join(' ')}`).includes(
                fold(query),
              ),
            )
            .map((item) => (
              <div className="conversation-row-host" key={item.id}>
                <button
                  className={`conversation-row ${item.id === selected ? 'active' : ''}`}
                  onClick={() => {
                    select(item.id);
                    setHistory(false);
                  }}
                >
                  <span className="conversation-row-title">
                    <strong>{item.name}</strong>
                    <Badge>{item.messageCount ?? item.messages.length}</Badge>
                  </span>
                  <span>{item.messages.at(-1)?.content.slice(0, 120) || t.noMessages}</span>
                  <small>
                    {new Date(item.updatedAt).toLocaleString(undefined, {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </small>
                </button>
                <IconButton
                  label={`${t.renameConversation}: ${item.name}`}
                  onClick={() => {
                    select(item.id);
                    setHistory(false);
                    setRenameRequest((n) => n + 1);
                  }}
                >
                  <Pencil />
                </IconButton>
                <IconButton
                  label={`${t.deleteConversation}: ${item.name}`}
                  disabled={item.pending || removing}
                  onClick={() => setDeleting(item.id)}
                >
                  <Trash2 />
                </IconButton>
                {deleting === item.id && (
                  <div className="conversation-delete-confirm" role="group">
                    <p>{t.deleteConversationConfirm}</p>
                    <div>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={removing}
                        onClick={() => setDeleting(null)}
                      >
                        {t.cancel}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={removing}
                        onClick={() => void remove(item.id)}
                      >
                        <Trash2 />
                        {t.delete}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          {!threads.length && <p className="small-empty">{t.noMessages}</p>}
        </div>
      ) : loading ? (
        <LoadingRow>{t.loading}</LoadingRow>
      ) : current ? (
        <ConversationThread
          openFile={openFile}
          openTest={openTest}
          openSourceIds={openSourceIds}
          key={current.id}
          renameRequest={renameRequest}
          conversation={current}
          catalog={catalog}
          t={t}
          receive={receive}
          onError={onError}
          cite={cite}
          treeActions={treeActions}
          annotate={annotate}
          questionRequest={questionRequest}
          consumeQuestion={consumeQuestion}
          incomingAttachment={incomingAttachment}
          consumeAttachment={consumeAttachment}
          openConcept={openConcept}
          source={source}
          changed={changed}
          prepareSource={prepareSource}
          createAttachment={createAttachment}
          persisted={current.id !== draft?.id}
          persist={persist}
        />
      ) : null}
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
  questionRequest,
  consumeQuestion,
  incomingAttachment,
  consumeAttachment,
  openConcept,
  source,
  changed,
  prepareSource,
  createAttachment,
  renameRequest,
  persisted,
  persist,
  openFile,
  openTest,
  openSourceIds,
}: {
  conversation: ConversationDetail;
  catalog: Catalog;
  t: T;
  treeActions: TreeActions;
  annotate: (content: string, sourceIds: string[], context?: QuestionContext) => void;
  questionRequest: { id: string; context: QuestionContext; prompt?: string } | null;
  consumeQuestion: () => void;
  incomingAttachment: { id: string; item: QuestionAttachment } | null;
  consumeAttachment: () => void;
  openConcept: (id: string) => void;
  source: Source | null;
  changed: () => Promise<unknown>;
  prepareSource: (source: Source) => void;
  createAttachment: () => Promise<AnnotationRequest | null>;
  renameRequest: number;
  /** False for a draft, which exists only in the app until its first message is sent. */
  persisted: boolean;
  persist: () => Promise<void>;
  receive: (conversation: ConversationDetail, refresh?: boolean) => Promise<void>;
  onError: (message: string) => void;
  cite: (sourceId: string, segment: Segment) => void;
  openFile: (id: string) => void;
  openTest: (sessionId: string, testId: string) => void;
  openSourceIds: string[];
}) {
  const [historyPages, setHistoryPages] = useState(new Map<number, ChatMessage>());
  const [historyLoading, setHistoryLoading] = useState(false);
  const messageViewport = useRef<HTMLDivElement>(null),
    followReply = useRef(true);
  const historyAnchor = useRef<{ top: number; height: number } | null>(null);
  const messageCount = conversation.messageCount ?? conversation.messages.length;
  const displayed = new Map(historyPages);
  conversation.messages.forEach((message, index) =>
    displayed.set(messageCount - conversation.messages.length + index + 1, message),
  );
  const firstMessage = displayed.size ? Math.min(...displayed.keys()) : 1;
  useLayoutEffect(() => {
    const element = messageViewport.current;
    if (!element) return;
    if (historyAnchor.current) {
      element.scrollTop =
        historyAnchor.current.top + element.scrollHeight - historyAnchor.current.height;
      historyAnchor.current = null;
    } else if (followReply.current) element.scrollTop = element.scrollHeight;
  }, [historyPages, messageCount, conversation.runState?.sequence]);
  useEffect(() => {
    // Keep already visible messages when the latest server page advances.
    setHistoryPages((previous) => {
      const next = new Map(previous);
      conversation.messages.forEach((message, index) =>
        next.set(messageCount - conversation.messages.length + index + 1, message),
      );
      return next;
    });
  }, [conversation.messages, messageCount]);
  const loadEarlier = async () => {
    setHistoryLoading(true);
    try {
      const page = await api<{ messages: ChatMessage[] }>(
        `/conversations/${conversation.id}/messages?before=${firstMessage}`,
      );
      followReply.current = false;
      if (messageViewport.current)
        historyAnchor.current = {
          top: messageViewport.current.scrollTop,
          height: messageViewport.current.scrollHeight,
        };
      setHistoryPages((previous) => {
        const next = new Map(previous);
        page.messages.forEach((message, index) =>
          next.set(firstMessage - page.messages.length + index, message),
        );
        return next;
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
    } finally {
      setHistoryLoading(false);
    }
  };
  const draftKey = `tl:conversation-draft:${conversation.id}`;
  const draftStateKey = `tl:conversation-draft-state:${conversation.id}`;
  const draftState = useRef(readTutorDraft(stored(draftStateKey), stored(draftKey)));
  const conceptKey = `tl:concept-draft:${conversation.id}`;
  const retryKey = `tl:conversation-request:${conversation.id}`;
  const attachmentKey = `tl:attachment-draft:${conversation.id}`;
  const attachmentStampKey = `tl:attachment-selection:${conversation.id}`;
  const generationKey = `tl:generation-draft:${conversation.id}`;
  const webKey = `tl:web-draft:${conversation.id}`;
  const [webDraft, setWebDraft] = useState(() => readWebDraft(stored(webKey)));
  const webRef = useRef(webDraft);
  const writeWeb = (value: WebDraft) => {
    webRef.current = value;
    setWebDraft(value);
    store(webKey, JSON.stringify(value));
  };
  const [generationPreference, setGenerationPreference] = useState<TutorPreference>(() => {
    try {
      const parsed = tutorPreferenceSchema.safeParse(JSON.parse(stored(generationKey) || 'null'));
      return parsed.success ? parsed.data : defaultTutorPreference;
    } catch {
      return defaultTutorPreference;
    }
  });
  const generationRef = useRef(generationPreference);
  generationRef.current = generationPreference;
  const changeGeneration = (value: TutorPreference) => {
    generationRef.current = value;
    setGenerationPreference(value);
    store(generationKey, JSON.stringify(value));
  };
  const [attachments, setAttachments] = useState<QuestionAttachment[]>(() => {
    try {
      const value = questionAttachmentSchema
        .array()
        .max(MAX_QUESTION_ATTACHMENTS)
        .safeParse(JSON.parse(stored(attachmentKey) || '[]'));
      return value.success ? value.data : [];
    } catch {
      return [];
    }
  });
  const attachmentRef = useRef(attachments);
  attachmentRef.current = attachments;
  const attachmentStamps = useRef<Record<string, string>>(
    (() => {
      let saved: Record<string, string> = {};
      try {
        saved = JSON.parse(stored(attachmentStampKey) || '{}');
      } catch {}
      return Object.fromEntries(
        attachments.map((item) => [
          item.id,
          typeof saved[item.id] === 'string' ? saved[item.id] : crypto.randomUUID(),
        ]),
      );
    })(),
  );
  const changeAttachments = (items: QuestionAttachment[]) => {
    attachmentStamps.current = Object.fromEntries(
      items.map((item) => [item.id, attachmentStamps.current[item.id] || crypto.randomUUID()]),
    );
    store(attachmentStampKey, JSON.stringify(attachmentStamps.current));
    attachmentRef.current = items;
    setAttachments(items);
    store(attachmentKey, JSON.stringify(items));
  };
  const [attachmentPicker, setAttachmentPicker] = useState(false),
    [inspectedAttachment, setInspectedAttachment] = useState<string | null>(null);
  const [conceptDraft, setConceptDraft] = useState<{ items: ConceptMention[]; stamp: string }>(
    () => {
      try {
        const data = JSON.parse(stored(conceptKey) || '{}'),
          parsed = conceptMentionsSchema.safeParse(data.items);
        return {
          items: parsed.success ? parsed.data : [],
          stamp: typeof data.stamp === 'string' ? data.stamp : crypto.randomUUID(),
        };
      } catch {
        return { items: [], stamp: crypto.randomUUID() };
      }
    },
  );
  const conceptDraftRef = useRef(conceptDraft);
  conceptDraftRef.current = conceptDraft;
  const changeConcepts = (items: ConceptMention[]) => {
    const value = { items, stamp: crypto.randomUUID() };
    conceptDraftRef.current = value;
    setConceptDraft(value);
    store(conceptKey, JSON.stringify(value));
  };
  const [inspectedConcept, setInspectedConcept] = useState<
    (ConceptMention & { meaningIds?: string[] }) | null
  >(null);
  const [unavailableCitation, setUnavailableCitation] = useState<Extract<
    TutorCitation,
    { kind: 'source' }
  > | null>(null);
  const citationAction = useRef<((reference: TutorCitation) => void) | null>(null);
  const menuCommandsRef = useRef<ComposerMenuCommands | null>(null);
  const mentionBusy = useRef(false);
  const recoveredMaterials = useCitationRecovery(
    { ...conversation, messages: [...displayed.values()] },
    catalog,
  );
  const contextStampKey = `tl:question-context-stamp:${conversation.id}`;
  const contextStamp = useRef(stored(contextStampKey) || crypto.randomUUID());
  const contextKey = `tl:question-context:${conversation.id}`;
  const [context, setContext] = useState<QuestionContext | null>(() => {
    try {
      const value = questionContextSchema.safeParse(JSON.parse(stored(contextKey) || 'null'));
      return value.success ? value.data : null;
    } catch {
      return null;
    }
  });
  const contextRef = useRef(context),
    composer = useRef<TipTapComposerHandle>(null);
  const composerAnchor = useRef<HTMLDivElement>(null);
  const referenceChipAnchor = useRef<HTMLDivElement>(null);
  const [suggestion, setSuggestion] = useState<ComposerSuggestion | null>(null);
  contextRef.current = context;
  const changeContext = (value: QuestionContext | null) => {
    contextRef.current = value;
    contextStamp.current = crypto.randomUUID();
    store(contextStampKey, contextStamp.current);
    setContext(value);
    store(contextKey, value ? JSON.stringify(value) : '');
  };
  useEffect(() => {
    if (!questionRequest) return;
    changeContext(questionRequest.context);
    if (questionRequest.prompt)
      changeDraft(`${draftRef.current ? `${draftRef.current}\n\n` : ''}${questionRequest.prompt}`);
    consumeQuestion();
    composer.current?.focus();
  }, [questionRequest?.id]);
  useEffect(() => {
    if (!incomingAttachment) return;
    consumeAttachment();
    const current = attachmentRef.current,
      item = incomingAttachment.item;
    if (current.some((value) => value.id === item.id)) return;
    if (current.length >= MAX_QUESTION_ATTACHMENTS) onError(t.attachmentLimit);
    else changeAttachments([...current, item]);
    composer.current?.focus();
  }, [incomingAttachment?.id]);
  const [draft, setDraft] = useState(() => draftState.current.text),
    [pending, setPending] = useState(false),
    [submission, setSubmission] = useState(() => readTutorSubmission(stored(retryKey))),
    [disconnected, setDisconnected] = useState(false),
    [mentionPending, setMentionPending] = useState(false),
    [refPanel, setRefPanel] = useState(false),
    [rename, setRename] = useState(false),
    [title, setTitle] = useState(conversation.name),
    [query, setQuery] = useState('');
  const seenRename = useRef(renameRequest);
  useEffect(() => {
    if (renameRequest === seenRename.current) return;
    seenRename.current = renameRequest;
    setTitle(conversation.name);
    setRename(true);
  }, [renameRequest]);
  // Suggestion open/close and query live inside the TipTap Mention extension; the parent
  // just renders the menu overlay when `suggestion` is non-null. No caret tracking, no
  // dismissedAt bookkeeping — TipTap's plugin tears the suggestion down on space/escape/etc.
  const draftRef = useRef(draft),
    alive = useRef(true);
  draftRef.current = draft;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const persistedRef = useRef(persisted),
    persistRef = useRef(persist);
  persistedRef.current = persisted;
  persistRef.current = persist;
  const detailRef = useRef(conversation),
    receiveRef = useRef(receive),
    changedRef = useRef(changed);
  detailRef.current = newerConversation(detailRef.current, conversation);
  receiveRef.current = receive;
  changedRef.current = changed;
  const [controlBusy, setControlBusy] = useState(false);
  // Tutor note suggestions seed a draft; dismissals are per-conversation until reload.
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(() => new Set());
  const submitLock = useRef(false),
    controlLock = useRef(false);
  const writeDraft = (value: TutorDraft) => {
    store(draftStateKey, JSON.stringify(value));
    store(draftKey, value.text);
  };
  const changeDraft = (text: string) => {
    const value = { text, stamp: crypto.randomUUID() };
    draftState.current = value;
    draftRef.current = text;
    writeDraft(value);
    setDraft(text);
  };
  // Externally driven draft changes (prefill from a question, clear after submit, cross-tab
  // sync) need to be pushed into the TipTap editor; self-echoes are no-ops inside setDraft.
  useEffect(() => {
    composer.current?.setDraft(draft);
  }, [draft]);
  const syncDraft = () => {
    const web = readWebDraft(stored(webKey));
    webRef.current = web;
    setWebDraft(web);
    const value = readTutorDraft(stored(draftStateKey), stored(draftKey));
    draftState.current = value;
    draftRef.current = value.text;
    setDraft(value.text);
    const passage = questionContextSchema.safeParse(JSON.parse(stored(contextKey) || 'null'));
    contextRef.current = passage.success ? passage.data : null;
    setContext(contextRef.current);
    contextStamp.current = stored(contextStampKey) || contextStamp.current;
    try {
      const saved = JSON.parse(stored(conceptKey) || '{}'),
        items = conceptMentionsSchema.safeParse(saved.items);
      if (items.success && typeof saved.stamp === 'string') {
        conceptDraftRef.current = { items: items.data, stamp: saved.stamp };
        setConceptDraft(conceptDraftRef.current);
      }
    } catch {}
    try {
      const saved = questionAttachmentSchema
        .array()
        .max(MAX_QUESTION_ATTACHMENTS)
        .safeParse(JSON.parse(stored(attachmentKey) || '[]'));
      if (saved.success) {
        attachmentRef.current = saved.data;
        setAttachments(saved.data);
      }
      attachmentStamps.current = JSON.parse(stored(attachmentStampKey) || '{}');
    } catch {}
    setSubmission(readTutorSubmission(stored(retryKey)));
  };
  const notifyDraft = () => window.dispatchEvent(new Event('tl:tutor-draft-sync'));
  useEffect(() => {
    if (!stored(webKey)) store(webKey, JSON.stringify(webRef.current));
    if (!stored(draftStateKey)) writeDraft(draftState.current);
    if (!stored(contextStampKey)) store(contextStampKey, contextStamp.current);
    if (!stored(conceptKey)) store(conceptKey, JSON.stringify(conceptDraftRef.current));
    if (!stored(attachmentStampKey))
      store(attachmentStampKey, JSON.stringify(attachmentStamps.current));
    try {
      syncDraft();
    } catch {}
    const sync = () => {
      try {
        syncDraft();
      } catch {}
    };
    window.addEventListener('storage', sync);
    window.addEventListener('tl:tutor-draft-sync', sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('tl:tutor-draft-sync', sync);
    };
  }, [conversation.id]);
  const acknowledge = (sent: TutorSubmission) => {
    const current = readTutorDraft(stored(draftStateKey), stored(draftKey));
    const next = acknowledgeTutorDraft(current, sent);
    if (next !== current) writeDraft(next);
    const web = readWebDraft(stored(webKey));
    const nextWeb = acknowledgeWebDraft(web, sent);
    if (nextWeb !== web) store(webKey, JSON.stringify(nextWeb));
    try {
      const concepts = JSON.parse(stored(conceptKey) || '{}');
      if (sent.conceptStamp && concepts.stamp === sent.conceptStamp)
        store(conceptKey, JSON.stringify({ items: [], stamp: crypto.randomUUID() }));
      if (sent.contextStamp && stored(contextStampKey) === sent.contextStamp) {
        store(contextKey, '');
        store(contextStampKey, crypto.randomUUID());
      }
      const selected = questionAttachmentSchema
        .array()
        .safeParse(JSON.parse(stored(attachmentKey) || '[]'));
      const stamps = JSON.parse(stored(attachmentStampKey) || '{}');
      if (selected.success && sent.attachmentStamps) {
        const kept = acknowledgeTutorAttachments(selected.data, stamps, sent);
        store(
          attachmentStampKey,
          JSON.stringify(Object.fromEntries(kept.map((item) => [item.id, stamps[item.id]]))),
        );
        store(attachmentKey, JSON.stringify(kept));
      }
    } catch {}
    if (readTutorSubmission(stored(retryKey))?.payload.requestId === sent.payload.requestId)
      store(retryKey, '');
    notifyDraft();
  };
  const reconcile = async (sent = readTutorSubmission(stored(retryKey))) => {
    if (!sent || !persistedRef.current) return false;
    try {
      const receipt = await api<{
        accepted: boolean;
        requestId: string;
        acceptanceFingerprint?: string;
      }>(`/conversations/${conversation.id}/turns/${sent.payload.requestId}`);
      if (!receipt.accepted || receipt.requestId !== sent.payload.requestId) return false;
      if (
        receipt.acceptanceFingerprint &&
        receipt.acceptanceFingerprint !== (await turnInputFingerprint(sent.payload))
      ) {
        if (readTutorSubmission(stored(retryKey))?.payload.requestId === sent.payload.requestId) {
          store(retryKey, JSON.stringify({ ...sent, error: t.savedRequestConflict }));
          notifyDraft();
        }
        return false;
      }
      acknowledge(sent);
      return true;
    } catch (error) {
      if (error instanceof ApiResponseError && error.status === 404) return false;
      throw error;
    }
  };
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;
  useEffect(() => {
    let cancelled = false,
      loading = false,
      gone = false,
      timer: number | undefined;
    // A draft has nothing on the server to follow yet.
    if (!persisted) return;
    const load = async () => {
      if (loading || cancelled || gone) return;
      loading = true;
      window.clearTimeout(timer);
      try {
        const value = await api<ConversationDetail>(`/conversations/${conversation.id}`);
        if (cancelled) return;
        setDisconnected(false);
        const previous = detailRef.current,
          next = newerConversation(previous, value);
        if (next !== previous) {
          detailRef.current = next;
          await receiveRef.current(next, false);
        }
        if (
          !next.pending &&
          (previous.pending ||
            (previous.messageCount ?? previous.messages.length) !==
              (next.messageCount ?? next.messages.length))
        )
          void changedRef.current().catch(() => {});
        await reconcileRef.current().catch(() => {});
      } catch (error) {
        // Deleted elsewhere, or with its project: stop following it and let the list move on.
        if (error instanceof ApiResponseError && error.status === 404) {
          gone = true;
          void changedRef.current().catch(() => {});
        } else if (!cancelled) setDisconnected(true);
      } finally {
        loading = false;
        if (!cancelled && !gone)
          timer = window.setTimeout(
            () => void load(),
            detailRef.current.pending || readTutorSubmission(stored(retryKey)) ? 750 : 2500,
          );
      }
    };
    const wake = () => {
      if (document.visibilityState === 'visible') void load();
    };
    void load();
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [conversation.id, persisted]);
  const paused = new Set(conversation.pausedSourceIds || []);
  // Permanent references derive from the session's open resource tabs, deduplicated and
  // pruned to still-existing catalog entries. Pause state is per-conversation and persists
  // through tab churn; closing a tab removes the reference next render.
  const permanentReferenceIds = React.useMemo(() => {
    const valid = new Set(catalog.files.map((file) => file.id));
    return [...new Set(openSourceIds)].filter((id) => valid.has(id));
  }, [openSourceIds, catalog.files]);
  const patch = async (value: Partial<Conversation>) => {
    if (!persisted) {
      await receive({ ...conversation, ...value } as ConversationDetail, false);
      return true;
    }
    try {
      await receive(
        await api<ConversationDetail>(`/conversations/${conversation.id}`, 'PATCH', value),
      );
      return true;
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
      return false;
    }
  };
  const act = async (
    turn: TurnView,
    action: TurnAction['action'],
    edit?: Pick<TurnAction, 'prompt' | 'generation'>,
  ) => {
    if (controlLock.current) return null;
    controlLock.current = true;
    setControlBusy(true);
    const operationKey = `tl:tutor-control:${conversation.id}`;
    const intent = JSON.stringify({ id: turn.id, action, revision: turn.revision, ...edit });
    let operationId = crypto.randomUUID();
    try {
      const previous = JSON.parse(stored(operationKey) || '{}');
      if (previous.intent === intent && typeof previous.operationId === 'string')
        operationId = previous.operationId;
    } catch {}
    store(operationKey, JSON.stringify({ intent, operationId }));
    try {
      const value = await api<TurnView>(
        `/conversations/${conversation.id}/turns/${turn.id}`,
        'POST',
        { action, revision: turn.revision, operationId, ...edit },
      );
      if (stored(operationKey) === JSON.stringify({ intent, operationId })) store(operationKey, '');
      const next = await api<ConversationDetail>(`/conversations/${conversation.id}`);
      detailRef.current = newerConversation(detailRef.current, next);
      await receive(detailRef.current);
      if (action !== 'edit' && action !== 'save') composer.current?.focus({ preventScroll: true });
      return value;
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
      try {
        await receive(await api<ConversationDetail>(`/conversations/${conversation.id}`), false);
      } catch {}
      return null;
    } finally {
      controlLock.current = false;
      if (alive.current) setControlBusy(false);
    }
  };
  const resolve = async (sourceId: string, segmentId: string, question?: QuestionContext) => {
    if (question?.sourceId === sourceId && segmentId === 'selected-passage') {
      cite(sourceId, {
        id: segmentId,
        text: question.location.quote || '',
        ...(question.location.page ? { page: question.location.page } : {}),
        ...(question.location.seconds != null ? { start: question.location.seconds } : {}),
      });
      return;
    }
    try {
      const learning = await api<PublicLearning | null>(`/learning/${sourceId}`);
      const segment = learning?.segments.find((item) => item.id === segmentId);
      if (segment) cite(sourceId, segment);
      else onError(t.evidenceUnavailable);
    } catch (error) {
      onError(error instanceof Error ? error.message : t.error);
    }
  };
  // Mentioning a file opens it as a session tab if it isn't already open, so the next render
  // sees it as a permanent reference and the agent can use it. If the file is open but paused
  // we also unpause so the chip reflects the student's intent. The composer writes the chip
  // itself via the suggestion's `command` callback, so we never touch the draft here.
  const mention = async (file: Source): Promise<boolean> => {
    if (mentionBusy.current) return false;
    mentionBusy.current = true;
    setMentionPending(true);
    try {
      if (!openSourceIds.includes(file.id)) {
        openFile(file.id);
      }
      if (paused.has(file.id)) {
        if (!(await patch({ pausedSourceIds: [...paused].filter((id) => id !== file.id) })))
          return false;
      }
      return true;
    } finally {
      mentionBusy.current = false;
      if (alive.current) setMentionPending(false);
    }
  };
  const [dropActive, setDropActive] = useState(false);
  const accepts = (event: React.DragEvent) =>
    event.dataTransfer.types.includes(RESOURCE_DRAG_TYPE) ||
    event.dataTransfer.types.includes('Files');
  /** Tree files open as a session tab (becoming a permanent reference); files from the
   * computer become one-shot attachments. */
  const dropOnComposer = async (event: React.DragEvent) => {
    const resource = event.dataTransfer.getData(RESOURCE_DRAG_TYPE);
    if (resource) {
      const file = catalog.files.find((entry) => entry.id === JSON.parse(resource).id);
      if (!file) return;
      if (!openSourceIds.includes(file.id)) openFile(file.id);
      if (paused.has(file.id))
        await patch({ pausedSourceIds: [...paused].filter((id) => id !== file.id) });
      return;
    }
    for (const file of [...event.dataTransfer.files]) {
      if (attachmentRef.current.length >= MAX_QUESTION_ATTACHMENTS)
        return onError(t.attachmentLimit);
      if (!kindFor(file.name)) return onError(`${t.unsupported}: ${file.name}`);
      if (file.size > 20 * 1024 * 1024) return onError(t.attachmentUploadLimit);
      try {
        const saved = await uploadFile(file, 'Attachments', () => {});
        await changed();
        const item = await api<QuestionAttachment>('/tutor-attachments', 'POST', {
          kind: 'file',
          sourceId: saved.id,
          sourceVersion: saved.version,
          id: crypto.randomUUID(),
          sessionId: conversation.sessionId,
        });
        if (alive.current) changeAttachments([...attachmentRef.current, item]);
      } catch (error) {
        onError(error instanceof Error ? error.message : t.error);
        return;
      }
    }
  };
  const mentionConcept = (entry: GlossaryEntry): boolean => {
    const current = conceptDraftRef.current.items;
    if (!current.some((c) => c.id === entry.id) && current.length >= MAX_QUESTION_CONCEPTS) {
      onError(t.conceptLimit);
      return false;
    }
    changeConcepts([...current.filter((c) => c.id !== entry.id), conceptMention(entry)]);
    return true;
  };
  const citationLabel = (ref: TutorCitation) =>
    ref.kind === 'web'
      ? `${t.webSource} · ${new URL(ref.url).hostname}`
      : ref.kind === 'attachment'
        ? ref.attachmentName
        : ref.kind === 'concept'
          ? ref.term
          : ref.location.page
            ? `${t.page} ${ref.location.page}`
            : ref.location.seconds != null
              ? `${Math.floor(ref.location.seconds / 60)}:${String(Math.floor(ref.location.seconds % 60)).padStart(2, '0')}`
              : catalog.files.find((f) => f.id === ref.sourceId)?.name || t.source;
  const openCitation = (ref: TutorCitation) => {
    if (ref.kind === 'web') return;
    if (ref.kind === 'attachment') {
      setInspectedAttachment(ref.attachmentId);
      return;
    }
    if (ref.kind === 'concept') {
      setInspectedConcept({
        id: ref.conceptId,
        term: ref.term,
        version: ref.version,
        reviewed: ref.reviewed,
        ...(ref.meaningIds ? { meaningIds: ref.meaningIds } : {}),
      });
      return;
    }
    const file = catalog.files.find((f) => f.id === ref.sourceId);
    if (
      !file ||
      file.version !== ref.sourceVersion ||
      sourceState(file, catalog.directories) === 'trash'
    ) {
      setUnavailableCitation(ref);
      return;
    }
    cite(ref.sourceId, {
      id: ref.segmentId,
      text: `${ref.location.quote || ''}${ref.excerptTruncated ? '…' : ''}`,
      ...(ref.location.page ? { page: ref.location.page } : {}),
      ...(ref.location.seconds != null ? { start: ref.location.seconds } : {}),
    });
  };
  citationAction.current = openCitation;
  const contextFor = (message: (typeof conversation.messages)[number]) =>
    message.context ||
    (message.requestId
      ? conversation.messages.find(
          (item) => item.role === 'user' && item.requestId === message.requestId,
        )?.context
      : undefined);
  async function submitSaved(sent: TutorSubmission) {
    if (submitLock.current) return;
    submitLock.current = true;
    setPending(true);
    try {
      if (!persistedRef.current) await persistRef.current();
      const next = await api<ConversationDetail>(
        `/conversations/${conversation.id}/turns`,
        'POST',
        sent.payload,
      );
      if (next.acceptedRequestId !== sent.payload.requestId)
        throw new Error(t.acceptanceUnconfirmed);
      acknowledge(sent);
      detailRef.current = newerConversation(detailRef.current, next);
      await receive(detailRef.current);
    } catch (error) {
      try {
        if (await reconcile(sent)) return;
      } catch {}
      if (readTutorSubmission(stored(retryKey))?.payload.requestId === sent.payload.requestId) {
        const unchangedContext =
          stored(contextStampKey) === sent.contextStamp &&
          JSON.parse(stored(conceptKey) || '{}').stamp === sent.conceptStamp &&
          JSON.stringify(JSON.parse(stored(attachmentStampKey) || '{}')) ===
            JSON.stringify(sent.attachmentStamps || {});
        const currentDraft = readTutorDraft(stored(draftStateKey), stored(draftKey));
        const restored = restoreTutorDraft(currentDraft, sent, unchangedContext);
        const currentWeb = readWebDraft(stored(webKey));
        const restoredWeb = restoreWebDraft(
          currentWeb,
          restored.submission,
          restored.draft !== currentDraft,
        );
        if (restoredWeb.draft !== currentWeb) store(webKey, JSON.stringify(restoredWeb.draft));
        writeDraft(restored.draft);
        store(
          retryKey,
          JSON.stringify({
            ...restoredWeb.submission,
            error: (error instanceof Error ? error.message : t.error).slice(0, 500),
            rejected: error instanceof ApiResponseError && error.status < 500,
          }),
        );
        notifyDraft();
      }
      onError(error instanceof Error ? error.message : t.error);
    } finally {
      submitLock.current = false;
      if (alive.current) setPending(false);
    }
  }
  async function send() {
    const text = draftRef.current.trim();
    if (!text || submitLock.current || mentionBusy.current) return;
    const saved = readTutorSubmission(stored(retryKey));
    if (saved) {
      const sameDraft =
        draftState.current.stamp === saved.restoredStamp ||
        draftState.current.stamp === saved.draftStamp;
      const sameContext =
        contextStamp.current === saved.contextStamp &&
        conceptDraftRef.current.stamp === saved.conceptStamp &&
        JSON.stringify(attachmentStamps.current) === JSON.stringify(saved.attachmentStamps || {});
      if (sameDraft && sameContext) {
        await submitSaved(saved);
        return;
      }
      if (!saved.rejected) {
        onError(t.resolveUnconfirmedFirst);
        return;
      }
    }
    const imageBudgetError = questionImageBudget(attachmentRef.current);
    if (imageBudgetError) {
      onError(imageBudgetError);
      return;
    }
    const emptyStamp = crypto.randomUUID();
    const emptyWebStamp = crypto.randomUUID();
    const sent: TutorSubmission = {
      format: 2,
      draftStamp: draftState.current.stamp,
      emptyStamp,
      webStamp: webRef.current.stamp,
      emptyWebStamp,
      conceptStamp: conceptDraftRef.current.stamp,
      contextStamp: contextStamp.current,
      attachmentStamps: { ...attachmentStamps.current },
      payload: {
        requestId: crypto.randomUUID(),
        prompt: text,
        concepts: conceptDraftRef.current.items.map(({ id, version }) => ({ id, version })),
        attachments: attachmentRef.current.map((item) => item.id),
        references: permanentReferenceIds.filter((id) => !paused.has(id)),
        generation: resolveTutorGeneration(generationRef.current, catalog.settings.model),
        ...(webRef.current.enabled ? { webSearch: true as const } : {}),
        ...(contextRef.current ? { context: contextRef.current } : {}),
        ...(() => {
          // Chip-origin mentions the student actually inserted this turn — order matters so
          // the agent's tools can resolve each `@label` by index, not by substring lookup.
          const mentions = composer.current?.readMentions() ?? [];
          return mentions.length ? { mentions } : {};
        })(),
      },
    };
    store(retryKey, JSON.stringify(sent));
    setSubmission(sent);
    writeWeb({ enabled: false, stamp: emptyWebStamp });
    const empty = { text: '', stamp: emptyStamp };
    draftState.current = empty;
    draftRef.current = '';
    writeDraft(empty);
    setDraft('');
    await submitSaved(sent);
  }
  // The start hint gives way to a question being sent or one waiting to be resent.
  const empty =
    messageCount === 0 &&
    !conversation.pending &&
    !pending &&
    !submission &&
    !conversation.runState?.outbox?.length;
  return (
    <div className="assistant">
      <div
        ref={messageViewport}
        className={`conversation-messages${empty ? ' conversation-empty' : ''}`}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={(event) => {
          const element = event.currentTarget;
          followReply.current =
            element.scrollHeight - element.scrollTop - element.clientHeight < 48;
        }}
      >
        {empty && <p>{t.startConversationBody}</p>}
        {firstMessage > 1 && (
          <Button variant="ghost" disabled={historyLoading} onClick={() => void loadEarlier()}>
            {historyLoading ? t.loading : t.earlierMessages}
          </Button>
        )}
        {[...displayed.entries()]
          .sort(([a], [b]) => a - b)
          .map(([sequence, message]) => {
            const references =
              message.citations ?? recoverCitations(message, conversation, recoveredMaterials);
            return (
              <div
                className={`chat-entry ${message.role}`}
                key={`${conversation.id}:message:${sequence}`}
              >
                {message.role === 'user' && !!message.attachments?.length && (
                  <div className="message-attachments" aria-label={t.questionAttachments}>
                    {message.attachments.map((attachment) => (
                      <button
                        key={attachment.id}
                        type="button"
                        onClick={() => setInspectedAttachment(attachment.id)}
                      >
                        <Paperclip size={13} />
                        {attachment.name}
                      </button>
                    ))}
                  </div>
                )}
                <div className={`chat-message ${message.role}`}>
                  {message.turnKind === 'steering' && (
                    <small className="tutor-message-state">{t.steeringInstruction}</small>
                  )}
                  {message.status && (
                    <small className="tutor-message-state">
                      {t[`turn_${message.status}`]} · {t.partialReplyNotice}
                    </small>
                  )}
                  {message.role === 'user' && message.context && (
                    <div className="message-question-context">
                      <button
                        onClick={() =>
                          void resolve(
                            message.context!.sourceId,
                            'selected-passage',
                            message.context,
                          )
                        }
                      >
                        {message.context.sourceName}
                        {message.context.location.page
                          ? ` · ${t.page} ${message.context.location.page}`
                          : message.context.location.seconds != null
                            ? ` · ${Math.floor(message.context.location.seconds / 60)}:${String(Math.floor(message.context.location.seconds % 60)).padStart(2, '0')}`
                            : ''}
                      </button>
                      {message.context.location.quote && (
                        <blockquote>{message.context.location.quote}</blockquote>
                      )}
                    </div>
                  )}
                  {message.role === 'user' && message.concepts?.length ? (
                    <div className="message-concepts" aria-label={t.attachedConcepts}>
                      {message.concepts.map((ref) => (
                        <button key={ref.id} onClick={() => setInspectedConcept(ref)}>
                          {ref.term} · {t.revision} {ref.version}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <SavedTutorMessage
                    content={message.content}
                    references={references}
                    labels={Object.fromEntries(
                      references.map((reference) => [reference.id, citationLabel(reference)]),
                    )}
                    t={t}
                    open={citationAction}
                  />
                </div>
                {message.artifacts?.map((item) => (
                  <ArtifactProgress
                    key={item.id}
                    id={item.id}
                    title={item.title}
                    t={t}
                    open={openFile}
                    ready={() => void changed()}
                  />
                ))}
                {message.actions?.length ? (
                  <ActionLog
                    actions={message.actions}
                    t={t}
                    changed={() => void changed()}
                    openTest={openTest}
                  />
                ) : null}
                {message.role === 'assistant' &&
                  message.noteSuggestion?.recommended &&
                  (() => {
                    const suggestionKey = message.messageId || `seq:${sequence}`;
                    if (dismissedSuggestions.has(suggestionKey)) return null;
                    const suggestion = message.noteSuggestion;
                    const parentContext = contextFor(message);
                    return (
                      <div className="message-note">
                        <p>
                          {t.suggestedByTutor} ·{' '}
                          {t[`noteCategory_${suggestion.category}`]}
                        </p>
                        <div className="message-note-actions">
                          <Button
                            size="sm"
                            onClick={() =>
                              annotate(suggestion.body, [], parentContext)
                            }
                          >
                            {t.saveSuggestedNote}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() =>
                              setDismissedSuggestions((prev) => {
                                const next = new Set(prev);
                                next.add(suggestionKey);
                                return next;
                              })
                            }
                          >
                            {t.discardSuggestedNote}
                          </Button>
                        </div>
                      </div>
                    );
                  })()}
                {message.tools?.length ? (
                  <small>
                    {t.toolsUsed}:{' '}
                    {[...new Set(message.tools)].map((tool) => tutorToolLabel(tool, t)).join(', ')}
                  </small>
                ) : null}
                {message.generation && (
                  <small className="message-generation" aria-label={t.tutorGeneration}>
                    <GenerationLabel value={message.generation} t={t} />
                  </small>
                )}
                {message.webSearch && (
                  <small className="message-web-permission">
                    <Globe size={12} />{' '}
                    {message.role === 'user'
                      ? t.webEnabledQuestion
                      : message.webSearched
                        ? t.webSearched
                        : message.status
                          ? t.webUnconfirmed
                          : t.webNotSearched}
                  </small>
                )}
                {message.role === 'assistant' &&
                  message.webSearched &&
                  !references.some((ref) => ref.kind === 'web') && (
                    <small className="muted">{t.webNoCitations}</small>
                  )}
              </div>
            );
          })}
        {pending && submission && (
          <p className="muted" role="status">
            {t.savingQuestion}
          </p>
        )}
        {conversation.runState?.active && (
          <TurnProgress turn={conversation.runState.active} t={t} busy={controlBusy} act={act} />
        )}
        {disconnected && (
          <p role="status" className="tutor-connection-notice">
            {t.reconnectingReply}
          </p>
        )}
        {submission && !pending && (
          <section className="tutor-submission" aria-label={t.acceptanceUnconfirmed}>
            <strong>{t.acceptanceUnconfirmed}</strong>
            <p>{submission.payload.prompt}</p>
            {submission.payload.generation && (
              <small>
                <GenerationLabel value={submission.payload.generation} t={t} />
              </small>
            )}
            {submission.payload.webSearch && <small>{t.webEnabledQuestion}</small>}
            {submission.error && <p className="tutor-turn-error">{submission.error}</p>}
            <p className="muted">
              {submission.rejected ? t.rejectedQuestionNotice : t.unconfirmedQuestionNotice}
            </p>
            <Button onClick={() => void submitSaved(submission)}>{t.resendSavedQuestion}</Button>
          </section>
        )}
      </div>
      <TurnOutbox
        items={conversation.runState?.outbox || []}
        catalog={catalog}
        t={t}
        busy={controlBusy}
        act={act}
        inspectAttachment={setInspectedAttachment}
        conversationId={conversation.id}
      />
      <form
        className={`tutor-composer ${dropActive ? 'drop-active' : ''}`}
        onDragOver={(event) => {
          if (!accepts(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setDropActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDropActive(false);
        }}
        onDrop={(event) => {
          if (!accepts(event)) return;
          event.preventDefault();
          setDropActive(false);
          void dropOnComposer(event);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {context && (
          <div className="question-context" aria-label={t.questionContext}>
            <div>
              <strong>{t.questionContext}</strong>
              <IconButton label={t.removeQuestionContext} onClick={() => changeContext(null)}>
                <X />
              </IconButton>
            </div>
            <span>
              {context.sourceName}
              {context.location.page
                ? ` · ${t.page} ${context.location.page}`
                : context.location.seconds != null
                  ? ` · ${Math.floor(context.location.seconds / 60)}:${String(Math.floor(context.location.seconds % 60)).padStart(2, '0')}`
                  : ''}
            </span>
            {context.location.quote && <blockquote>{context.location.quote}</blockquote>}
            <small>{t.questionContextNotice}</small>
          </div>
        )}
        {suggestion && (
          <MentionCommandMenu
            ref={menuCommandsRef}
            suggestion={suggestion}
            catalog={catalog}
            anchor={composerAnchor.current}
            onPickFile={(file, command) => {
              void mention(file).then((ok) => {
                if (ok) command({ id: file.id, label: file.name, kind: 'file' });
                composer.current?.focus();
              });
            }}
            onPickConcept={(entry, command) => {
              if (mentionConcept(entry)) command({ id: entry.id, label: entry.term, kind: 'concept' });
              composer.current?.focus();
            }}
          />
        )}
        <div className="composer-card">
          <div className="composer-strip">
            <div className="reference-chip-wrap" ref={referenceChipAnchor}>
              <button
                type="button"
                className="reference-chip"
                aria-expanded={refPanel}
                aria-haspopup="dialog"
                title={[
                  ...permanentReferenceIds.map(
                    (id) =>
                      catalog.files.find((item) => item.id === id)?.name || t.missingReference,
                  ),
                  permanentReferenceIds.length
                    ? t.referencesNotice
                    : context
                      ? t.questionContextNotice
                      : attachments.length
                        ? t.attachmentQuestionContext
                        : t.generalTutorNotice,
                ].join('\n')}
                onClick={() => setRefPanel((value) => !value)}
              >
                <FileStack />
                <span>
                  {t.references} (
                  {paused.size
                    ? `${permanentReferenceIds.length - paused.size}/${permanentReferenceIds.length}`
                    : permanentReferenceIds.length}
                  )
                </span>
                <ChevronDown />
              </button>
              {refPanel && (
                <ReferencesPanel
                  t={t}
                  catalog={catalog}
                  sourceIds={permanentReferenceIds}
                  paused={paused}
                  pending={pending}
                  anchor={referenceChipAnchor.current}
                  onPause={(id, pauseIt) =>
                    void patch({
                      pausedSourceIds: pauseIt
                        ? [...paused, id]
                        : [...paused].filter((value) => value !== id),
                    })
                  }
                  onDismiss={() => setRefPanel(false)}
                />
              )}
            </div>
            {attachments.map((item) => (
              <span className="draft-chip" data-attachment-id={item.id} key={item.id}>
                <button
                  type="button"
                  title={`${t.inspectQuestionAttachment} · ${
                    attachmentImages(item).length
                      ? `${t.attachmentSelectedImages}: ${attachmentImages(item).length}`
                      : t.attachmentTextOnly
                  }`}
                  onClick={() => setInspectedAttachment(item.id)}
                >
                  <Paperclip />
                  <span>
                    {item.name}
                    {item.annotationRevision ? ` · ${t.revision} ${item.annotationRevision}` : ''}
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`${t.removeQuestionAttachment}: ${item.name}`}
                  title={t.removeQuestionAttachment}
                  onClick={() =>
                    changeAttachments(attachmentRef.current.filter((value) => value.id !== item.id))
                  }
                >
                  <X />
                </button>
              </span>
            ))}
          </div>
          <div className="composer-input" ref={composerAnchor}>
            <TipTapComposer
              ref={composer}
              initialDraft={draft}
              candidates={[
                ...catalog.files.map((file) => file.name),
                ...catalog.concepts.map((concept) => concept.term),
              ]}
              placeholder={t.chatPlaceholder}
              ariaLabel={t.assistant}
              onDraftChange={changeDraft}
              onSuggestionChange={setSuggestion}
              menuCommandsRef={menuCommandsRef}
              onSubmit={() => {
                composerAnchor.current?.closest('form')?.requestSubmit();
              }}
              onEscape={() => setSuggestion(null)}
              onEmptyBackspace={() => {
                const concepts = conceptDraftRef.current.items;
                const attachments = attachmentRef.current;
                if (concepts.length) {
                  changeConcepts(concepts.slice(0, -1));
                  return true;
                }
                if (attachments.length) {
                  changeAttachments(attachments.slice(0, -1));
                  return true;
                }
                return false;
              }}
            />
          </div>
          <div className="composer-actions">
            <IconButton
              label={t.addQuestionAttachment}
              aria-pressed={attachmentPicker}
              onClick={() => setAttachmentPicker(true)}
            >
              <Plus />
            </IconButton>
            <Button
              variant="ghost"
              className="web-toggle"
              aria-pressed={webDraft.enabled}
              title={t.webOptInNotice}
              onClick={() => writeWeb({ enabled: !webDraft.enabled, stamp: crypto.randomUUID() })}
            >
              <Globe2 />
              {t.web}
            </Button>
            <GenerationControl
              value={generationPreference}
              defaultModel={catalog.settings.model}
              change={changeGeneration}
              t={t}
            />
            <Button
              variant="primary"
              type="submit"
              className="composer-send"
              aria-label={conversation.pending ? t.queueQuestion : t.send}
              title={conversation.pending ? t.queueQuestion : t.send}
              disabled={pending || mentionPending || !draft.trim()}
            >
              {pending ? (
                <LoaderCircle className="spin" />
              ) : conversation.pending ? (
                <CornerDownRight />
              ) : (
                <ArrowUp />
              )}
            </Button>
          </div>
        </div>
      </form>
      {attachmentPicker && (
        <AttachmentPicker
          sessionId={conversation.sessionId}
          source={source}
          catalog={catalog}
          t={t}
          treeActions={treeActions}
          chosen={attachments}
          choose={(item) => {
            if (attachmentRef.current.length >= MAX_QUESTION_ATTACHMENTS) {
              onError(t.attachmentLimit);
              return;
            }
            changeAttachments([...attachmentRef.current, item]);
          }}
          close={() => setAttachmentPicker(false)}
          changed={changed}
          prepareSource={prepareSource}
          createAttachment={createAttachment}
        />
      )}
      {inspectedAttachment && (
        <AttachmentInspector
          key={inspectedAttachment}
          id={inspectedAttachment}
          t={t}
          catalog={catalog}
          close={() => setInspectedAttachment(null)}
          cite={cite}
        />
      )}
      {inspectedConcept && (
        <ConceptInspector
          reference={inspectedConcept}
          catalog={catalog}
          t={t}
          close={() => setInspectedConcept(null)}
          openConcept={openConcept}
          cite={cite}
          useLatest={
            conceptDraft.items.some(
              (c) => c.id === inspectedConcept.id && c.version === inspectedConcept.version,
            ) && !inspectedConcept.meaningIds
              ? (entry) =>
                  changeConcepts(
                    conceptDraftRef.current.items.map((ref) =>
                      ref.id === entry.id ? conceptMention(entry) : ref,
                    ),
                  )
              : undefined
          }
        />
      )}
      {unavailableCitation && (
        <Modal
          title={t.savedSourceCitation}
          close={() => setUnavailableCitation(null)}
          closeLabel={t.close}
        >
          <p>{t.sourceUnavailable}</p>
          <p>
            {t.sourceVersion} {unavailableCitation.sourceVersion}
          </p>
          <blockquote>{unavailableCitation.location.quote}</blockquote>
        </Modal>
      )}
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
    </div>
  );
}

/**
 * The chat before any conversation exists: the same composer, with the open file as its
 * reference. Sending starts a new conversation in the session with that message.
 */
