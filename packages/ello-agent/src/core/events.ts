import type { AgentStreamEvent } from '../public/events.js';
import type {
  AgentExtension,
  AgentObserver,
  AgentRunContext,
  AgentSessionExtension,
  AgentToolCall,
  CreateAgentOptions,
} from '../public/types.js';

import type { AgentEventStream } from './stream.js';

export class AgentEventDispatcher {
  private readonly observerToolCalls = new Map<string, AgentToolCall>();

  constructor(
    private readonly config: CreateAgentOptions,
    private readonly extensions: readonly AgentExtension[],
    private readonly stream: AgentEventStream,
    private readonly ctx: AgentRunContext,
  ) {}

  async emit(event: AgentStreamEvent): Promise<void> {
    this.ctx.trace.events.push(event);
    this.stream.emit(event);
    await this.emitObserverEvent(event);
    if (this.ctx.sessionId !== undefined) {
      await this.config.session?.appendEvent?.(this.ctx.sessionId, event);
    }
    for (const extension of this.extensions) {
      await extension.onEvent?.(event, this.ctx);
    }
  }

  private async emitObserverEvent(event: AgentStreamEvent): Promise<void> {
    for (const observer of this.config.observers ?? []) {
      await emitSingleObserverEvent(
        observer,
        event,
        this.ctx,
        this.observerToolCalls,
      );
    }
  }
}

async function emitSingleObserverEvent(
  observer: AgentObserver,
  event: AgentStreamEvent,
  ctx: AgentRunContext,
  toolCalls: Map<string, AgentToolCall>,
): Promise<void> {
  if (event.type === 'run.started') {
    await observer.onRunStarted?.({ runId: event.runId }, ctx);
    return;
  }
  if (event.type === 'turn.started') {
    await observer.onTurnStarted?.(
      { runId: event.runId, turnIndex: event.turnIndex },
      ctx,
    );
    return;
  }
  if (event.type === 'tool.started') {
    const call = {
      id: event.toolCallId,
      name: event.name,
      input: event.input,
    };
    toolCalls.set(event.toolCallId, call);
    await observer.onToolScheduled?.(call, ctx);
    return;
  }
  if (event.type === 'approval.required') {
    await observer.onToolApprovalRequired?.(event.item, ctx);
    return;
  }
  if (event.type === 'tool.completed') {
    const started = toolCalls.get(event.toolCallId);
    const completed = {
      id: event.toolCallId,
      name: started?.name ?? event.toolCallId,
      input: started?.input ?? null,
      output: event.output,
    };
    toolCalls.set(event.toolCallId, completed);
    await observer.onToolCompleted?.(completed, ctx);
    return;
  }
  if (event.type === 'run.completed') {
    await observer.onRunCompleted?.(event.result, ctx);
    return;
  }
  if (event.type === 'run.failed') {
    await observer.onRunFailed?.({ error: event.error }, ctx);
  }
}

export async function closeAgentResources(
  environment: CreateAgentOptions['environment'],
  extensions: readonly AgentExtension[],
): Promise<void> {
  for (const extension of [...extensions].reverse()) {
    await extension.teardown?.();
  }
  await environment?.close?.();
}

export function asSessionExtension(
  extension: AgentExtension,
): AgentSessionExtension {
  return extension as AgentSessionExtension;
}
