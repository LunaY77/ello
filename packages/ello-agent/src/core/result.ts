import type {
  AgentRunDiagnostics,
  AgentRunResult,
  AgentTurnDiagnostics,
  ModelInputDiagnostics,
  QueueDrainDiagnostic,
  SessionCompactionReport,
} from '../public/types.js';

import {
  fingerprintMessagePrefix,
  fingerprintSystem,
  fingerprintToolset,
} from './fingerprints.js';
import type { LoopStopReason, RunSession } from './run-session.js';

/**
 * 运行结果与诊断信息的装配。
 *
 * 回合循环结束后，把散落在 {@link RunSession} 中的状态收拢成对外的
 * {@link AgentRunResult} 与 {@link AgentRunDiagnostics}：
 * - 诊断：逐回合诊断、队列排空记录、待办计数、最后一轮模型输入、压缩报告等；
 * - 结果：最终文本/消息/usage、由内部停止原因映射出的 `finishReason`、
 *   工具调用列表与待办快照；
 * - finishReason 映射：把内核内部的 {@link LoopStopReason} 翻译成对外语义。
 */

/**
 * 装配整段运行的诊断信息。
 *
 * 汇总逐回合诊断、队列排空记录与待办计数；仅在存在时附带最后一轮的模型
 * 输入诊断、恢复来源标记与压缩报告，避免输出冗余字段。
 */
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

/**
 * 装配对外的运行结果 {@link AgentRunResult}。
 *
 * 文本取自最终响应（缺省为空串）；usage 在累计值之上把本次运行实际发生的
 * 工具调用数补加进 `toolCalls`；`finishReason` 由内部停止原因映射而来；
 * 同时附带消息快照、工具调用列表、待办快照与诊断/元数据。
 */
export function createRunResult(options: {
  readonly run: RunSession;
  readonly diagnostics: AgentRunDiagnostics;
}): AgentRunResult {
  const response = options.run.finalResponse;
  const finishReason = finishReasonForStop(options.run.stopReason, options.run);
  // 把本次运行记录的工具调用条数并入累计 usage。
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

/**
 * 装配单个回合的诊断信息。
 *
 * 缺省模型输入诊断时填充一份空诊断占位，保证字段稳定存在。
 */
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

/**
 * 把内核内部停止原因映射成对外的 `finishReason`。
 *
 * 自然结束→`stop`，到达回合上限→`length`，等待审批→`approval-required`，
 * 被中断→`interrupted`，无进展→`no-progress`；其余情况退回最终响应自带的
 * finishReason，仍无则记为 `error`。
 */
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
  if (stopReason === 'waiting-tool-result') {
    return 'tool-result-required';
  }
  if (stopReason === 'interrupted') {
    return 'interrupted';
  }
  if (stopReason === 'no-progress') {
    return 'no-progress';
  }
  return run?.finalResponse?.finishReason ?? 'error';
}

/** 空的模型输入诊断占位（全零/全空）。 */
function emptyModelInputDiagnostics(): ModelInputDiagnostics {
  return {
    systemSections: 0,
    messageCount: 0,
    hasProviderOptions: false,
    appliedMessageTransforms: [],
    systemFingerprint: fingerprintSystem(undefined),
    toolsetFingerprint: fingerprintToolset({}),
    messagePrefixFingerprint: fingerprintMessagePrefix([]),
    compactionBoundary: false,
  };
}
