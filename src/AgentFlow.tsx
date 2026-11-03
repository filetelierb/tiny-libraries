import { useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  CircleAlert,
  Film,
  FilePlus,
  Headphones,
  LayoutList,
  LoaderCircle,
  Clock,
  Languages,
  CircleDot,
  SquareStack,
} from 'lucide-react';
import type { AgentEvent } from '../shared/agent-events';
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
type Status = 'pending' | 'waiting' | 'active' | 'done' | 'failed';

function elapsed(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60000),
    seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}
const stageIcon: Record<Stage, React.ComponentType<{ size?: number }>> = {
  upload: FilePlus,
  queued: Clock,
  read: Film,
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
  stages: Record<
    Stage,
    { status: Status; label: string; progress?: { current: number; total: number } }
  >;
  /** The events that happened at each stage, newest first, so a stage can be expanded. */
  stageEvents: Record<Stage, AgentEvent[]>;
  lastAt: string;
};
const stageOf: Partial<Record<string, Stage>> = {
  'library.upload': 'upload',
  'preparation.queued': 'queued',
  'normalize.start': 'read',
  'normalize.done': 'read',
  'transcribe.chunk': 'transcribe',
  'translate.done': 'translate',
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
    let flow = files.get(event.fileId);
    if (!flow) {
      flow = {
        fileId: event.fileId,
        fileName: event.fileName || event.fileId,
        stages: Object.fromEntries(
          STAGES.map((stage) => [
            stage,
            { status: 'pending' as Status, label: t[`agentStage_${stage}` as keyof T] as string },
          ]),
        ) as FileFlow['stages'],
        stageEvents: Object.fromEntries(
          STAGES.map((stage) => [stage, [] as AgentEvent[]]),
        ) as FileFlow['stageEvents'],
        lastAt: event.at,
      };
      files.set(event.fileId, flow);
    }
    if (event.at > flow.lastAt) flow.lastAt = event.at;
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
      case 'translate.done':
        done('translate', t.agentStage_translate);
        break;
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
    const anyActive = STAGES.some((stage) => flow.stages[stage].status === 'active');
    if (anyActive) continue;
    let last = -1;
    for (let i = 0; i < STAGES.length; i++) if (flow.stages[STAGES[i]].status === 'done') last = i;
    const next = STAGES[last + 1];
    if (next && flow.stages[next].status === 'pending') flow.stages[next].status = 'waiting';
  }
  return [...files.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

function StageCard({
  stage,
  state,
  events,
  expanded,
  toggle,
  t,
}: {
  stage: Stage;
  state: FileFlow['stages'][Stage];
  events: AgentEvent[];
  expanded: boolean;
  toggle: () => void;
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
    <li className={`flow-stage ${state.status} ${expanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className="flow-stage-head-button"
        onClick={toggle}
        disabled={empty}
        aria-expanded={expanded}
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
      {expanded && events.length > 0 && (
        <ul className="flow-stage-events">
          {events.map((event) => (
            <li key={event.id}>
              <strong>{event.summary}</strong>
              <small>
                {event.model ? `${event.model} · ` : ''}
                {event.usage?.input !== undefined ? `${event.usage.input} in · ` : ''}
                {event.usage?.output !== undefined ? `${event.usage.output} out · ` : ''}
                {event.usage?.audioSeconds !== undefined
                  ? `${Math.round(event.usage.audioSeconds)} s audio · `
                  : ''}
                {event.elapsedMs !== undefined ? `${elapsed(event.elapsedMs)} · ` : ''}
                {new Date(event.at).toLocaleTimeString()}
              </small>
              {event.detail && <small className="agent-detail">{event.detail}</small>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** Diagram view: one pipeline per file, stage cards connected left to right. */
export function AgentFlow({ events, t }: { events: AgentEvent[]; t: T }) {
  const flows = useMemo(() => fileFlows(events, t), [events, t]);
  const [expanded, setExpanded] = useState<Record<string, Stage | null>>({});
  if (!flows.length) return null;
  return (
    <div className="agent-flows">
      {flows.map((flow) => (
        <section key={flow.fileId} className="flow-row" aria-label={flow.fileName}>
          <h3>{flow.fileName}</h3>
          <ol className="flow-stages">
            {STAGES.map((stage) => (
              <StageCard
                key={stage}
                stage={stage}
                state={flow.stages[stage]}
                events={flow.stageEvents[stage]}
                expanded={expanded[flow.fileId] === stage}
                toggle={() =>
                  setExpanded((prev) => ({
                    ...prev,
                    [flow.fileId]: prev[flow.fileId] === stage ? null : stage,
                  }))
                }
                t={t}
              />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
