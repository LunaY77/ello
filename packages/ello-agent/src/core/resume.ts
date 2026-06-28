import { normalizeAgentError } from '../public/errors.js';
import type { AgentRunOptions, DeferredRunResults } from '../public/types.js';

import type { RunSession } from './run-session.js';

export async function prepareResume(
  run: RunSession,
  resume: AgentRunOptions['resume'],
): Promise<DeferredRunResults | undefined> {
  if (resume === undefined || resume.deferred === undefined) {
    return resume;
  }
  const toolResults: Record<string, unknown> = {
    ...(resume.toolResults ?? {}),
  };
  for (const item of resume.deferred) {
    if (item.kind !== 'approval') {
      continue;
    }
    const decision = resume.approvals?.[item.toolCallId];
    const approved =
      typeof decision === 'boolean' ? decision : (decision?.approved ?? false);
    if (!approved || toolResults[item.toolCallId] !== undefined) {
      continue;
    }
    const result = await run.toolScheduler.executeApproved(
      {
        id: item.toolCallId,
        name: item.toolName,
        input: item.input,
      },
      {
        onToolStarted: (toolCallId, name, input) =>
          run.events.emit({ type: 'tool.started', toolCallId, name, input }),
        onApprovalRequired: async () => {},
        onToolCompleted: (toolCallId, output) =>
          run.events.emit({ type: 'tool.completed', toolCallId, output }),
        onToolFailed: (toolCallId, error) =>
          run.events.emit({
            type: 'tool.failed',
            toolCallId,
            error: normalizeAgentError(error),
          }),
      },
    );
    toolResults[item.toolCallId] =
      result.error !== undefined
        ? { error: result.error.message }
        : result.output;
  }
  return { ...resume, toolResults };
}
