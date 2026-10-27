import { useEffect, useRef, useState } from 'react';
import { StudyMarkdown } from '../study/StudyMarkdown';
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
import {
  questionContextSchema,
  type Conversation,
  type QuestionContext,
  type ChatMessage,
} from '../../shared/conversations';
import type { Catalog, Source, Segment, PublicLearning } from '../../shared/domain';
import { fold } from '../../shared/domain';
import { sourceState } from '../../shared/directories';
import { api } from '../api';
import { Button, IconButton, Modal } from '../design/components';
import type { T } from '../i18n';
import { DirectoryTree, type TreeActions } from './DirectoryTree';
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
import { TutorMentionPicker, type MentionPickerHandle } from '../tutor/TutorMentionPicker';
import { citationFromHref, remarkTutorCitations } from '../tutor/citations';
import { useCitationRecovery } from '../tutor/useCitationRecovery';
import { AttachmentPicker } from '../tutor/AttachmentPicker';
import { AttachmentInspector } from '../tutor/AttachmentInspector';
import { GenerationControl, GenerationLabel } from '../tutor/GenerationControl';
import {
  tutorPreferenceSchema,
  defaultTutorPreference,
  resolveTutorGeneration,
  type TutorPreference,
  type TutorGeneration,
} from '../../shared/tutor-generation';
import type { AnnotationRequest } from '../annotations/AnnotationEditor';
import {
  questionAttachmentSchema,
  MAX_QUESTION_ATTACHMENTS,
  attachmentMention,
  type QuestionAttachment,
  type AttachmentMention,
} from '../../shared/tutor-attachments';

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
  openConcept,
  prepareSource,
  createAttachment,
}: {
  sessionId: string;
  source: Source | null;
  catalog: Catalog;
  t: T;
  treeActions: TreeActions;
  annotate: (content: string, sourceIds: string[], context?: QuestionContext) => void;
  questionRequest: { id: string; context: QuestionContext; prompt?: string } | null;
  consumeQuestion: () => void;
  openConcept: (id: string) => void;
  prepareSource: (source: Source) => void;
  createAttachment: () => Promise<AnnotationRequest | null>;
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
        sourceIds: questionRequest ? [] : source ? [source.id] : [],
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
  const handledRequest = useRef('');
  useEffect(() => {
    if (!questionRequest || loading) return;
    setHistory(false);
    if (!current && !creating && handledRequest.current !== questionRequest.id) {
      handledRequest.current = questionRequest.id;
      void create();
    }
  }, [questionRequest?.id, loading, current?.id, creating]);
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
          questionRequest={questionRequest}
          consumeQuestion={consumeQuestion}
          openConcept={openConcept}
          source={source}
          changed={changed}
          prepareSource={prepareSource}
          createAttachment={createAttachment}
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
  questionRequest,
  consumeQuestion,
  openConcept,
  source,
  changed,
  prepareSource,
  createAttachment,
}: {
  conversation: Conversation;
  catalog: Catalog;
  t: T;
  treeActions: TreeActions;
  annotate: (content: string, sourceIds: string[], context?: QuestionContext) => void;
  questionRequest: { id: string; context: QuestionContext; prompt?: string } | null;
  consumeQuestion: () => void;
  openConcept: (id: string) => void;
  source: Source | null;
  changed: () => Promise<unknown>;
  prepareSource: (source: Source) => void;
  createAttachment: () => Promise<AnnotationRequest | null>;
  receive: (conversation: Conversation) => Promise<void>;
  onError: (message: string) => void;
  cite: (sourceId: string, segment: Segment) => void;
}) {
  const draftKey = `tl:conversation-draft:${conversation.id}`;
  const conceptKey = `tl:concept-draft:${conversation.id}`;
  const retryKey = `tl:conversation-request:${conversation.id}`;
  const attachmentKey = `tl:attachment-draft:${conversation.id}`;
  const generationKey = `tl:generation-draft:${conversation.id}`;
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
  const [runningGeneration, setRunningGeneration] = useState<TutorGeneration | null>(null),
    [sentGeneration, setSentGeneration] = useState<TutorGeneration | null>(null);
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
  const changeAttachments = (items: QuestionAttachment[]) => {
    attachmentRef.current = items;
    setAttachments(items);
    store(attachmentKey, JSON.stringify(items));
  };
  const removeSentAttachments = (ids: string[]) =>
    changeAttachments(attachmentRef.current.filter((item) => !ids.includes(item.id)));
  const [attachmentPicker, setAttachmentPicker] = useState(false),
    [inspectedAttachment, setInspectedAttachment] = useState<string | null>(null),
    [sentAttachments, setSentAttachments] = useState<AttachmentMention[]>([]);
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
  const mentionPicker = useRef<MentionPickerHandle>(null);
  const mentionBusy = useRef(false);
  const recoveredMaterials = useCitationRecovery(conversation, catalog);
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
    composer = useRef<HTMLTextAreaElement>(null);
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
  const [draft, setDraft] = useState(() => stored(draftKey)),
    [pending, setPending] = useState(false),
    [running, setRunning] = useState(false),
    [mentionPending, setMentionPending] = useState(false),
    [prompt, setPrompt] = useState(''),
    [picker, setPicker] = useState(false),
    [rename, setRename] = useState(false),
    [title, setTitle] = useState(conversation.name),
    [query, setQuery] = useState('');
  const mentionDismissedKey = `tl:mention-dismissed:${conversation.id}`;
  const [mentionDismissed, setMentionDismissed] = useState(
    () => !!stored(draftKey) && stored(mentionDismissedKey) === stored(draftKey),
  );
  useEffect(() => {
    store(mentionDismissedKey, mentionDismissed ? draft : '');
  }, [mentionDismissed, draft, mentionDismissedKey]);
  const mentionQuery = draft.match(/(?:^|\s)@([^\n@]*)$/)?.[1];
  const mentionOpen = !mentionDismissed && mentionQuery !== undefined;
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
        const value = await api<
          Conversation & {
            pending: boolean;
            pendingGeneration?: TutorGeneration;
          }
        >(`/conversations/${conversation.id}`);
        if (cancelled) return;
        setRunning(value.pending);
        setRunningGeneration(value.pendingGeneration || null);
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
  useEffect(() => {
    let sent: {
      requestId?: string;
      conceptStamp?: string;
      contextStamp?: string;
      context?: QuestionContext;
      attachments?: string[];
    } = {};
    try {
      sent = JSON.parse(stored(retryKey) || '{}');
    } catch {}
    if (
      !sent.requestId ||
      !conversation.messages.some((m) => m.role === 'assistant' && m.requestId === sent.requestId)
    )
      return;
    if (sent.conceptStamp === conceptDraftRef.current.stamp) changeConcepts([]);
    removeSentAttachments(sent.attachments || []);
    if (
      sent.contextStamp === contextStamp.current &&
      JSON.stringify(sent.context) === JSON.stringify(contextRef.current || undefined)
    )
      changeContext(null);
    store(retryKey, '');
  }, [conversation.messages]);
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
  const mention = async (file: Source) => {
    if (mentionBusy.current) return;
    mentionBusy.current = true;
    const before = draftRef.current;
    setMentionPending(true);
    try {
      if (!conversation.sourceIds.includes(file.id)) {
        if (conversation.sourceIds.length >= 20) {
          onError(t.referenceLimit);
          return;
        }
        if (!(await patch({ sourceIds: [...conversation.sourceIds, file.id] }))) return;
      }
      // A reference save may finish after the user has started a different draft.
      if (draftRef.current === before) {
        changeDraft(`${before.slice(0, before.lastIndexOf('@'))}@${file.name} `);
        setMentionDismissed(true);
      }
    } finally {
      mentionBusy.current = false;
      if (alive.current) setMentionPending(false);
    }
  };
  const mentionConcept = (entry: GlossaryEntry) => {
    const current = conceptDraftRef.current.items;
    if (!current.some((c) => c.id === entry.id) && current.length >= MAX_QUESTION_CONCEPTS) {
      onError(t.conceptLimit);
      return;
    }
    changeConcepts([...current.filter((c) => c.id !== entry.id), conceptMention(entry)]);
    changeDraft(`${draftRef.current.slice(0, draftRef.current.lastIndexOf('@'))}@${entry.term} `);
    setMentionDismissed(true);
    composer.current?.focus();
  };
  const citationLabel = (ref: TutorCitation) =>
    ref.kind === 'attachment'
      ? ref.attachmentName
      : ref.kind === 'concept'
        ? ref.term
        : ref.location.page
          ? `${t.page} ${ref.location.page}`
          : ref.location.seconds != null
            ? `${Math.floor(ref.location.seconds / 60)}:${String(Math.floor(ref.location.seconds % 60)).padStart(2, '0')}`
            : catalog.files.find((f) => f.id === ref.sourceId)?.name || t.source;
  const openCitation = (ref: TutorCitation) => {
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
  const contextFor = (message: (typeof conversation.messages)[number]) =>
    message.context ||
    (message.requestId
      ? conversation.messages.find(
          (item) => item.role === 'user' && item.requestId === message.requestId,
        )?.context
      : undefined);
  async function send() {
    const text = draftRef.current.trim(),
      question = contextRef.current || undefined;
    const questionConcepts = conceptDraftRef.current.items.map(({ id, version }) => ({
      id,
      version,
    }));
    const conceptStamp = conceptDraftRef.current.stamp,
      questionStamp = contextStamp.current;
    const questionAttachments = attachmentRef.current.map((item) => item.id);
    const generation = resolveTutorGeneration(generationRef.current, catalog.settings.model);
    const fingerprint = JSON.stringify({
      prompt: text,
      context: question,
      concepts: questionConcepts,
      sourceIds: [...conversation.sourceIds].sort(),
      attachments: questionAttachments,
      generation,
    });
    if (!text || pending || running || mentionBusy.current) return;
    let previous: { prompt?: string; requestId?: string; fingerprint?: string } = {};
    try {
      previous = JSON.parse(stored(retryKey) || '{}');
    } catch {}
    const requestId =
      previous.fingerprint === fingerprint && previous.requestId
        ? previous.requestId
        : crypto.randomUUID();
    store(
      retryKey,
      JSON.stringify({
        prompt: text,
        context: question,
        concepts: questionConcepts,
        attachments: questionAttachments,
        generation,
        conceptStamp,
        contextStamp: questionStamp,
        fingerprint,
        requestId,
      }),
    );
    setPending(true);
    setSentGeneration(generation);
    setSentAttachments(attachmentRef.current.map(attachmentMention));
    setPrompt(text);
    changeDraft('');
    try {
      const next = await api<Conversation>(`/conversations/${conversation.id}/turns`, 'POST', {
        prompt: text,
        requestId,
        concepts: questionConcepts,
        attachments: questionAttachments,
        generation,
        ...(question ? { context: question } : {}),
      });
      await receive(next);
      store(retryKey, '');
      removeSentAttachments(questionAttachments);
      if (conceptDraftRef.current.stamp === conceptStamp) changeConcepts([]);
      if (
        contextStamp.current === questionStamp &&
        JSON.stringify(contextRef.current || undefined) === JSON.stringify(question)
      )
        changeContext(null);
    } catch (error) {
      // Do not overwrite a new draft typed while this reply was running.
      if (
        !stored(draftKey) &&
        JSON.stringify(contextRef.current || undefined) === JSON.stringify(question)
      ) {
        store(draftKey, text);
        if (alive.current) setDraft(text);
      }
      onError(error instanceof Error ? error.message : t.error);
    } finally {
      if (alive.current) {
        setPending(false);
        setPrompt('');
        setSentAttachments([]);
        setSentGeneration(null);
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
        {conversation.sourceIds.length
          ? t.referencesNotice
          : context
            ? t.questionContextNotice
            : attachments.length
              ? t.attachmentQuestionContext
              : t.generalTutorNotice}
      </p>
      <div className="conversation-messages" aria-live="polite" aria-relevant="additions text">
        {conversation.messages.map((message, index) => {
          const references =
            message.citations ?? recoverCitations(message, conversation, recoveredMaterials);
          const byId = new Map(references.map((ref) => [ref.id, ref]));
          return (
            <div
              className={`chat-message ${message.role}`}
              key={`${message.requestId || 'history'}-${index}`}
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
              {message.role === 'user' && message.context && (
                <div className="message-question-context">
                  <button
                    onClick={() =>
                      void resolve(message.context!.sourceId, 'selected-passage', message.context)
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
              <StudyMarkdown
                t={t}
                remarkPlugins={[[remarkTutorCitations, { references, label: citationLabel }]]}
                components={{
                  a: ({ href, children }) => {
                    const ref = citationFromHref(href, byId);
                    if (ref)
                      return (
                        <button
                          className="evidence-link"
                          title={`${citationLabel(ref)}${ref.kind === 'concept' ? ` · ${t.revision} ${ref.version}` : ref.kind === 'source' && ref.recovered ? ` · ${t.recoveredCitationNotice}` : ''}`}
                          onClick={() => openCitation(ref)}
                        >
                          {children}
                        </button>
                      );
                    if (href?.startsWith('#tutor/') || href?.startsWith('#evidence/'))
                      return <span>{children}</span>;
                    return (
                      <a href={href} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {message.content}
              </StudyMarkdown>
              {message.role === 'assistant' && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    annotate(
                      message.content,
                      message.sourceIds || conversation.sourceIds,
                      contextFor(message),
                    )
                  }
                >
                  <Pencil size={14} />
                  {t.saveAsAnnotation}
                </Button>
              )}
              {message.tools?.length ? (
                <small>
                  {t.toolsUsed}:{' '}
                  {[...new Set(message.tools)]
                    .map(
                      (tool) =>
                        (
                          ({
                            read_segments: t.toolReadSegments,
                            practice_summary: t.toolPracticeSummary,
                            list_concepts: t.toolListConcepts,
                            read_concepts: t.toolReadConcepts,
                            create_bookmark: t.toolCreateBookmark,
                          }) as Record<string, string>
                        )[tool] || t.studyTool,
                    )
                    .join(', ')}
                </small>
              ) : null}
              {message.generation && (
                <small className="message-generation" aria-label={t.tutorGeneration}>
                  <GenerationLabel value={message.generation} t={t} />
                </small>
              )}
            </div>
          );
        })}
        {pending && (
          <>
            {!!sentAttachments.length && (
              <p className="muted">
                {t.questionAttachments}: {sentAttachments.map((item) => item.name).join(', ')}
              </p>
            )}
            <div className="chat-message user">
              <p>{prompt}</p>
            </div>
            <p role="status" className="muted">
              <LoaderCircle className="spin" size={14} /> {t.thinking}
              {sentGeneration && (
                <>
                  {' '}
                  · <GenerationLabel value={sentGeneration} t={t} />
                </>
              )}
            </p>
          </>
        )}
        {!pending && running && (
          <p role="status" className="muted">
            <LoaderCircle className="spin" size={14} /> {t.thinking}
            {runningGeneration && (
              <>
                {' '}
                · <GenerationLabel value={runningGeneration} t={t} />
              </>
            )}
          </p>
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {!!attachments.length && (
          <section className="question-attachments" aria-label={t.questionAttachments}>
            <strong>
              {t.questionAttachments} ({attachments.length}/{MAX_QUESTION_ATTACHMENTS})
            </strong>
            <p>{t.attachmentDraftNotice}</p>
            {attachments.map((item) => (
              <div className="question-attachment" data-attachment-id={item.id} key={item.id}>
                <button
                  type="button"
                  title={t.inspectQuestionAttachment}
                  onClick={() => setInspectedAttachment(item.id)}
                >
                  <Paperclip size={14} />
                  {item.name}
                  {item.annotationRevision ? ` · ${t.revision} ${item.annotationRevision}` : ''}
                  <small>{item.image ? t.attachmentIncludesImage : t.attachmentTextOnly}</small>
                </button>
                <IconButton
                  label={`${t.removeQuestionAttachment}: ${item.name}`}
                  onClick={() =>
                    changeAttachments(attachmentRef.current.filter((value) => value.id !== item.id))
                  }
                >
                  <X size={14} />
                </IconButton>
              </div>
            ))}
          </section>
        )}
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
        {!!conceptDraft.items.length && (
          <section className="question-concepts" aria-label={t.attachedConcepts}>
            <strong>{t.conceptsForQuestion}</strong>
            <p>{t.conceptAttachmentNotice}</p>
            {conceptDraft.items.map((ref) => {
              const current = catalog.concepts.find((c) => c.id === ref.id);
              return (
                <div className="question-concept" key={ref.id}>
                  <button
                    type="button"
                    title={t.inspectConcept}
                    onClick={() => setInspectedConcept(ref)}
                  >
                    {ref.term} · {t.revision} {ref.version}
                  </button>
                  {current && current.version !== ref.version && (
                    <small>
                      {t.newerConceptRevision} {current.version}
                    </small>
                  )}
                  <IconButton
                    label={`${t.removeConcept}: ${ref.term}`}
                    onClick={() =>
                      changeConcepts(conceptDraftRef.current.items.filter((c) => c.id !== ref.id))
                    }
                  >
                    <X size={14} />
                  </IconButton>
                </div>
              );
            })}
          </section>
        )}
        <textarea
          ref={composer}
          aria-label={t.assistant}
          placeholder={t.chatPlaceholder}
          maxLength={8000}
          value={draft}
          aria-autocomplete="list"
          aria-controls={mentionOpen ? `mentions-${conversation.id}` : undefined}
          aria-expanded={mentionOpen}
          onChange={(event) => {
            changeDraft(event.target.value);
            setMentionDismissed(false);
          }}
          onKeyDown={(event) => {
            if (!mentionOpen) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              setMentionDismissed(true);
              return;
            }
            if (!event.shiftKey && mentionPicker.current?.key(event.key)) event.preventDefault();
          }}
        />
        {mentionOpen && (
          <div id={`mentions-${conversation.id}`}>
            <TutorMentionPicker
              ref={mentionPicker}
              query={mentionQuery || ''}
              catalog={catalog}
              t={t}
              actions={treeActions}
              pickFile={(file) => {
                void mention(file).then(() => composer.current?.focus());
              }}
              pickConcept={mentionConcept}
              focusComposer={() => composer.current?.focus()}
            />
          </div>
        )}
        <div className="composer-actions">
          <IconButton label={t.addQuestionAttachment} onClick={() => setAttachmentPicker(true)}>
            <Plus size={16} />
          </IconButton>
          <GenerationControl
            value={generationPreference}
            defaultModel={catalog.settings.model}
            change={changeGeneration}
            t={t}
          />
          <Button
            variant="primary"
            type="submit"
            disabled={pending || running || mentionPending || !draft.trim()}
          >
            <ArrowUp size={15} />
            {t.send}
          </Button>
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
