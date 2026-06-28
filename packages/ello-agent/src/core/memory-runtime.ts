import type {
  AgentMemoryItem,
  AgentRunDiagnostics,
  AgentRunResult,
  CreateAgentOptions,
} from '../public/types.js';

import type { RunSession } from './run-session.js';

export async function retrieveMemoryForModelInput(
  run: RunSession,
): Promise<readonly AgentMemoryItem[]> {
  const memory = run.config.memory;
  if (memory === undefined) {
    return [];
  }
  const retrievePolicy = memory.retrievePolicy ?? 'once-per-run';
  if (retrievePolicy === 'once-per-turn') {
    return memory.retrieve(run.ctx);
  }
  if (!run.memoryRetrieved) {
    run.memoryCache = await memory.retrieve(run.ctx);
    run.memoryRetrieved = true;
  }
  return run.memoryCache;
}

export async function observeRunCompleted(options: {
  readonly config: CreateAgentOptions;
  readonly run: RunSession;
  readonly result: AgentRunResult;
  readonly diagnostics: AgentRunDiagnostics;
}): Promise<void> {
  await options.config.memory?.observe?.(
    {
      type: 'run.completed',
      result: options.result,
      diagnostics: options.diagnostics,
    },
    options.run.ctx,
  );
}

export async function observeRunFailed(options: {
  readonly config: CreateAgentOptions;
  readonly run: RunSession;
  readonly error: import('../public/types.js').AgentError;
  readonly diagnostics: AgentRunDiagnostics;
}): Promise<void> {
  await options.config.memory?.observe?.(
    {
      type: 'run.failed',
      error: options.error,
      diagnostics: options.diagnostics,
    },
    options.run.ctx,
  );
}
