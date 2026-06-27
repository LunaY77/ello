import { randomUUID } from 'node:crypto';

import type {
  Agent,
  AgentInput,
  AgentMessage,
  AgentStream,
  AgentStreamEvent,
  AgentRunResult,
} from '@ello/agent';

import type { CodingAgentConfig } from '../config.js';
import { EventStream } from '../event-stream.js';
import type { JsonlSessionStorage } from '../jsonl-session-storage.js';
import type { MemoryManifest } from '../memory.js';
import { summarizeMemory } from '../memory.js';
import { formatPermissionRules } from '../permissions.js';
import { TaskManager, type TaskRecord } from '../task-manager.js';

import type { CodingAgentEvent } from './types.js';

/**
 * CLI/TUI 使用的会话包装器。
 *
 * 会话层只依赖新的稳定 Agent 接口，任务、事件、持久化和 UI 审批展示都在
 * 产品层完成，避免重新暴露核心 agent 内部实现。
 */
export class CodingAgentSession {
  private currentStream: AgentStream | null = null;
  private runQueue: Promise<void> = Promise.resolve();
  private readonly eventStream = new EventStream<CodingAgentEvent>();
  private interruptedRecoveryMessages: AgentMessage[] | null = null;
  private toolStartedAt = new Map<string, number>();
  private closed = false;
  private lastResult: AgentRunResult | null = null;

  constructor(
    readonly config: CodingAgentConfig,
    readonly sessionId: string,
    readonly agent: Agent,
    readonly storage: JsonlSessionStorage,
    private readonly memory: MemoryManifest,
    private readonly tasks = new TaskManager(),
  ) {}

  events(): AsyncIterable<CodingAgentEvent> {
    return this.eventStream;
  }

  emit(event: CodingAgentEvent): void {
    this.eventStream.push(event);
  }

  emitUsageSnapshot(): void {
    const usage = this.lastResult?.usage ?? {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 0,
    };
    this.emit({
      type: 'usage_snapshot',
      runId: this.lastResult?.id ?? 'idle',
      totalUsage: usage,
      modelUsage: {},
      agentUsage: {},
    });
  }

  submit(
    input: AgentInput,
    onEvent?: (event: CodingAgentEvent) => void,
  ): Promise<void> {
    this.runQueue = this.runQueue.then(() => this.runOnce(input, onEvent));
    return this.runQueue;
  }

  interrupt(): void {
    this.currentStream?.abort(new Error('Agent execution was interrupted'));
  }

  async resumeInterruptedRun(onEvent?: (event: CodingAgentEvent) => void): Promise<void> {
    if (this.interruptedRecoveryMessages === null) {
      this.emit({ type: 'diagnostic', level: 'warn', message: 'No interrupted run to resume.' });
      return;
    }
    const messages = this.interruptedRecoveryMessages;
    this.interruptedRecoveryMessages = null;
    await this.submit(messages, onEvent);
  }

  async approveToolCall(
    id: string,
    decision: 'approve' | 'reject',
    inputOverride?: unknown,
  ): Promise<void> {
    await this.storage.appendEvent({
      type: 'permission_decision',
      toolCallId: id,
      action: decision,
      inputOverride,
    });
    this.emit({
      type: 'permission_decision',
      toolCallId: id,
      toolName: id,
      action: decision,
      reason: 'Recorded by product-layer approval controller.',
    });
  }

  async compact(): Promise<void> {
    this.emit({
      type: 'compacted',
      message: 'Compaction is handled by @ello/agent extensions.',
    });
  }

  async branchFrom(parentSessionId: string, parentLeafId: string | null): Promise<void> {
    await this.storage.branchFrom(parentSessionId, parentLeafId);
  }

  getMemorySummary(): string {
    return summarizeMemory(this.memory, this.config.cwd);
  }

  getPermissionSummary(): string {
    return [
      `mode\t${this.config.approvalMode}`,
      `allowedPaths\t${this.config.allowedPaths.join(', ')}`,
      formatPermissionRules(this.config.permissionRules),
    ].join('\n');
  }

