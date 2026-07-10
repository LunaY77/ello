import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { AgentObserver, AgentUsage } from '@ello/agent';

import type { CodingAgentConfig } from '../config/index.js';
import { logsDir } from '../session/paths.js';
import type { UsageRepository } from '../storage/repositories/usage-repository.js';

/**
 * coding-agent 结构化日志 observer。
 *
 * 可观测性是**横切**关注点，不引入新的事件体系，而是挂在内核已有的
 * {@link AgentObserver} 钩子上。本 observer 把生命周期事件写成 NDJSON
 * （一行一事件，方便 grep / 回放），落在 `~/.ello/logs/coding-agent.ndjson`。
 *
 * 安全原则：只记录安全的元数据——runId / sessionId / 工具名 / ok 标志 /
 * token 用量 / finishReason；绝不记录 prompt 正文、工具入参与结果、
 * 文件内容、shell 输出。
 *
 * NDJSON 日志失败不影响 run；usage 属于结构化状态，写入失败直接终止 run。
 */
export function createCodingObserver(
  config: CodingAgentConfig,
  runtime: { readonly model: string },
  usageRepository: UsageRepository,
): AgentObserver {
  const file = path.join(logsDir(), 'coding-agent.ndjson');
  const starts = new Map<string, string>();
  const log = (event: string, data: Record<string, unknown>): void => {
    void writeLine(file, {
      ts: new Date().toISOString(),
      event,
      model: runtime.model,
      ...data,
    });
  };

  return {
    onRunStarted: (event, ctx) => {
      starts.set(event.runId, new Date().toISOString());
      log('run.started', { runId: event.runId, sessionId: ctx.sessionId });
    },
    onToolApprovalRequired: (item) => {
      log('tool.approval_required', {
        tool: item.toolName,
        toolCallId: item.toolCallId,
      });
    },
    onToolCompleted: (call) => {
      log('tool.completed', { tool: call.name, ok: call.error === undefined });
    },
    onRunCompleted: async (result) => {
      log('run.completed', {
        finishReason: result.finishReason,
        usage: summarizeUsage(result.usage),
      });
      await usageRepository.recordUsage({
        runId: result.id,
        invocation: config.tui ? 'tui' : 'run',
        model: runtime.model,
        status: 'completed',
        finishReason: result.finishReason,
        usage: result.usage,
        startedAt: starts.get(result.id),
        completedAt: new Date().toISOString(),
      });
      starts.delete(result.id);
    },
    onRunFailed: async (event, ctx) => {
      log('run.failed', { error: event.error.message });
      await usageRepository.recordUsage({
        runId: ctx.runId,
        invocation: config.tui ? 'tui' : 'run',
        model: runtime.model,
        status: 'failed',
        startedAt: starts.get(ctx.runId),
        completedAt: new Date().toISOString(),
      });
      starts.delete(ctx.runId);
    },
  };
}

/** 把 usage 收敛成扁平、可累计的安全字段。 */
export function summarizeUsage(usage: AgentUsage): Record<string, number> {
  return {
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    toolCalls: usage.toolCalls,
  };
}

/** 追加一行 NDJSON；失败静默（可观测性不得影响执行）。 */
async function writeLine(
  file: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // 日志写入失败被动吞掉，绝不影响 agent 运行。
  }
}
