/**
 * 本文件负责 agent feature 的运行结果与用量汇总。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type {
  AgentRunDiagnostics,
  AgentRunResult,
  AgentTurnDiagnostics,
  AgentUsage,
  QueueDrainDiagnostic,
  MessageCompactionReport,
} from './contracts.js';
import type { AgentMessage, ModelInputDiagnostics } from './model.js';
import type { LoopStopReason, RunState } from './run-state.js';

/**
 * 运行结果与诊断信息的装配。
 *
 * 回合循环结束后，把 `RunState` 中的状态收拢成对外的
 * {@link AgentRunResult} 与 {@link AgentRunDiagnostics}：
 * - 诊断：逐回合诊断、队列排空记录、待办计数、最后一轮模型输入、压缩报告等；
 * - 结果：最终文本/消息/usage、由内部停止原因映射出的 `finishReason`、
 * 工具调用列表与待办快照；
 * - finishReason 映射：把内核内部的 {@link LoopStopReason} 翻译成对外语义。
 *
 * 装配整段运行的诊断信息。
 *
 * 汇总逐回合诊断、队列排空记录与待办计数；仅在存在时附带最后一轮的模型
 * 输入诊断与恢复来源标记；turn 和 compaction 始终返回完整快照。
 *
 * Args:
 * - `options`: 仅作用于 `createRunDiagnostics` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `createRunDiagnostics` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent Agent engine `result` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createRunDiagnostics(options: {
  readonly run: RunState;
  readonly turns: readonly AgentTurnDiagnostics[];
  readonly compactions: readonly MessageCompactionReport[];
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
    compactions: [...options.compactions],
  };
}

/**
 * 装配对外的运行结果 {@link AgentRunResult}。
 *
 * 文本取自最终模型响应；只有在模型调用前被中断的 run 才返回空文本。usage 在累计值之上把当前 run 实际发生的
 * 工具调用数补加进 `toolCalls`；`finishReason` 由内部停止原因映射而来；
 * 同时附带消息快照、工具调用列表、待办快照与诊断/元数据。
 *
 * Args:
 * - `options`: 仅作用于 `createRunResult` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `createRunResult` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent Agent engine `result` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createRunResult(options: {
  readonly run: RunState;
  readonly diagnostics: AgentRunDiagnostics;
  readonly newMessages: ReadonlyArray<AgentMessage>;
}): AgentRunResult {
  const response = options.run.finalResponse;
  const text = resolveRunText(options.run);
  const finishReason = finishReasonForStop(options.run.stopReason, options.run);
  // 把当前 run 记录的工具调用条数并入累计 usage。
  const usage = {
    ...options.run.usage,
    toolCalls: options.run.usage.toolCalls + options.run.toolCalls.length,
  };
  return {
    id: options.run.runId,
    text,
    output: text,
    messages: [...options.run.state.messages],
    newMessages: [...options.newMessages],
    usage,
    finishReason,
    toolCalls: [...options.run.toolCalls],
    pending: options.run.runControl.deferredQueue.snapshot(),
    diagnostics: options.diagnostics,
    compactions: [...options.diagnostics.compactions],
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
 * 未进入模型调用的回合不生成伪造诊断，调用方通过字段缺失识别该状态。
 *
 * Args:
 * - `options`: 仅作用于 `createTurnDiagnostics` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `createTurnDiagnostics` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent Agent engine `result` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
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
    ...(options.modelInput === undefined
      ? {}
      : { modelInput: options.modelInput }),
    queueDrains: [...options.queueDrains],
    finishReason: options.finishReason,
    newMessageCount: options.newMessageCount,
  };
}

/**
 * 把内核内部停止原因映射成对外的 `finishReason`。
 *
 * 自然结束→`stop`，到达回合上限→`length`，等待审批→`approval-required`，
 * 被中断→`interrupted`，无进展→`no-progress`；错误终止保留已经收到的模型
 * finish reason，没有模型响应时返回 `error`。
 *
 * Args:
 * - `stopReason`: 可观察的终止或拒绝原因；会随失败状态向上游传播。
 * - `run`: 当前 run 的终态；错误终止时用于读取已经完成的模型响应。
 *
 * Returns:
 * - 返回 `finishReasonForStop` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function finishReasonForStop(
  stopReason: LoopStopReason,
  run: RunState,
): AgentRunResult['finishReason'] {
  switch (stopReason) {
    case 'natural-completed':
      return 'stop';
    case 'max-turns':
      return 'length';
    case 'waiting-approval':
      return 'approval-required';
    case 'waiting-tool-result':
      return 'tool-result-required';
    case 'interrupted':
      return 'interrupted';
    case 'no-progress':
      return 'no-progress';
    case 'error':
      return run.finalResponse === undefined
        ? 'error'
        : run.finalResponse.finishReason;
    default:
      stopReason satisfies never;
      throw new Error(`Unhandled loop stop reason: ${String(stopReason)}`);
  }
}

/**
 * 读取完成结果允许暴露的最终文本，并校验 stop reason 与模型响应的一致性。
 *
 * Args:
 * - `run`: 已停止且即将生成公开结果的 run；函数只读取其终止原因和最终响应。
 *
 * Returns:
 * - 返回最终模型文本；模型调用前被中断时返回显式空字符串。
 *
 * Throws:
 * - 非中断终态缺少最终模型响应时直接抛错。
 */
