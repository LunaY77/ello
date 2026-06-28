import { randomUUID } from 'node:crypto';

import type {
  AgentModelRequest,
  AgentModelResponse,
  ModelInput,
} from '../public/types.js';

import type { RunSession } from './run-session.js';

export interface ModelCallResult {
  readonly response?: AgentModelResponse;
  readonly stopReason?: 'interrupted';
}

export async function callModel(
  run: RunSession,
  input: ModelInput,
): Promise<ModelCallResult> {
  if (run.signal.aborted) {
    run.markInterrupted();
    return { stopReason: 'interrupted' };
  }

  const messageId = randomUUID();
  await run.events.emit({
    type: 'message.started',
    messageId,
    role: 'assistant',
  });

  const request = createModelRequest(run, input);
  let finalResponse: AgentModelResponse | null = null;
  try {
    for await (const event of run.modelAdapter.stream(request)) {
      if (event.type === 'text-delta') {
        await run.events.emit({
          type: 'message.delta',
          messageId,
          text: event.text,
        });
      } else {
        finalResponse = event.response;
      }
    }
    if (finalResponse === null) {
      finalResponse = await run.modelAdapter.generate(request);
    }
    return { response: finalResponse };
  } catch (error) {
    if (run.signal.aborted || isAbortError(error)) {
      run.markInterrupted();
      return { stopReason: 'interrupted' };
    }
    throw error;
  }
}

function createModelRequest(
  run: RunSession,
  input: ModelInput,
): AgentModelRequest {
  return {
    runId: run.runId,
    model: run.config.model,
    ...(input.system !== undefined ? { system: input.system } : {}),
    messages: input.messages,
    tools: input.tools,
    ...(input.activeTools !== undefined
      ? { activeTools: input.activeTools }
      : {}),
    ...(input.toolChoice !== undefined ? { toolChoice: input.toolChoice } : {}),
    ...(input.providerOptions !== undefined
      ? { providerOptions: input.providerOptions }
      : {}),
    modelSettings: {
      ...(run.config.modelSettings ?? {}),
      ...(run.options.modelSettings ?? {}),
    },
    signal: run.signal,
  };
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}
