import type { AgentInput, AgentMessage } from '../public/types.js';

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
export function normalizeInput(input: AgentInput): AgentMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (Array.isArray(input)) {
    return [...input];
  }
  if (input.messages !== undefined) {
    return [...input.messages];
  }
  if (input.prompt !== undefined) {
    return [{ role: 'user', content: input.prompt }];
  }
  return [];
}

/**
 * 比对前后两份消息列表，抽取本轮新增的消息。
 *
 * 正常情况下 `after` 是在 `before` 后追加得到的：若 `after` 不短于
 * `before` 且 `before` 是 `after` 的前缀，则直接返回追加的尾段。
 * 当前缀不匹配（历史被改写/压缩等）时退化处理：返回 `after` 的最后一条，
 * 空列表则返回空数组。
 */
export function diffNewMessages(
  before: readonly AgentMessage[],
  after: readonly AgentMessage[],
): AgentMessage[] {
  if (after.length >= before.length) {
    // 逐条校验 before 是否为 after 的前缀。
    const prefixMatches = before.every((message, index) =>
      messagesEqual(message, after[index]),
    );
    if (prefixMatches) {
      return after.slice(before.length);
    }
  }
  // 前缀不匹配的兜底：只认最后一条为新增。
  return after.length === 0 ? [] : after.slice(-1);
}

/** 判断两条消息是否等价（角色相同且稳定化内容一致）。 */
function messagesEqual(left: AgentMessage, right: AgentMessage | undefined): boolean {
  if (right === undefined || left.role !== right.role) {
    return false;
  }
  return stableContent(left) === stableContent(right);
}

/** 把消息内容稳定化为可比较字符串（字符串原样，其余 JSON 序列化）。 */
function stableContent(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content;
  }
  return JSON.stringify(content ?? null);
}
