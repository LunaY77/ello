import type {
  AgentRunDiagnostics,
  AgentRunResult,
  AgentTurnDiagnostics,
  ModelInputDiagnostics,
  QueueDrainDiagnostic,
  SessionCompactionReport,
} from '../public/types.js';

import type { LoopStopReason, RunSession } from './run-session.js';

export function createRunDiagnostics(options: {
  readonly run: RunSession;
  readonly turns: readonly AgentTurnDiagnostics[];
  readonly compactions: readonly SessionCompactionReport[];
}): AgentRunDiagnostics {
  const lastModelInput = options.turns.at(-1)?.modelInput;
  return {
    turns: [...options.turns],
    queueDrains: [...options.run.state.queueDiagnostics],
    pendingCount: options.run.runControl.deferredQueue.size,
    ...(lastModelInput !== undefined ? { modelInput: lastModelInput } : {}),
    ...(options.run.options.resume !== undefined
      ? { resumeSource: 'options.resume' }
      : {}),
    ...(options.compactions.length > 0
      ? { compactions: [...options.compactions] }
      : {}),
  };
}

export function createRunResult(options: {
  readonly run: RunSession;
  readonly diagnostics: AgentRunDiagnostics;
}): AgentRunResult {
  const response = options.run.finalResponse;
  const finishReason = finishReasonForStop(options.run.stopReason, options.run);
  const usage = {
    ...options.run.usage,
    toolCalls: options.run.usage.toolCalls + options.run.toolCalls.length,
  };
  return {
    id: options.run.runId,
    text: response?.text ?? '',
    output: response?.text ?? '',
    messages: [...options.run.state.messages],
    usage,
    finishReason,
    toolCalls: [...options.run.toolCalls],
    pending: options.run.runControl.deferredQueue.snapshot(),
    diagnostics: options.diagnostics,
    metadata: {
      ...options.run.metadata,
      ...(response !== undefined ? { provider: response.provider } : {}),
      diagnostics: options.diagnostics,
    },
  };
}

export function createTurnDiagnostics(options: {
  readonly turn: number;
  readonly modelInput?: ModelInputDiagnostics;
  readonly queueDrains: readonly QueueDrainDiagnostic[];
  readonly finishReason: AgentRunResult['finishReason'];
  readonly newMessageCount: number;
}): AgentTurnDiagnostics {
  return {
    turn: options.turn,
    modelInput: options.modelInput ?? emptyModelInputDiagnostics(),
    queueDrains: [...options.queueDrains],
    finishReason: options.finishReason,
    newMessageCount: options.newMessageCount,
  };
}

export function finishReasonForStop(
  stopReason: LoopStopReason,
  run?: RunSession,
): AgentRunResult['finishReason'] {
  if (stopReason === 'natural-completed') {
    return 'stop';
  }
  if (stopReason === 'max-turns') {
    return 'length';
  }
  if (stopReason === 'waiting-approval') {
    return 'approval-required';
  }
  if (stopReason === 'interrupted') {
    return 'interrupted';
  }
  if (stopReason === 'no-progress') {
    return 'no-progress';
  }
  return run?.finalResponse?.finishReason ?? 'error';
}

function emptyModelInputDiagnostics(): ModelInputDiagnostics {
  return {
    systemSections: 0,
    messageCount: 0,
    hasProviderOptions: false,
    appliedMessageTransforms: [],
  };
}
