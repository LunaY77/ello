import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentObserver,
  AgentUsage,
  ModelCallCompletedEvent,
} from '@ello/agent';

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
 * NDJSON 与 SQLite 都是运行诊断契约，写入失败直接终止 run。
 */
export function createCodingObserver(
  config: CodingAgentConfig,
  runtime: { readonly model: string },
  usageRepository: UsageRepository,
): AgentObserver {
  const file = path.join(logsDir(), 'coding-agent.ndjson');
  const starts = new Map<string, string>();
  const previousCalls = new Map<string, ModelCallCompletedEvent>();
  const log = (event: string, data: Record<string, unknown>): Promise<void> => {
    return writeLine(file, {
      ts: new Date().toISOString(),
      event,
      model: runtime.model,
      ...data,
    });
  };

  return {
    onRunStarted: async (event, ctx) => {
      starts.set(event.runId, new Date().toISOString());
      await log('run.started', {
        runId: event.runId,
        sessionId: ctx.sessionId,
      });
    },
    onToolApprovalRequired: (item) =>
      log('tool.approval_required', {
        tool: item.toolName,
        toolCallId: item.toolCallId,
      }),
    onToolCompleted: (call) =>
      log('tool.completed', {
        tool: call.name,
        ok: call.error === undefined,
      }),
    onModelCallCompleted: async (event) => {
      const previous = previousCalls.get(event.runId);
      const changes = fingerprintChanges(previous, event);
      await log('model.call.completed', {
        runId: event.runId,
        turnIndex: event.turnIndex,
        provider: event.provider,
        model: event.model,
        finishReason: event.finishReason,
        usage: summarizeUsage(event.usage),
        durationMs: event.durationMs,
        systemFingerprint: event.systemFingerprint,
        toolsetFingerprint: event.toolsetFingerprint,
        messagePrefixFingerprint: event.messagePrefixFingerprint,
        compactionBoundary: event.compactionBoundary,
        fingerprintChanges: changes,
      });
      usageRepository.recordModelCall(event);
      previousCalls.set(event.runId, event);
    },
    onRunCompleted: async (result) => {
      await log('run.completed', {
        finishReason: result.finishReason,
        usage: summarizeUsage(result.usage),
      });
      usageRepository.recordRunSummary({
        runId: result.id,
        invocation: config.tui ? 'tui' : 'run',
        model: runtime.model,
        status:
          result.finishReason === 'interrupted' ? 'interrupted' : 'completed',
        finishReason: result.finishReason,
        toolCalls: result.usage.toolCalls,
        startedAt: requireStart(starts, result.id),
        completedAt: new Date().toISOString(),
      });
      starts.delete(result.id);
      previousCalls.delete(result.id);
    },
    onRunFailed: async (event, ctx) => {
      await log('run.failed', { error: event.error.message });
      usageRepository.recordRunSummary({
        runId: ctx.runId,
        invocation: config.tui ? 'tui' : 'run',
        model: runtime.model,
        status: 'failed',
        toolCalls: 0,
        startedAt: requireStart(starts, ctx.runId),
        completedAt: new Date().toISOString(),
      });
      starts.delete(ctx.runId);
      previousCalls.delete(ctx.runId);
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

async function writeLine(
  file: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
}

function requireStart(starts: Map<string, string>, runId: string): string {
  const startedAt = starts.get(runId);
  if (startedAt === undefined) {
    throw new Error(`Missing run start timestamp: ${runId}`);
  }
  return startedAt;
}

function fingerprintChanges(
  previous: ModelCallCompletedEvent | undefined,
  current: ModelCallCompletedEvent,
): readonly string[] {
  const changes: string[] = [];
  if (previous !== undefined) {
    if (previous.systemFingerprint !== current.systemFingerprint) {
      changes.push('system');
    }
    if (previous.toolsetFingerprint !== current.toolsetFingerprint) {
      changes.push('toolset');
    }
    if (
      previous.messagePrefixFingerprint !== current.messagePrefixFingerprint
    ) {
      changes.push('message-prefix');
    }
  }
  if (current.compactionBoundary) {
    changes.push('compaction-boundary');
  }
  return changes;
}
