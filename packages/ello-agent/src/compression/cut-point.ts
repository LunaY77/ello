import type { ModelMessage } from 'ai';

/**
 * Cut-point 选择结果。
 *
 * Args:
 *   firstKeptIndex: 保留区的起始索引, 之前的消息需要摘要。
 *   isSplitTurn: 是否在 turn 中间切割。
 */
export interface CutPointResult {
  firstKeptIndex: number;
  isSplitTurn: boolean;
}

/** 估算单条消息的 token 数, 使用 chars / 4 的启发式。 */
export function estimateTokens(message: ModelMessage): number {
  let totalChars = 0;

  if (message.role === 'user') {
    totalChars += estimateUserContentChars(message.content);
  } else if (message.role === 'assistant') {
    totalChars += estimateAssistantContentChars(message.content);
  } else if (message.role === 'tool') {
    totalChars += estimateToolContentChars(message.content);
  } else if (message.role === 'system') {
    totalChars += message.content.length;
  }

  return Math.max(Math.floor(totalChars / 4), 1);
}

/** 估算消息列表的总 token 数。 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateTokens(message),
    0,
  );
}

/**
 * 从消息列表中找到合适的 cut-point。
 *
 * 保留最近 keepRecentTokens 的原始对话, 只对更早的部分做摘要。
 * 优先在用户 turn 边界切割。
 */
export function findCutPoint(
  messages: ModelMessage[],
  keepRecentTokens = 20_000,
): CutPointResult | null {
  if (messages.length <= 3) {
    return null;
  }

  let cumulative = 0;
  let cutIndex = messages.length;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    cumulative += estimateTokens(messages[i]!);
    if (cumulative >= keepRecentTokens) {
      cutIndex = i + 1;
      break;
    }
  }

  if (cumulative < keepRecentTokens) {
    return null;
  }
  if (cutIndex <= 1 || cutIndex >= messages.length) {
    return null;
  }

  let bestIndex = cutIndex;
  for (let i = cutIndex; i < Math.min(cutIndex + 5, messages.length); i += 1) {
    if (isTurnBoundary(messages, i)) {
      bestIndex = i;
      break;
    }
  }

  return {
    firstKeptIndex: bestIndex,
    isSplitTurn: !isTurnBoundary(messages, bestIndex),
  };
}

function isTurnBoundary(messages: ModelMessage[], index: number): boolean {
  if (index >= messages.length) {
    return true;
  }
  return messages[index]?.role === 'user';
}

function estimateUserContentChars(content: ModelMessage['content']): number {
  if (typeof content === 'string') {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 50;
  }
  return content.reduce((total, part) => {
    if (part.type === 'text') {
      return total + part.text.length;
    }
    return total + 50;
  }, 0);
}

function estimateAssistantContentChars(
  content: ModelMessage['content'],
): number {
  if (typeof content === 'string') {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 50;
  }
  return content.reduce((total, part) => {
    if (part.type === 'text') {
      return total + part.text.length;
    }
    if (part.type === 'tool-call') {
      return total + JSON.stringify(part.input ?? {}).length + 50;
    }
    return total + 50;
  }, 0);
}

function estimateToolContentChars(content: ModelMessage['content']): number {
  if (!Array.isArray(content)) {
    return 50;
  }
  return content.reduce((total, part) => {
    if (part.type !== 'tool-result') {
      return total + 50;
    }
    return total + toolResultOutputToString(part.output).length;
  }, 0);
}

function toolResultOutputToString(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (typeof output !== 'object' || output === null) {
    return String(output ?? '');
  }
  const typed = output as { type?: string; value?: unknown; reason?: unknown };
  if (typeof typed.value === 'string') {
    return typed.value;
  }
  if (typed.value !== undefined) {
    return JSON.stringify(typed.value);
  }
  if (typeof typed.reason === 'string') {
    return typed.reason;
  }
  return JSON.stringify(output);
}
