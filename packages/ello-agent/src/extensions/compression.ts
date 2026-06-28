import { trimMessages } from '../core/input-transforms.js';
import type { AgentExtension, AgentMessage } from '../public/types.js';

export interface CreateCompressionExtensionOptions {
  readonly maxMessages?: number;
}

/**
 * 默认消息裁剪扩展。
 *
 * 当前实现是轻量 trim：保留最近 maxMessages 条消息。旧版 summary compact
 * 已删除，后续如果需要摘要压缩，应在这个扩展后面接入 summary model。
 *
 * Args:
 *   options.maxMessages: 保留的最大消息数，默认 40。
 *
 * Returns:
 *   AgentExtension，可传给 createAgent({ extensions })。
 */
export function createCompressionExtension(
  options: CreateCompressionExtensionOptions = {},
): AgentExtension {
  const maxMessages = options.maxMessages ?? 40;
  const trim = trimMessages({ maxMessages });
  return {
    name: 'compression',
    async transformMessages(messages: AgentMessage[], ctx) {
      return [...(await trim(messages, ctx))];
    },
  };
}
