import { useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  CircleAlert,
  FilePlus,
  Headphones,
  LayoutList,
  LoaderCircle,
  Clock,
  Languages,
  CircleDot,
  Search,
  Sparkles,
  MessageSquare,
  Wrench,
  SquareStack,
} from 'lucide-react';
import type { AgentEvent } from '../shared/agent-events';
import { kindFor, type Kind } from '../shared/domain';
import type { T } from './i18n';

/** The stages a file goes through from upload to a ready study guide. */
const STAGES = [
  'upload',
  'queued',
  'read',
  'transcribe',
  'translate',
  'synthesize',
  'glossary',
  'flashcards',
  'done',
] as const;
type Stage = (typeof STAGES)[number];
/** Stages that apply per uploaded kind — transcription and translation only make
 * sense for recordings, chapters/glossary for anything with teachable text. */
function stagesForKind(kind: Kind | null): readonly Stage[] {
  if (kind === 'video' || kind === 'audio') return STAGES;
  if (kind === 'pdf')
    return ['upload', 'queued', 'read', 'synthesize', 'glossary', 'flashcards', 'done'];
  if (kind === 'markdown' || kind === 'text')
    return ['upload', 'queued', 'read', 'synthesize', 'glossary', 'flashcards', 'done'];
  if (kind === 'image') return ['upload', 'queued', 'read', 'done'];
  return STAGES;
}
type Status = 'pending' | 'waiting' | 'active' | 'done' | 'failed' | 'hidden';

function elapsed(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000),
    seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}
