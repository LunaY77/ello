/**
 * Engine 消息输入的归一化与严格前缀差分。
 *
 * 结构化输入中的 `messages` 是宿主提供的既有历史，`prompt` 是当前新增用户输入；归一化结果
 * 显式记录历史长度，使最终结果可以准确返回当前 run 新增的消息。响应不是请求前缀时直接失败，避免
 * 把被改写的历史误判成新增数据。
 */
import type { AgentInput } from './contracts.js';
import type { AgentMessage } from './model.js';

/**
 * 构造经过集中审计的 AI SDK AgentMessage。
 *
 * Args:
 * - `message`: 已由调用方确定 role 和 content 语义的内部消息数据。
 *
 * Returns:
 * - 返回可交给 engine 与 AI SDK adapter 的消息。
 */
export function createAgentMessage(message: {
  readonly role: AgentMessage['role'];
  readonly content: unknown;
  readonly [key: string]: unknown;
}): AgentMessage {
  // WHY: AI SDK 未公开可表达动态 tool name 与 tool part 的通用构造输入类型。
  // SCOPE: 只有本工厂把已验证的内部消息桥接为 AgentMessage。
  // SAFETY: 双向类型测试、模型 adapter 测试和 Thread record 解析共同覆盖该边界。
  return message as AgentMessage;
}

/**
 * 消息归一化与增量比对工具。
 *
 * 处理两类消息层面的杂活：
 * - 把对外暴露的多形态 {@link AgentInput}（裸字符串、消息数组、结构化对象）
 *   统一收敛成可直接喂给模型适配器的 {@link AgentMessage} 序列；
 * - 在一轮处理前后对消息列表做前缀比对，抽取出「本轮新增」的消息，
 *   供持久化与事件回放使用。
 */

/**
 * 将对外输入统一为消息序列。
 *
 * 支持三种形态：
 * - 裸字符串 → 包成单条 `user` 消息；
 * - 消息数组 → 浅拷贝原样返回；
 * - 结构化对象 → 优先取 `messages`，否则用 `prompt` 包成 `user` 消息。
 * 都不匹配时返回空数组。
 */
export interface NormalizedAgentInput {
  readonly messages: AgentMessage[];
  readonly historyLength: number;
}

/**
 * 把一次 engine 输入归一化为消息序列和既有历史长度。
 *
 * Args:
 * - `input`: 字符串、一次性消息数组，或同时携带历史与当前 prompt 的结构化输入。
 *
 * Returns:
 * - 返回供首回合入队的完整消息，以及其中由宿主提供的历史消息数量。
 *
 * Throws:
 * - 当结构化输入既没有历史也没有当前 prompt 时直接抛错。
 */
export function normalizeInput(input: AgentInput): NormalizedAgentInput {
  if (typeof input === 'string') {
    return {
      messages: [{ role: 'user', content: input }],
      historyLength: 0,
    };
  }
  if (Array.isArray(input)) {
    return { messages: [...input], historyLength: 0 };
  }
  const history = input.messages === undefined ? [] : [...input.messages];
  if (input.prompt !== undefined) {
    return {
      messages: [...history, { role: 'user', content: input.prompt }],
      historyLength: history.length,
    };
  }
  if (history.length > 0) {
    return { messages: history, historyLength: history.length };
  }
  throw new Error('Structured Agent input requires messages or prompt.');
}
