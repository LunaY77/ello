import type { ModelMessage } from 'ai';

import type { AgentContext } from '../context.js';

const MAX_TOOL_RETURN_CHARS = 500;
const TOOL_RETURN_KEEP_HEAD = 200;
const TOOL_RETURN_KEEP_TAIL = 200;

/** filter 的 RunContext 等价最小结构。 */
export interface HistoryRunContext {
  deps: AgentContext;
}

/** 截断字符串, 保留首尾各 200 字符。 */
export function truncateToolContent(content: string): string {
  if (content.length <= MAX_TOOL_RETURN_CHARS) {
    return content;
  }

  const head = content.slice(0, TOOL_RETURN_KEEP_HEAD);
  const tail = content.slice(-TOOL_RETURN_KEEP_TAIL);
  const truncatedCount =
    content.length - TOOL_RETURN_KEEP_HEAD - TOOL_RETURN_KEEP_TAIL;
  return `${head}\n[... ${truncatedCount} chars truncated ...]\n${tail}`;
}

/** 获取最后一条 assistant 响应的索引。 */
export function getLastResponseIndex(
  messageHistory: ModelMessage[],
): number | null {
  for (let idx = messageHistory.length - 1; idx >= 0; idx -= 1) {
    if (messageHistory[idx]?.role === 'assistant') {
      return idx;
    }
  }
  return null;
}

/** 返回自最后一条 assistant 响应以来的空闲秒数。 */
export function getIdleSeconds(messageHistory: ModelMessage[]): number | null {
  for (let idx = messageHistory.length - 1; idx >= 0; idx -= 1) {
    const message = messageHistory[idx] as
      | (ModelMessage & { timestamp?: Date | string })
      | undefined;
    if (message?.role !== 'assistant') {
      continue;
    }
    if (message.timestamp === undefined) {
      return null;
    }
    const lastTimestamp =
      message.timestamp instanceof Date
        ? message.timestamp
        : new Date(message.timestamp);
    return Math.max(0, (Date.now() - lastTimestamp.getTime()) / 1000);
  }
  return null;
}

/** 截断 trimEnd 之前的大段 tool-result 内容。 */
export function trimToolReturns(
  messageHistory: ModelMessage[],
  trimEnd: number,
): number {
  let trimmedCount = 0;

  for (let idx = 0; idx < trimEnd; idx += 1) {
    const message = messageHistory[idx];
    if (message?.role !== 'tool') {
      continue;
    }

    let modified = false;
    const content = message.content.map((part) => {
      if (part.type !== 'tool-result') {
        return part;
      }
      const contentString = toolResultOutputToString(part.output);
      if (contentString.length <= MAX_TOOL_RETURN_CHARS) {
        return part;
      }

      modified = true;
      trimmedCount += 1;
      return {
        ...part,
        output: {
          type: 'text' as const,
          value: truncateToolContent(contentString),
        },
      };
    });

    if (modified) {
      messageHistory[idx] = { ...message, content };
    }
  }

  return trimmedCount;
}

/**
 * 冷启动时截断旧 tool return 内容。
 *
 * 当空闲时间超过 coldStartTrimSeconds 时, 截断最后一条 assistant 响应
 * 之前的 tool-result 内容。
 */
export function coldStartTrim(
  ctx: HistoryRunContext,
  messageHistory: ModelMessage[],
): ModelMessage[] {
  if (messageHistory.length === 0) {
    return messageHistory;
  }

  const threshold = ctx.deps.modelConfig.coldStartTrimSeconds;
  if (threshold === null || threshold <= 0) {
    return messageHistory;
  }

  const idle = getIdleSeconds(messageHistory);
  if (idle === null || idle < threshold) {
    return messageHistory;
  }

  const lastResponseIndex = getLastResponseIndex(messageHistory);
  trimToolReturns(
    messageHistory,
    lastResponseIndex === null ? messageHistory.length : lastResponseIndex,
  );

  return messageHistory;
}

function toolResultOutputToString(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (typeof output !== 'object' || output === null) {
    return String(output ?? '');
  }
  const typed = output as { value?: unknown; reason?: unknown };
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