/** Short local date + time for a lane header, e.g. "Nov 4, 16:48". */
function laneStamp(at: string, locale: 'en' | 'es') {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
const stageIcon: Record<Stage, React.ComponentType<{ size?: number }>> = {
  upload: FilePlus,
  queued: Clock,
  read: Search,
  transcribe: Headphones,
  translate: Languages,
  synthesize: LayoutList,
  glossary: BookOpen,
  flashcards: SquareStack,
  done: CircleDot,
};

type FileFlow = {
  fileId: string;
  fileName: string;
  /** The ordered subset of STAGES that applies to this file's kind. */
  order: readonly Stage[];
  stages: Record<
    Stage,
    { status: Status; label: string; progress?: { current: number; total: number } }
  >;
  /** The events that happened at each stage, newest first, so a stage can be expanded. */
  stageEvents: Record<Stage, AgentEvent[]>;
  firstAt: string;
};
const stageOf: Partial<Record<string, Stage>> = {
  'library.upload': 'upload',
  'preparation.queued': 'queued',
  'normalize.start': 'read',
  'normalize.done': 'read',
  'transcribe.chunk': 'transcribe',
  'translate.start': 'translate',
  'translate.chunk': 'translate',
  'translate.done': 'translate',
  'synthesize.start': 'synthesize',
  'synthesize.part': 'synthesize',
  'synthesize.done': 'synthesize',
  'glossary.round': 'glossary',
  'glossary.ingest': 'glossary',
  'flashcards.generate': 'flashcards',
  'flashcards.chapter.done': 'flashcards',
  'flashcards.done': 'flashcards',
  'preparation.done': 'done',
};

/** Reads the events of a file and reports which stage it reached. */
function fileFlows(events: AgentEvent[], t: T): FileFlow[] {
  const files = new Map<string, FileFlow>();
  const ensure = (event: AgentEvent) => {
    if (!event.fileId) return null;
    const name = event.fileName || event.fileId;
    // .artifact files are thin pointers to a source's study material — the actual artifact
    // generation events live on the source file's flow, so showing a separate row would
    // falsely imply another pipeline runs for the pointer.
    if (kindFor(name) === 'artifact') return null;
    let flow = files.get(event.fileId);
    if (!flow) {
      const order = stagesForKind(kindFor(name));
      flow = {
        fileId: event.fileId,
        fileName: name,
        order,
        stages: Object.fromEntries(
          order.map((stage) => [
            stage,
            { status: 'pending' as Status, label: t[`agentStage_${stage}` as keyof T] as string },
          ]),
        ) as FileFlow['stages'],
        stageEvents: Object.fromEntries(
          order.map((stage) => [stage, [] as AgentEvent[]]),
        ) as FileFlow['stageEvents'],
        firstAt: event.at,
      };
      files.set(event.fileId, flow);
    }
    if (event.at < flow.firstAt) flow.firstAt = event.at;
    return flow;
  };
  // Events arrive newest first, so iterate oldest first for stage transitions.
  for (const event of [...events].reverse()) {
    const flow = ensure(event);
    if (!flow) continue;
    const stage = stageOf[event.action];
    if (stage) flow.stageEvents[stage].unshift(event);
    const open = (
      stage: Stage,
      label?: string,
      progress?: FileFlow['stages'][Stage]['progress'],
    ) => {
      flow.stages[stage] = {
        ...flow.stages[stage],
        status: 'active',
        ...(label ? { label } : {}),
        ...(progress ? { progress } : {}),
      };
    };
    const done = (stage: Stage, label?: string) => {
      // A stage that just finished keeps no partial progress bar from its last running event.
      flow.stages[stage] = {
        status: 'done',
        label: label ?? flow.stages[stage].label,
      };
    };
    switch (event.action) {
      case 'library.upload':
        done('upload', t.agentStage_upload);
        break;
      case 'preparation.queued':
        done('queued', t.agentStage_queued);
        break;
      case 'normalize.start':
        open('read', t.agentStage_read);
        break;
      case 'normalize.done':
        done('read', t.agentStage_read);
        if (event.summary.match(/no audio/i)) {
          done('transcribe', t.agentStage_transcribe);
          done('translate', t.agentStage_translate);
        }
        break;
      case 'transcribe.chunk':
        open('transcribe', t.agentStage_transcribe, event.progress);
        if (event.progress && event.progress.current >= event.progress.total)
          done('transcribe', t.agentStage_transcribe);
        break;
      case 'translate.start':
      case 'translate.chunk':
        open('translate', t.agentStage_translate, event.progress);
        break;
      case 'translate.done':
        done('translate', t.agentStage_translate);
        break;
      case 'synthesize.start':
      case 'synthesize.part':
        open('synthesize', t.agentStage_synthesize, event.progress);
        break;
      case 'synthesize.done':
        done('synthesize', t.agentStage_synthesize);
        break;
      case 'glossary.round':
        open('glossary', t.agentStage_glossary, event.progress);
        break;
      case 'glossary.ingest':
        done('glossary', t.agentStage_glossary);
        break;
      case 'flashcards.generate':
        open('flashcards', t.agentStage_flashcards, event.progress);
        break;
      case 'flashcards.chapter.done':
        open('flashcards', t.agentStage_flashcards, event.progress);
        break;
      case 'flashcards.done':
        done('flashcards', t.agentStage_flashcards);
        break;
      case 'preparation.done':
        done('done', t.agentStage_done);
        break;
    }
  }
  // When nothing is running yet, the next stage after the latest done one takes over as
  // "waiting", so a stage is always moving between finish and start.
  for (const flow of files.values()) {
    const anyActive = flow.order.some((stage) => flow.stages[stage].status === 'active');
    if (anyActive) continue;
    let last = -1;
    for (let i = 0; i < flow.order.length; i++)
      if (flow.stages[flow.order[i]].status === 'done') last = i;
    const next = flow.order[last + 1];
    if (next && flow.stages[next].status === 'pending') flow.stages[next].status = 'waiting';
  }
  return [...files.values()];
}

function StageCard({
  stage,
  state,
  events,
  selected,
  select,
  t,
}: {
  stage: Stage;
  state: FileFlow['stages'][Stage];
  events: AgentEvent[];
  selected: boolean;
  select: () => void;
  t: T;
}) {
  const Icon = stageIcon[stage];
  const Mark =
    state.status === 'done'
      ? Check
      : state.status === 'active' || state.status === 'waiting'
        ? LoaderCircle
        : state.status === 'failed'
          ? CircleAlert
          : null;
  const empty = !events.length;
  return (
    <li className={`flow-stage ${state.status} ${selected ? 'selected' : ''}`}>
      <button
        type="button"
        className="flow-stage-head-button"
        onClick={select}
        disabled={empty}
        aria-pressed={selected}
      >
        <div className="flow-stage-head">
          <Icon size={16} aria-hidden="true" />
          <span>{state.label}</span>
        </div>
        <div
          className="flow-stage-mark"
          aria-label={t[`agentStatus_${state.status}` as keyof T] as string}
        >
          {Mark && (
            <Mark
              size={14}
              className={state.status === 'active' || state.status === 'waiting' ? 'spin' : ''}
            />
          )}
          {state.status === 'waiting' && <small>{t.agentStatus_waiting}</small>}
        </div>
        {state.progress && (
          <>
            <progress max={state.progress.total} value={state.progress.current} />
            <small>
              {state.progress.current}/{state.progress.total}
            </small>
          </>
        )}
      </button>
    </li>
  );
}

/**
 * Reads an ISO date into a short phrase. Under 10 seconds, "a few seconds ago"; from there,
 * the browser's relative time ("1 minute ago", "2 hours ago"); past 24 hours, the local date
 * and time, so stale events never read as recent.
 */
function timeLabel(at: string, locale: 'en' | 'es', justNow: string) {
  const now = Date.now(),
    then = new Date(at).getTime(),
    diffSeconds = Math.round((then - now) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 10) return justNow;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (abs < 60) return format.format(diffSeconds, 'second');
  const diffMinutes = Math.round(diffSeconds / 60);
  if (Math.abs(diffMinutes) < 60) return format.format(diffMinutes, 'minute');
  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) return format.format(diffHours, 'hour');
  return new Date(at).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The actions of the stage currently selected on a file's pipeline, as a vertical timeline. */
function StageDetails({
  stage,
  events,
  locale,
  t,
}: {
  stage: Stage;
  events: AgentEvent[];
  locale: 'en' | 'es';
  t: T;
}) {
  if (!events.length) return null;
  const Icon = stageIcon[stage];
  return (
    <div className="flow-stage-details">
      <header>
        <Icon size={14} aria-hidden="true" />
        <strong>{t[`agentStage_${stage}` as keyof T] as string}</strong>
        <small>
          {events.length} {events.length === 1 ? t.agentDetailStep : t.agentDetailSteps}
        </small>
      </header>
      <ol className="flow-timeline" aria-label={t[`agentStage_${stage}` as keyof T] as string}>
        {events.map((event) => {
          const metrics: string[] = [];
          if (event.usage?.input !== undefined)
            metrics.push(`${event.usage.input.toLocaleString()} in`);
          if (event.usage?.output !== undefined)
            metrics.push(`${event.usage.output.toLocaleString()} out`);
          if (event.usage?.input !== undefined && event.usage?.output !== undefined)
            metrics.push(
              `${((event.usage.input || 0) + (event.usage.output || 0)).toLocaleString()} ${t.agentTokensTotal}`,
            );
          if (event.usage?.audioSeconds !== undefined)
            metrics.push(`${Math.round(event.usage.audioSeconds)} ${t.agentAudioSeconds}`);
          if (event.elapsedMs !== undefined) metrics.push(elapsed(event.elapsedMs));
          return (
            <li key={event.id} className="flow-timeline-item">
              <time
                className="flow-timeline-time"
                dateTime={event.at}
                title={new Date(event.at).toLocaleString(locale)}
              >
                {timeLabel(event.at, locale, t.agentJustNow)}
              </time>
              <div className="flow-timeline-body">
                <strong>{event.summary}</strong>
                {event.model && (
                  <small className="flow-timeline-model">
                    {event.model}
                    {event.reasoningEffort ? ` · ${t.agentEffort}: ${event.reasoningEffort}` : ''}
                  </small>
                )}
                {metrics.length > 0 && (
                  <div className="flow-timeline-metrics">
                    {metrics.map((item, index) => (
                      <span key={index}>{item}</span>
                    ))}
                  </div>
                )}
                {event.detail && <small className="agent-detail">{event.detail}</small>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The stages a tutor turn passes through: the student's prompt arriving, the agent
 * thinking (model call + optional tool use), the reply completing, and — when the reply
 * started an artifact — its generation progress. */
const TUTOR_STAGES = ['received', 'thinking', 'tools', 'completed', 'artifact'] as const;
type TutorStage = (typeof TUTOR_STAGES)[number];
const tutorStageIcon: Record<TutorStage, React.ComponentType<{ size?: number }>> = {
  received: MessageSquare,
  thinking: Sparkles,
  tools: Wrench,
  completed: CircleDot,
  artifact: LayoutList,
};
type TutorFlow = {
  conversationId: string;
  conversationLabel: string;
  stages: Record<TutorStage, { status: Status; label: string }>;
  stageEvents: Record<TutorStage, AgentEvent[]>;
  firstAt: string;
};

function tutorFlows(events: AgentEvent[], t: T): TutorFlow[] {
  const by = new Map<string, TutorFlow>();
  const label: Record<TutorStage, string> = {
    received: (t as Record<string, string>).agentTutorStage_received || 'Prompt',
    thinking: (t as Record<string, string>).agentTutorStage_thinking || 'Thinking',
    tools: (t as Record<string, string>).agentTutorStage_tools || 'Tools',
    completed: (t as Record<string, string>).agentTutorStage_completed || 'Reply',
    artifact: (t as Record<string, string>).agentTutorStage_artifact || 'Artifact',
  };
  // Each tutor turn gets its own lane so successive messages don't overwrite the previous
  // one. The server embeds "turn <uuid>" in the event's detail string; parse it out and
  // combine it with the conversation id to key the lane. Events with no turn id fall back
  // to the conversation id so they still group somewhere.
  const turnOf = (event: AgentEvent): string => {
    const match =
      typeof event.detail === 'string' ? event.detail.match(/turn\s+([0-9a-f-]+)/i) : null;
    return match ? match[1] : event.conversationId || '';
  };
  const ensure = (event: AgentEvent): TutorFlow | null => {
    if (event.tool !== 'tutor' || !event.conversationId) return null;
    const key = `${event.conversationId}:${turnOf(event)}`;
    let flow = by.get(key);
    if (!flow) {
      flow = {
        conversationId: key,
        conversationLabel: event.conversationName || event.conversationId,
        stages: Object.fromEntries(
          TUTOR_STAGES.map((stage) => [
            stage,
            { status: 'pending' as Status, label: label[stage] },
          ]),
        ) as TutorFlow['stages'],
        stageEvents: Object.fromEntries(
          TUTOR_STAGES.map((stage) => [stage, [] as AgentEvent[]]),
        ) as TutorFlow['stageEvents'],
        firstAt: event.at,
      };
      by.set(key, flow);
    }
    if (event.at < flow.firstAt) flow.firstAt = event.at;
    if (event.conversationName) flow.conversationLabel = event.conversationName;
    return flow;
  };
  for (const event of [...events].reverse()) {
    const flow = ensure(event);
    if (!flow) continue;
    const mapTo: Partial<Record<string, TutorStage>> = {
      'tutor.turn.start': 'received',
      'tutor.turn.done': 'completed',
      'tutor.turn.failed': 'completed',
      'tutor.action': 'tools',
      'artifact.plan': 'artifact',
      'artifact.write.start': 'artifact',
      'artifact.chapter.done': 'artifact',
      'artifact.check': 'artifact',
      'artifact.ready': 'artifact',
      'artifact.failed': 'artifact',
    };
    const stage = mapTo[event.action];
    if (stage) flow.stageEvents[stage].unshift(event);
    switch (event.action) {
      case 'tutor.turn.start':
        flow.stages.received = { status: 'done', label: label.received };
        flow.stages.thinking = { status: 'active', label: label.thinking };
        break;
      case 'tutor.action':
        flow.stages.tools = { status: 'active', label: label.tools };
        break;
      case 'tutor.turn.done': {
        flow.stages.received = { status: 'done', label: label.received };
        flow.stages.thinking = { status: 'done', label: label.thinking };
        // Fallback: when the turn completes, the server summary embeds "· tools: name1, name2"
        // whenever any tool ran. Flip the Tools stage to done so the lane reflects tool use
        // even if no explicit tutor.action event was emitted per tool.
        const toolsMatch =
          typeof event.detail === 'string' ? event.detail.match(/·\s*tools:\s*([^·]+)/i) : null;
        if (flow.stages.tools.status === 'active' || toolsMatch) {
          flow.stages.tools = { status: 'done', label: label.tools };
          if (toolsMatch) flow.stageEvents.tools.unshift(event);
        }
        flow.stages.completed = { status: 'done', label: label.completed };
        break;
      }
      case 'tutor.turn.failed':
        flow.stages.received = { status: 'done', label: label.received };
        flow.stages.thinking = { status: 'failed', label: label.thinking };
        flow.stages.completed = { status: 'failed', label: label.completed };
        break;
      case 'artifact.plan':
      case 'artifact.write.start':
        flow.stages.artifact = { status: 'active', label: label.artifact };
        break;
      case 'artifact.chapter.done':
      case 'artifact.check':
        flow.stages.artifact = { status: 'active', label: label.artifact };
        break;
      case 'artifact.ready':
        flow.stages.artifact = { status: 'done', label: label.artifact };
        break;
      case 'artifact.failed':
        flow.stages.artifact = { status: 'failed', label: label.artifact };
        break;
    }
  }
  // The artifact stage is a late addition: only tutor lanes whose turn actually started a
  // generation carry events for it. Hide the stage otherwise so unrelated turns stay clean.
  for (const flow of by.values()) {
    if (!flow.stageEvents.artifact.length) {
      flow.stages.artifact = { status: 'hidden' as Status, label: label.artifact };
    }
  }
  return [...by.values()];
}

/** The stages an assessment preparation passes through: gathering study context, choosing
 * topics and weaknesses, drafting questions, the full plan being ready, and later grading. */
const ASSESSMENT_STAGES = ['context', 'topics', 'generate', 'ready', 'grade'] as const;
type AssessmentStage = (typeof ASSESSMENT_STAGES)[number];
const assessmentStageIcon: Record<AssessmentStage, React.ComponentType<{ size?: number }>> = {
  context: Search,
  topics: LayoutList,
  generate: Sparkles,
  ready: CircleDot,
  grade: Check,
};
type AssessmentFlow = {
  key: string;
  label: string;
  stages: Record<AssessmentStage, { status: Status; label: string }>;
  stageEvents: Record<AssessmentStage, AgentEvent[]>;
  firstAt: string;
};
const assessmentStageOf: Partial<Record<string, AssessmentStage>> = {
  'assessment.context.sources': 'context',
  'assessment.context.evidence': 'context',
  'assessment.context.quizzes': 'context',
  'assessment.context.flashcards': 'context',
  'assessment.context.strengths': 'context',
  'assessment.context.prior': 'context',
  'assessment.batch.weaknesses': 'topics',
  'assessment.batch.plan': 'topics',
  'assessment.batch.generate': 'generate',
  'assessment.batch.done': 'generate',
  'assessment.batch.failed': 'generate',
  'assessment.plan.complete': 'ready',
  'assessment.grade.start': 'grade',
  'assessment.grade.done': 'grade',
  'assessment.grade.failed': 'grade',
};

/** Groups assessment events into a single lane keyed by their session, since assessment
 * events do not carry a fileId (they span the selected sources together). */
function assessmentFlows(events: AgentEvent[], t: T): AssessmentFlow[] {
  const by = new Map<string, AssessmentFlow>();
  const label: Record<AssessmentStage, string> = {
    context: (t as Record<string, string>).agentAssessmentStage_context || 'Context',
    topics: (t as Record<string, string>).agentAssessmentStage_topics || 'Topics',
    generate: (t as Record<string, string>).agentAssessmentStage_generate || 'Questions',
    ready: (t as Record<string, string>).agentAssessmentStage_ready || 'Ready',
    grade: (t as Record<string, string>).agentAssessmentStage_grade || 'Grade',
  };
  const ensure = (event: AgentEvent): AssessmentFlow | null => {
    if (event.tool !== 'assessment') return null;
    const key = 'assessment';
    let flow = by.get(key);
    if (!flow) {
      flow = {
        key,
        label: (t as Record<string, string>).agentAssessmentLabel || 'Review test',
        stages: Object.fromEntries(
          ASSESSMENT_STAGES.map((stage) => [
            stage,
            { status: 'pending' as Status, label: label[stage] },
          ]),
        ) as AssessmentFlow['stages'],
        stageEvents: Object.fromEntries(
          ASSESSMENT_STAGES.map((stage) => [stage, [] as AgentEvent[]]),
        ) as AssessmentFlow['stageEvents'],
        firstAt: event.at,
      };
      by.set(key, flow);
    }
    if (event.at < flow.firstAt) flow.firstAt = event.at;
    return flow;
  };
  for (const event of [...events].reverse()) {
    const flow = ensure(event);
    if (!flow) continue;
    const stage = assessmentStageOf[event.action];
    if (stage) flow.stageEvents[stage].unshift(event);
    switch (event.action) {
      case 'assessment.context.sources':
      case 'assessment.context.evidence':
      case 'assessment.context.quizzes':
      case 'assessment.context.flashcards':
      case 'assessment.context.strengths':
      case 'assessment.context.prior':
        flow.stages.context = { status: 'active', label: label.context };
        break;
      case 'assessment.batch.weaknesses':
        flow.stages.context = { status: 'done', label: label.context };
        flow.stages.topics = { status: 'active', label: label.topics };
        break;
      case 'assessment.batch.plan':
        flow.stages.topics = { status: 'active', label: label.topics };
        break;
      case 'assessment.batch.generate':
        flow.stages.topics = { status: 'done', label: label.topics };
        flow.stages.generate = { status: 'active', label: label.generate };
        break;
      case 'assessment.batch.done':
        flow.stages.generate = { status: 'active', label: label.generate };
        break;
      case 'assessment.batch.failed':
        flow.stages.generate = { status: 'failed', label: label.generate };
        break;
      case 'assessment.plan.complete':
        flow.stages.context = { status: 'done', label: label.context };
        flow.stages.topics = { status: 'done', label: label.topics };
        flow.stages.generate = { status: 'done', label: label.generate };
        flow.stages.ready = { status: 'done', label: label.ready };
        break;
      case 'assessment.grade.start':
        flow.stages.grade = { status: 'active', label: label.grade };
        break;
      case 'assessment.grade.done':
        flow.stages.grade = { status: 'done', label: label.grade };
        break;
      case 'assessment.grade.failed':
        flow.stages.grade = { status: 'failed', label: label.grade };
        break;
    }
  }
  return [...by.values()];
}

/** Diagram view: one pipeline per file for preparation, one per conversation for the tutor. */
export function AgentFlow({
  events,
  locale,
  t,
}: {
  events: AgentEvent[];
  locale: 'en' | 'es';
  t: T;
}) {
  const flows = useMemo(() => fileFlows(events, t), [events, t]);
  const tutorRows = useMemo(() => tutorFlows(events, t), [events, t]);
  const assessmentRows = useMemo(() => assessmentFlows(events, t), [events, t]);
  const [selected, setSelected] = useState<Record<string, Stage | null>>({});
  const [tutorSelected, setTutorSelected] = useState<Record<string, TutorStage | null>>({});
  const [assessmentSelected, setAssessmentSelected] = useState<
    Record<string, AssessmentStage | null>
  >({});
  if (!flows.length && !tutorRows.length && !assessmentRows.length) return null;
  // One list across kinds, placed by when each lane's work began: that never changes as a lane
  // progresses, so lanes hold their place, and it is the time each lane header shows.
  const lanes = [
    ...tutorRows.map((flow) => {
      const picked = tutorSelected[flow.conversationId] ?? null;
      return {
        firstAt: flow.firstAt,
        node: (
          <section
            key={`tutor:${flow.conversationId}`}
            className="flow-row flow-row-tutor"
            aria-label={flow.conversationLabel}
          >
            <h3>
              <Sparkles size={13} aria-hidden="true" />
              {(t as Record<string, string>).agentTool_tutor || 'Librarian'}
              <time className="flow-row-stamp" dateTime={flow.firstAt}>
                {laneStamp(flow.firstAt, locale)}
              </time>
            </h3>
            <ol className="flow-stages">
              {TUTOR_STAGES.filter((stage) => flow.stages[stage].status !== 'hidden').map(
                (stage) => {
                  const state = flow.stages[stage];
                  const Icon = tutorStageIcon[stage];
                  const Mark =
                    state.status === 'done'
                      ? Check
                      : state.status === 'active'
                        ? LoaderCircle
                        : state.status === 'failed'
                          ? CircleAlert
                          : null;
                  const empty = !flow.stageEvents[stage].length;
                  return (
                    <li
                      key={stage}
                      className={`flow-stage ${state.status} ${picked === stage ? 'selected' : ''}`}
                    >
                      <button
                        type="button"
                        className="flow-stage-head-button"
                        disabled={empty}
                        aria-pressed={picked === stage}
                        onClick={() =>
                          setTutorSelected((prev) => ({
                            ...prev,
                            [flow.conversationId]:
                              prev[flow.conversationId] === stage ? null : stage,
                          }))
                        }
                      >
                        <div className="flow-stage-head">
                          <Icon size={16} aria-hidden="true" />
                          <span>{state.label}</span>
                        </div>
                        <div
                          className="flow-stage-mark"
                          aria-label={t[`agentStatus_${state.status}` as keyof T] as string}
                        >
                          {Mark && (
                            <Mark size={14} className={state.status === 'active' ? 'spin' : ''} />
                          )}
                        </div>
                      </button>
                    </li>
                  );
                },
              )}
            </ol>
            {picked && flow.stageEvents[picked].length > 0 && (
              <div className="flow-stage-details">
                <header>
                  {(() => {
                    const Icon = tutorStageIcon[picked];
                    return <Icon size={14} aria-hidden="true" />;
                  })()}
                  <strong>{flow.stages[picked].label}</strong>
                  <small>
                    {flow.stageEvents[picked].length}{' '}
                    {flow.stageEvents[picked].length === 1 ? t.agentDetailStep : t.agentDetailSteps}
                  </small>
                </header>
                <ol className="flow-timeline">
                  {flow.stageEvents[picked].map((event) => (
                    <li key={event.id} className="flow-timeline-item">
                      <time
                        className="flow-timeline-time"
                        dateTime={event.at}
                        title={new Date(event.at).toLocaleString(locale)}
                      >
                        {timeLabel(event.at, locale, t.agentJustNow)}
                      </time>
                      <div className="flow-timeline-body">
                        <strong>{event.summary}</strong>
                        {event.model && (
                          <small className="flow-timeline-model">
                            {event.model}
                            {event.reasoningEffort
                              ? ` · ${t.agentEffort}: ${event.reasoningEffort}`
                              : ''}
                          </small>
                        )}
                        {event.elapsedMs !== undefined && (
                          <div className="flow-timeline-metrics">
                            <span>{elapsed(event.elapsedMs)}</span>
                          </div>
                        )}
                        {event.detail && <small className="agent-detail">{event.detail}</small>}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </section>
        ),
      };
    }),
    ...assessmentRows.map((flow) => {
      const picked = assessmentSelected[flow.key] ?? null;
      return {
        firstAt: flow.firstAt,
        node: (
          <section
            key={`assessment:${flow.key}`}
            className="flow-row flow-row-assessment"
            aria-label={flow.label}
          >
            <h3>
              <LayoutList size={13} aria-hidden="true" />
              {(t as Record<string, string>).agentTool_assessment || 'Assessment'} · {flow.label}
              <time className="flow-row-stamp" dateTime={flow.firstAt}>
                {laneStamp(flow.firstAt, locale)}
              </time>
            </h3>
            <ol className="flow-stages">
              {ASSESSMENT_STAGES.map((stage) => {
                const state = flow.stages[stage];
                const Icon = assessmentStageIcon[stage];
                const Mark =
                  state.status === 'done'
                    ? Check
                    : state.status === 'active'
                      ? LoaderCircle
                      : state.status === 'failed'
                        ? CircleAlert
                        : null;
                const empty = !flow.stageEvents[stage].length;
                return (
                  <li
                    key={stage}
                    className={`flow-stage ${state.status} ${picked === stage ? 'selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="flow-stage-head-button"
                      disabled={empty}
                      aria-pressed={picked === stage}
                      onClick={() =>
                        setAssessmentSelected((prev) => ({
                          ...prev,
                          [flow.key]: prev[flow.key] === stage ? null : stage,
                        }))
                      }
                    >
                      <div className="flow-stage-head">
                        <Icon size={16} aria-hidden="true" />
                        <span>{state.label}</span>
                      </div>
                      <div
                        className="flow-stage-mark"
                        aria-label={t[`agentStatus_${state.status}` as keyof T] as string}
                      >
                        {Mark && (
                          <Mark size={14} className={state.status === 'active' ? 'spin' : ''} />
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ol>
            {picked && flow.stageEvents[picked].length > 0 && (
              <div className="flow-stage-details">
                <header>
                  {(() => {
                    const Icon = assessmentStageIcon[picked];
                    return <Icon size={14} aria-hidden="true" />;
                  })()}
                  <strong>{flow.stages[picked].label}</strong>
                  <small>
                    {flow.stageEvents[picked].length}{' '}
                    {flow.stageEvents[picked].length === 1 ? t.agentDetailStep : t.agentDetailSteps}
                  </small>
                </header>
                <ol className="flow-timeline">
                  {flow.stageEvents[picked].map((event) => (
                    <li key={event.id} className="flow-timeline-item">
                      <time
                        className="flow-timeline-time"
                        dateTime={event.at}
                        title={new Date(event.at).toLocaleString(locale)}
                      >
                        {timeLabel(event.at, locale, t.agentJustNow)}
                      </time>
                      <div className="flow-timeline-body">
                        <strong>{event.summary}</strong>
                        {event.model && (
                          <small className="flow-timeline-model">
                            {event.model}
                            {event.reasoningEffort
                              ? ` · ${t.agentEffort}: ${event.reasoningEffort}`
                              : ''}
                          </small>
                        )}
                        {event.elapsedMs !== undefined && (
                          <div className="flow-timeline-metrics">
                            <span>{elapsed(event.elapsedMs)}</span>
                          </div>
                        )}
                        {event.detail && <small className="agent-detail">{event.detail}</small>}
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </section>
        ),
      };
    }),
    ...flows.map((flow) => {
      const picked = selected[flow.fileId] ?? null;
      return {
        firstAt: flow.firstAt,
        node: (
          <section key={flow.fileId} className="flow-row" aria-label={flow.fileName}>
            <h3>
              {flow.fileName}
              <time className="flow-row-stamp" dateTime={flow.firstAt}>
                {laneStamp(flow.firstAt, locale)}
              </time>
            </h3>
            <ol className="flow-stages">
              {flow.order.map((stage) => (
                <StageCard
                  key={stage}
                  stage={stage}
                  state={flow.stages[stage]}
                  events={flow.stageEvents[stage]}
                  selected={picked === stage}
                  select={() =>
                    setSelected((prev) => ({
                      ...prev,
                      [flow.fileId]: prev[flow.fileId] === stage ? null : stage,
                    }))
                  }
                  t={t}
                />
              ))}
            </ol>
            {picked && (
              <StageDetails
                stage={picked}
                events={flow.stageEvents[picked]}
                locale={locale}
                t={t}
              />
            )}
          </section>
        ),
      };
    }),
  ].sort((a, b) => b.firstAt.localeCompare(a.firstAt));
  return <div className="agent-flows">{lanes.map((lane) => lane.node)}</div>;
}
