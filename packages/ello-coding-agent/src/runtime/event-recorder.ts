import type { AgentEventRecorder } from '@ello/agent';

import type { JsonlSessionRepository } from '../session/repository.js';
import { projectToolEvent } from '../tools/event-projection.js';

export function createCodingEventRecorder(
  repository: JsonlSessionRepository,
  tracing?: AgentEventRecorder,
): AgentEventRecorder {
  return {
    async record(event, ctx): Promise<void> {
      if (ctx.sessionId === undefined) {
        throw new Error(`Missing sessionId for recorded run ${ctx.runId}.`);
      }
      switch (event.type) {
        case 'run.started':
          await repository.appendRunMarker(ctx.sessionId, {
            runId: event.runId,
            status: 'started',
          });
          break;
        case 'run.completed':
          await repository.appendRunMarker(ctx.sessionId, {
            runId: event.runId,
            status: 'completed',
            finishReason: event.finishReason,
            usage: event.usage,
          });
          break;
        case 'run.failed':
          await repository.appendRunMarker(ctx.sessionId, {
            runId: ctx.runId,
            status: 'failed',
            error: {
              name: event.error.name,
              message: event.error.message,
            },
          });
          break;
        default:
          break;
      }
      await tracing?.record(projectToolEvent(event), ctx);
    },
    flush: (ctx) => tracing?.flush?.(ctx),
  };
}

export function combineEventRecorders(
  ...recorders: readonly AgentEventRecorder[]
): AgentEventRecorder {
  return {
    async record(event, ctx): Promise<void> {
      for (const recorder of recorders) await recorder.record(event, ctx);
    },
    async flush(ctx): Promise<void> {
      for (const recorder of recorders) await recorder.flush?.(ctx);
    },
  };
}
