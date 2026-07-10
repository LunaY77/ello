import type { AgentEventRecorder } from '@ello/agent';

import type { JsonlSessionRepository } from '../session/repository.js';

export function createCodingEventRecorder(
  repository: JsonlSessionRepository,
): AgentEventRecorder {
  return {
    record: (event, ctx) => {
      if (ctx.sessionId === undefined) {
        throw new Error(`Missing sessionId for recorded run ${ctx.runId}.`);
      }
      switch (event.type) {
        case 'run.started':
          return repository.appendRunMarker(ctx.sessionId, {
            runId: event.runId,
            status: 'started',
          });
        case 'run.completed':
          return repository.appendRunMarker(ctx.sessionId, {
            runId: event.runId,
            status: 'completed',
            finishReason: event.finishReason,
            usage: event.usage,
          });
        case 'run.failed':
          return repository.appendRunMarker(ctx.sessionId, {
            runId: ctx.runId,
            status: 'failed',
            error: {
              name: event.error.name,
              message: event.error.message,
            },
          });
        default:
          return;
      }
    },
  };
}