function resolveRunText(run: RunState): string {
  if (run.finalResponse !== undefined) {
    return run.finalResponse.text;
  }
  if (run.stopReason === 'interrupted') {
    return '';
  }
  throw new Error(
    `Run ${run.runId} stopped as ${run.stopReason} without a final model response.`,
  );
}

/**
 * 构造 产品 Agent Agent engine `result` 模块 中的 `createEmptyUsage` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回 `createEmptyUsage` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent Agent engine `result` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createEmptyUsage(): AgentUsage {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
  };
}

/**
 * 按 产品 Agent Agent engine `result` 模块 的一致性约束执行 `addUsage` 状态变更。
 *
 * Args:
 * - `left`: `addUsage` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `right`: `addUsage` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `addUsage` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function addUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
  return {
    requests: left.requests + right.requests,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    toolCalls: left.toolCalls + right.toolCalls,
  };
}

/**
 * 解析 AI SDK usage 边界。
 *
 * Args:
 * - `usage`: AI SDK 返回的未知 usage 对象。
 *
 * Returns:
 * - 返回 engine 统一的非负计数。
 *
 * Throws:
 * - 当 usage 或 token 字段形状非法时直接抛错。
 */
export function mapAiSdkUsage(usage: unknown): AgentUsage {
  if (typeof usage !== 'object' || usage === null) {
    throw new Error('AI SDK usage must be an object.');
  }
  const inputTokens = Reflect.get(usage, 'inputTokens');
  const outputTokens = Reflect.get(usage, 'outputTokens');
  const details = Reflect.get(usage, 'inputTokenDetails');
  if (typeof details !== 'object' || details === null) {
    throw new Error('AI SDK usage.inputTokenDetails must be an object.');
  }
  return {
    requests: 1,
    inputTokens: optionalTokenCount(inputTokens, 'inputTokens'),
    outputTokens: optionalTokenCount(outputTokens, 'outputTokens'),
    cacheReadTokens: optionalTokenCount(
      Reflect.get(details, 'cacheReadTokens'),
      'inputTokenDetails.cacheReadTokens',
    ),
    cacheWriteTokens: optionalTokenCount(
      Reflect.get(details, 'cacheWriteTokens'),
      'inputTokenDetails.cacheWriteTokens',
    ),
    toolCalls: 0,
  };
}

function optionalTokenCount(value: unknown, field: string): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`AI SDK usage.${field} must be a non-negative number.`);
  }
  return value;
}
