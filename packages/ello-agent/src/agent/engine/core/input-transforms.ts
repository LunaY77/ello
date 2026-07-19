import type { AgentMessage, MessageTransform } from '../api/types.js';

import type { RunSession } from './run-session.js';

/**
 * 内置消息变换。
 *
 * 喂给模型前对历史消息做整形，全部实现为 {@link MessageTransform}（消息进、
 * 消息出的纯函数），可按需串联：
 * - `trimMessages`：按条数保留最近 N 条；
 * - `compactMessages`：按 token 预算从头丢弃，直到落入预算内；
 * - `preserveToolCallPairs`：剔除失配的 tool-call / tool-result，避免出现
 *   孤儿调用或孤儿结果导致 provider 报错；
 * - token 估算统一用 `ceil(chars/4)` 的字符启发式。
 * `defaultMessageTransforms` 根据 run 配置装配出默认流水线，并始终以一次
 * 配对修复收尾。
 */

/** {@link trimMessages} 的选项。 */
export interface TrimMessagesOptions {
  /** 保留的最近消息条数上限。 */
  readonly maxMessages: number;
}

/** 构造按条数裁剪的变换：仅保留最近 `maxMessages` 条并修复工具配对。 */
export function trimMessages(options: TrimMessagesOptions): MessageTransform {
  return async (messages) =>
    preserveToolCallPairs(messages.slice(-options.maxMessages));
}

/** {@link compactMessages} 的选项。 */
export interface CompactMessagesOptions {
  /** 输入 token 上限。 */
  readonly maxInputTokens: number;
  /** 为输出预留的 token，实际预算为 `maxInputTokens - reservedOutputTokens`。 */
  readonly reservedOutputTokens?: number;
}

/** 构造按 token 预算压缩的变换：超预算时从头丢弃最旧消息。 */
export function compactMessages(
  options: CompactMessagesOptions,
): MessageTransform {
  if (
    !Number.isSafeInteger(options.maxInputTokens) ||
    options.maxInputTokens < 1
  ) {
    throw new Error('maxInputTokens must be a positive safe integer.');
  }
  const reserved = options.reservedOutputTokens ?? 0;
  if (
    !Number.isSafeInteger(reserved) ||
    reserved < 0 ||
    reserved >= options.maxInputTokens
  ) {
    throw new Error(
      'reservedOutputTokens must be a non-negative safe integer below maxInputTokens.',
    );
  }
  return async (messages) => applyTokenBudget(messages, options);
}

/**
 * 按 run 配置装配默认消息变换流水线。
 *
 * 顺序为：会话窗口裁剪（如配置）→ token 预算压缩（如配置）→ 末尾始终追加
 * 一次工具配对修复，确保最终消息序列不含孤儿 tool-call / tool-result。
 */
export function defaultMessageTransforms(run: RunSession): MessageTransform[] {
  const transforms: MessageTransform[] = [];
  if (run.config.sessionWindow !== undefined) {
    transforms.push(trimMessages(run.config.sessionWindow));
  }
  if (run.config.modelInputBudget !== undefined) {
    transforms.push(compactMessages(run.config.modelInputBudget));
  }
  // 收尾固定做一次配对修复，兜住前序裁剪/压缩切碎的工具对。
  transforms.push(async (messages) => preserveToolCallPairs(messages));
  return transforms;
}

/** 估算整段消息的 token 数（逐条累加文本估算值）。 */
export function estimateMessagesTokens(
  messages: readonly AgentMessage[],
): number {
  return messages.reduce(
    (sum, message) => sum + estimateTextTokens(messageText(message)),
    0,
  );
}

/** 估算一段文本的 token 数：`ceil(chars / 4)` 的粗略启发式。 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** 从头丢弃最旧消息直到落入 token 预算内，最后修复工具配对。 */
function applyTokenBudget(
  messages: readonly AgentMessage[],
  options: CompactMessagesOptions,
): readonly AgentMessage[] {
  // 可用预算 = 输入上限 - 预留输出，下限夹到 0。
  const available = Math.max(
    0,
    options.maxInputTokens - (options.reservedOutputTokens ?? 0),
  );
  const kept = [...messages];
  // 超预算就持续丢弃最旧的一条，直到估算落入预算或丢空。
  while (kept.length > 0 && estimateMessagesTokens(kept) > available) {
    kept.shift();
  }
  return preserveToolCallPairs(kept);
}

/**
 * 剔除失配的工具调用对，避免孤儿 tool-call / tool-result。
 *
 * 先扫一遍收集所有 tool-call 与 tool-result 的 id；再过滤：
 * - 助手消息：含 tool-call 时，至少有一个 id 能在结果集中找到才保留；
 * - 工具消息：含 tool-result 时，至少有一个 id 能在调用集中找到才保留；
 * - 不含工具 part 的普通消息一律保留。
 * 裁剪/压缩可能切断成对的调用与结果，此步把残缺的一侧清掉。
 */
export function preserveToolCallPairs(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  // 第一遍：分别收集所有调用 id 与结果 id。
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const id of readPartIds(message, 'tool-call')) {
        toolCallIds.add(id);
      }
    }
    if (message.role === 'tool') {
      for (const id of readPartIds(message, 'tool-result')) {
        toolResultIds.add(id);
      }
    }
  }
  // 第二遍：丢掉找不到对侧的孤儿调用/结果。
  return messages.filter((message) => {
    if (message.role === 'assistant') {
      const ids = readPartIds(message, 'tool-call');
      return ids.length === 0 || ids.some((id) => toolResultIds.has(id));
    }
    if (message.role === 'tool') {
      const ids = readPartIds(message, 'tool-result');
      return ids.length === 0 || ids.some((id) => toolCallIds.has(id));
    }
    return true;
  });
}

/** 从消息内容中读取指定类型 part 的工具 id（兼容两种 id 字段名）。 */
function readPartIds(message: AgentMessage, type: string): string[] {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return [];
  }
  return content.flatMap((part) => {
    if (typeof part !== 'object' || part === null) {
      return [];
    }
    const record = part as Record<string, unknown>;
    if (record.type !== type) {
      return [];
    }
    // 兼容 toolCallId 与 toolInvocationId 两种命名。
    const id = record.toolCallId ?? record.toolInvocationId;
    return typeof id === 'string' ? [id] : [];
  });
}

/** 取消息正文文本：字符串原样，其余 JSON 序列化（用于 token 估算）。 */
function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}
