import { useMemo } from 'react';
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
} from 'lucide-react';
import type { AgentEvent } from '../shared/agent-events';
import type { T } from './i18n';

/** The stages a file goes through from upload to a ready study guide. */
const STAGES = ['upload', 'queued', 'read', 'transcribe', 'translate', 'synthesize', 'glossary', 'done'] as const;
type Stage = (typeof STAGES)[number];
type Status = 'pending' | 'waiting' | 'active' | 'done' | 'failed';

const stageIcon: Record<Stage, React.ComponentType<{ size?: number }>> = {
  upload: FilePlus,
  queued: Clock,
  read: Film,
  transcribe: Headphones,
  translate: Languages,
  synthesize: LayoutList,
  glossary: BookOpen,
  done: CircleDot,
};

type FileFlow = {
  fileId: string;
  fileName: string;
  stages: Record<Stage, { status: Status; label: string; progress?: { current: number; total: number } }>;
  lastAt: string;
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
          STAGES.map((stage) => [stage, { status: 'pending' as Status, label: t[`agentStage_${stage}` as keyof T] as string }]),
        ) as FileFlow['stages'],
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
    const open = (stage: Stage, label?: string, progress?: FileFlow['stages'][Stage]['progress']) => {
      flow.stages[stage] = { ...flow.stages[stage], status: 'active', ...(label ? { label } : {}), ...(progress ? { progress } : {}) };
    };
    const done = (stage: Stage, label?: string) => {
      flow.stages[stage] = { ...flow.stages[stage], status: 'done', ...(label ? { label } : {}) };
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
  t,
}: {
  stage: Stage;
  state: FileFlow['stages'][Stage];
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
  return (
    <li className={`flow-stage ${state.status}`}>
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
    </li>
  );
}

/** Diagram view: one pipeline per file, stage cards connected left to right. */
export function AgentFlow({ events, t }: { events: AgentEvent[]; t: T }) {
  const flows = useMemo(() => fileFlows(events, t), [events, t]);
  if (!flows.length) return null;
  return (
    <div className="agent-flows">
      {flows.map((flow) => (
        <section key={flow.fileId} className="flow-row" aria-label={flow.fileName}>
          <h3>{flow.fileName}</h3>
          <ol className="flow-stages">
            {STAGES.map((stage) => (
              <StageCard key={stage} stage={stage} state={flow.stages[stage]} t={t} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
