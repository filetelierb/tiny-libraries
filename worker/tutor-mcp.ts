import { createTutorAgent, type TutorAgentCheckpoint, type TutorAgentInput } from './tutor-agent';
import type { TutorJournal } from './tutor-journal';
import { ControlCheckpoint, turnWriters, type TutorRunnerServices } from './tutor-runner';

type Rpc = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { protocolVersion?: string; name?: unknown; arguments?: unknown };
};
const stopped = 'This reply is no longer running. Stop and write nothing more.';

/** The reply an agent host is serving, while that same model step is still running. */
async function serving(journal: TutorJournal, providerId: string) {
  const record = await journal.active();
  if (
    !record ||
    record.phase !== 'model' ||
    record.providerId !== providerId ||
    record.stopRequested ||
    record.steering.length ||
    !record.initialObject ||
    !record.checkpointObject
  )
    return null;
  const agent = await createTutorAgent(
    await journal.objects.get<TutorAgentInput>(record.initialObject),
    await journal.objects.get<TutorAgentCheckpoint>(record.checkpointObject),
  );
  return { record, agent };
}

/**
 * The tutor's tools as a minimal MCP server for one model step. Each call runs against the
 * reply's saved checkpoint, so citations are checked against what the agent really read and
 * writes stay guarded exactly as in the direct engine.
 */
export async function tutorMcp(
  journal: TutorJournal,
  services: TutorRunnerServices,
  providerId: string,
  message: Rpc,
) {
  const answer = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
  const failure = (code: number, text: string) => ({
    jsonrpc: '2.0',
    id: message.id ?? null,
    error: { code, message: text },
  });
  if (message.id === undefined) return null;
  switch (message.method) {
    case 'initialize':
      return answer({
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'library', version: '0.1.0' },
      });
    case 'ping':
      return answer({});
    case 'tools/list': {
      const current = await serving(journal, providerId);
      return answer({ tools: current ? current.agent.mcpTools() : [] });
    }
    case 'tools/call': {
      const text = (value: unknown, isError = false) =>
        answer({ content: [{ type: 'text', text: JSON.stringify(value) }], isError });
      const current = await serving(journal, providerId);
      if (!current) return text({ error: stopped }, true);
      const { record, agent } = current;
      const name = String(message.params?.name || '');
      let result;
      try {
        result = await agent.runTool(
          name,
          message.params?.arguments,
          ...turnWriters(journal, services, record, await journal.intent(record)),
        );
      } catch (error) {
        if (error instanceof ControlCheckpoint) return text({ error: stopped }, true);
        throw error;
      }
      const snapshot = agent.snapshot();
      const saved = await journal.progress(record, {
        checkpointObject: await journal.objects.put(snapshot),
        toolNames: snapshot.used,
      });
      if (!saved) return text({ error: stopped }, true);
      const output = result.output as { error?: unknown } | null;
      return text(output, !!output && typeof output === 'object' && 'error' in output);
    }
    default:
      return failure(-32601, 'Method not found');
  }
}
