import type { ModelMessage } from 'ai';

import type { ModelConfig } from '../config.js';
import { AgentContext } from '../context.js';
import type { CompactEvent } from '../events.js';

import { findCutPoint } from './cut-point.js';
import { generateSummary, type SummaryAgent } from './summarize.js';

/** compact filter 的 pydantic-ai RunContext 等价最小结构。 */
export interface CompactRunContext {
  deps: AgentContext;
  agent?: SummaryAgent | null;
}

/** 从最近的 assistant 消息中读取 total token 使用量。 */
export function getLatestTotalTokens(messages: ModelMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as
      | (ModelMessage & {
          usage?: {
            totalTokens?: number | null;
            total_tokens?: number | null;
          };
        })
      | undefined;
    if (message?.role !== 'assistant') {
      continue;
    }
    const total = message.usage?.totalTokens ?? message.usage?.total_tokens;
    if (typeof total === 'number' && total > 0) {
      return total;
    }
  }
  return null;
}

/** 基于 token 使用量和 compactThreshold 判断是否需要压缩。 */
export function needCompact(
  ctx: AgentContext,
  messages: ModelMessage[],
): boolean {
  if (messages.length === 0) {
    return false;
  }
  if (ctx.modelConfig.contextWindow === null) {
    return false;
  }

  const totalTokens = getLatestTotalTokens(messages);
  if (totalTokens === null) {
    return false;
  }

  const thresholdTokens = Math.floor(
    ctx.modelConfig.contextWindow * ctx.modelConfig.compactThreshold,
  );
  return totalTokens >= thresholdTokens;
}

/** 从消息历史中提取之前的 compaction summary。 */
export function extractPreviousSummary(
  messages: ModelMessage[],
): string | null {
  for (const message of messages.slice(0, 5)) {
    if (message.role !== 'assistant') {
      continue;
    }
    const text = modelMessageText(message);
    if (text.length > 100) {
      return text;
    }
  }
  return null;
}

/**
 * 构建压缩后的消息列表。
 *
 * 结构: [compaction marker request, summary response, ...keptMessages]。
 */
export function buildCompactedMessages(
  summary: string,
  originalPrompt: string,
  keptMessages: ModelMessage[],
): ModelMessage[] {
  const result: ModelMessage[] = [
    {
      role: 'system',
      content: 'Placeholder system prompt',
    },
    {
      role: 'user',
      content:
        "Context was compacted. The assistant's response below is a summary of the earlier conversation.",
    },
    {
      role: 'assistant',
      content: summary,
    },
  ];

  if (originalPrompt && keptMessages.length === 0) {
    result.push({
      role: 'user',
      content:
        `[Original request]: ${originalPrompt}\n\n` +
        'Context has been restored from a previous summary. Continue working on the task described above.',
    });
  }

  result.push(...keptMessages);
  return result;
}

/** 创建 compact filter, 使用 cut-point 精确裁剪。 */
export function createCompactFilter(modelConfig?: ModelConfig | null) {
  return async (
    ctx: CompactRunContext,
    messageHistory: ModelMessage[],
  ): Promise<ModelMessage[]> => {
    const agentCtx = ctx.deps;

    if (agentCtx.compactDepth > 0) {
      return messageHistory;
    }
    if (!ctx.agent) {
      return messageHistory;
    }

    const checkCtx = new AgentContext({
      env: agentCtx.env,
      modelConfig: modelConfig ?? agentCtx.modelConfig,
      toolConfig: agentCtx.toolConfig,
    });

    if (!needCompact(checkCtx, messageHistory)) {
      return messageHistory;
    }

    const nextCtx = new AgentContext({
      env: agentCtx.env,
      modelConfig: agentCtx.modelConfig,
      toolConfig: agentCtx.toolConfig,
      injectedContextTags: agentCtx.injectedContextTags,
      userPrompts: agentCtx.userPrompts,
      steeringMessages: agentCtx.steeringMessages,
      compactDepth: agentCtx.compactDepth + 1,
    });

    try {
      const keepTokens = Math.floor(
        (checkCtx.modelConfig.contextWindow ?? 128_000) * 0.3,
      );
      const cut = findCutPoint(messageHistory, keepTokens);
      if (cut === null) {
        return messageHistory;
      }

      const toSummarize = messageHistory.slice(0, cut.firstKeptIndex);
      const toKeep = messageHistory.slice(cut.firstKeptIndex);
      const previousSummary = extractPreviousSummary(toSummarize);
      const summary = await generateSummary(toSummarize, ctx.agent, nextCtx, {
        previousSummary,
      });
      const originalPrompt = agentCtx.userPrompts.join(' ');
      const compacted = buildCompactedMessages(summary, originalPrompt, toKeep);

      const event: CompactEvent = {
        runId: agentCtx.runId,
        timestamp: new Date(),
        summaryPreview: summary.slice(0, 200),
        originalMessageCount: messageHistory.length,
        compactedMessageCount: compacted.length,
      };
      agentCtx.emitEvent(event);

      return compacted;
    } catch {
      return messageHistory;
    }
  };
}

function modelMessageText(message: ModelMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return '';
  }
  return message.content
    .map((part) => {
      if (part.type === 'text') {
        return part.text;
      }
      return '';
    })
    .join('');
}