  listTasks(): TaskRecord[] {
    return this.tasks.snapshot();
  }

  createTask(content: string, activeForm?: string): TaskRecord {
    const task = this.tasks.create(content, activeForm === undefined ? {} : { activeForm });
    void this.publishTaskSnapshot();
    return task;
  }

  updateTask(id: string, patch: Parameters<TaskManager['update']>[1]): TaskRecord {
    const task = this.tasks.update(id, patch);
    void this.publishTaskSnapshot();
    return task;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.eventStream.close();
    await this.agent.close();
  }

  private publish(event: CodingAgentEvent, onEvent?: (event: CodingAgentEvent) => void): void {
    this.emit(event);
    onEvent?.(event);
  }

  private async runOnce(
    input: AgentInput,
    onEvent: ((event: CodingAgentEvent) => void) | undefined,
  ): Promise<void> {
    const runId = randomUUID().replaceAll('-', '').slice(0, 12);
    const inputLabel = typeof input === 'string' ? input : '[agent messages]';
    const task =
      typeof input === 'string' && input.trim()
        ? this.tasks.create(input.slice(0, 160), { activeForm: input.slice(0, 160) })
        : null;
    if (task !== null) {
      await this.publishTaskSnapshot(onEvent);
      this.tasks.update(task.id, { status: 'in_progress' });
      await this.publishTaskSnapshot(onEvent);
    }
    this.emitUsageSnapshot();
    this.publish({ type: 'run_started', runId, input: inputLabel }, onEvent);
    try {
      const stream = this.agent.stream(input);
      this.currentStream = stream;
      const seenEvents: AgentStreamEvent[] = [];
      for await (const event of stream) {
        seenEvents.push(event);
        this.publish({ type: 'core_event', event }, onEvent);
        this.emitToolDisplay(event, onEvent);
      }
      const result = await stream.final;
      this.lastResult = result;
      this.interruptedRecoveryMessages = result.messages;
      if (task !== null) {
        this.tasks.update(task.id, { status: 'completed' });
        await this.publishTaskSnapshot(onEvent);
      }
      this.publish({ type: 'run_finished', runId, success: true }, onEvent);
    } catch (error) {
      if (task !== null) {
        this.tasks.update(task.id, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        await this.publishTaskSnapshot(onEvent);
      }
      this.publish(
        {
          type: 'run_finished',
          runId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        onEvent,
      );
      this.emitUsageSnapshot();
      throw error;
    } finally {
      this.currentStream = null;
      this.emitUsageSnapshot();
    }
  }

  private async publishTaskSnapshot(
    onEvent?: (event: CodingAgentEvent) => void,
  ): Promise<void> {
    const tasks = this.tasks.snapshot();
    await this.storage.appendTaskSnapshot(tasks);
    this.publish({ type: 'task_snapshot', tasks }, onEvent);
  }

  private emitToolDisplay(
    event: AgentStreamEvent,
    onEvent: ((event: CodingAgentEvent) => void) | undefined,
  ): void {
    if (event.type === 'tool.started') {
      const startedAt = Date.now();
      this.toolStartedAt.set(event.toolCallId, startedAt);
      this.publish(
        {
          type: 'tool_display',
          status: 'started',
          toolCallId: event.toolCallId,
          toolName: event.name,
          args: event.input,
          startedAt: new Date(startedAt).toISOString(),
        },
        onEvent,
      );
    }
    if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      const finishedAt = Date.now();
      const startedAt = this.toolStartedAt.get(event.toolCallId);
      this.toolStartedAt.delete(event.toolCallId);
      this.publish(
        {
          type: 'tool_display',
          status: 'finished',
          toolCallId: event.toolCallId,
          toolName: event.type === 'tool.completed' ? event.toolCallId : event.toolCallId,
          result: event.type === 'tool.completed' ? event.output : event.error,
          isError: event.type === 'tool.failed',
          finishedAt: new Date(finishedAt).toISOString(),
          ...(startedAt === undefined ? {} : { durationMs: finishedAt - startedAt }),
        },
        onEvent,
      );
    }
  }
}
