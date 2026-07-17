import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  AgentEventRecorder,
  AgentStreamEvent,
  AgentUsage,
} from '@ello/agent';

import type { CodingAgentConfig } from '../config/index.js';
import { logsDir } from '../session/paths.js';
import type { UsageRepository } from '../storage/repositories/usage-repository.js';

/** 将安全的 usage 聚合和 NDJSON 诊断消费统一运行事件。 */
export function createCodingObserver(
  config: CodingAgentConfig,
  runtime: { readonly model: string },
  usageRepository: UsageRepository,
): AgentEventRecorder {
  const file = path.join(logsDir(), 'coding-agent.ndjson');
  const starts = new Map<string, string>();
  const previousCalls = new Map<
    string,
    Extract<AgentStreamEvent, { type: 'model.completed' }>
  >();
  const log = (event: string, data: Record<string, unknown>): Promise<void> =>
    writeLine(file, {
      ts: new Date().toISOString(),
      event,
      model: runtime.model,
      ...data,
    });

  return {
    async record(event, ctx): Promise<void> {
      switch (event.type) {
        case 'run.started':
          starts.set(event.runId, event.occurredAt);
          await log('run.started', {
            runId: event.runId,
            sessionId: ctx.sessionId,
          });
          return;
        case 'tool.approval_requested':
          await log('tool.approval_requested', {
            tool: event.request.name,
            toolCallId: event.request.toolCallId,
          });
          return;
        case 'tool.deferred':
          await log('tool.deferred', {
            tool: event.item.toolName,
            toolCallId: event.item.toolCallId,
          });
          return;
        case 'tool.completed':
          await log('tool.completed', {
            toolCallId: event.toolCallId,
            ok: true,
          });
          return;
        case 'tool.failed':
          await log('tool.failed', {
            toolCallId: event.toolCallId,
            ok: false,
            error: event.error.message,
          });
          return;
        case 'model.completed': {
          const previous = previousCalls.get(event.runId);
          await log('model.call.completed', {
            runId: event.runId,
            turnIndex: event.identity.turnIndex,
            provider: event.identity.provider,
            model: event.identity.model,
            finishReason: event.response.finishReason,
            usage: summarizeUsage(event.response.usage),
            durationMs: durationMs(event.startedAt, event.occurredAt),
            fingerprintChanges: fingerprintChanges(previous, event),
          });
          usageRepository.recordModelCall(event);
          previousCalls.set(event.runId, event);
          return;
        }
        case 'run.completed':
          await log('run.completed', {
            finishReason: event.finishReason,
            usage: summarizeUsage(event.usage),
          });
          usageRepository.recordRunSummary({
            runId: event.runId,
            invocation: config.tui ? 'tui' : 'run',
            model: runtime.model,
            status:
              event.finishReason === 'interrupted'
                ? 'interrupted'
                : 'completed',
            finishReason: event.finishReason,
            toolCalls: event.usage.toolCalls,
            startedAt: requireStart(starts, event.runId),
            completedAt: event.occurredAt,
          });
          starts.delete(event.runId);
          previousCalls.delete(event.runId);
          return;
        case 'run.failed':
          await log('run.failed', { error: event.error.message });
          usageRepository.recordRunSummary({
            runId: event.runId,
            invocation: config.tui ? 'tui' : 'run',
            model: runtime.model,
            status: 'failed',
            toolCalls: 0,
            startedAt: requireStart(starts, event.runId),
            completedAt: event.occurredAt,
          });
          starts.delete(event.runId);
          previousCalls.delete(event.runId);
          return;
        default:
          return;
      }
    },
  };
}

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
  if (startedAt === undefined)
    throw new Error(`Missing run start timestamp: ${runId}`);
  return startedAt;
}

function durationMs(startedAt: string, completedAt: string): number {
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(duration) || duration < 0)
    throw new Error(
      `Invalid model call timestamps: ${startedAt}, ${completedAt}`,
    );
  return duration;
}

function fingerprintChanges(
  previous: Extract<AgentStreamEvent, { type: 'model.completed' }> | undefined,
  current: Extract<AgentStreamEvent, { type: 'model.completed' }>,
): readonly string[] {
  const changes: string[] = [];
  if (previous !== undefined) {
    if (
      previous.diagnostics.systemFingerprint !==
      current.diagnostics.systemFingerprint
    )
      changes.push('system');
    if (
      previous.diagnostics.toolsetFingerprint !==
      current.diagnostics.toolsetFingerprint
    )
      changes.push('toolset');
    if (
      previous.diagnostics.messagePrefixFingerprint !==
      current.diagnostics.messagePrefixFingerprint
    )
      changes.push('message-prefix');
  }
  if (current.diagnostics.compactionBoundary)
    changes.push('compaction-boundary');
  return changes;
}
