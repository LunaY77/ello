import { randomUUID } from 'node:crypto';

import type {
  AgentRuntime,
  AgentRuntimeRunInput,
  AgentRuntimeRunResult,
  AgentStreamer,
  AgentStreamEvent,
  DeferredToolApprovalRequest,
  ModelMessage,
  RunState,
} from '@ello/agent';
import { AgentInterrupted } from '@ello/agent';
import {
  buildApprovalToolCallMessage,
  buildApprovalToolResultMessage,
  isDeferredToolRequests,
  resolveApprovalResult,
} from '@ello/agent';

import type { CodingAgentConfig } from '../config.js';
import { EventStream } from '../event-stream.js';
import type { JsonlSessionStorage } from '../jsonl-session-storage.js';
import type { MemoryManifest } from '../memory.js';
import { summarizeMemory } from '../memory.js';
import {
  evaluateToolPermission,
  formatPermissionRules,
} from '../permissions.js';
import { TaskManager, type TaskRecord } from '../task-manager.js';

import type { CodingAgentEvent } from './types.js';

/**
 * CLI/TUI 使用的会话 runtime 包装器。
 *
 * 该类负责实时 run 队列、审批续跑、任务快照和事件分发。
 */
export class CodingAgentSession {
  private currentStream: AgentStreamer<AgentRuntimeRunResult> | null = null;
  private runQueue: Promise<void> = Promise.resolve();
  private readonly eventStream = new EventStream<CodingAgentEvent>();
  private pendingState: RunState | null = null;
  private pendingApprovals = new Map<string, DeferredToolApprovalRequest>();
  private interruptedRecoveryMessages: ModelMessage[] | null = null;
  private toolStartedAt = new Map<string, number>();
  private closed = false;

  constructor(
    readonly config: CodingAgentConfig,
    readonly sessionId: string,
    readonly runtime: AgentRuntime,
    private readonly storage: JsonlSessionStorage,
    private readonly memory: MemoryManifest,
    private readonly tasks = new TaskManager(),
  ) {}

  events(): AsyncIterable<CodingAgentEvent> {
    return this.eventStream;
  }

  /**
   * Broadcast an internal event to any UI or CLI consumers.
   */
  emit(event: CodingAgentEvent): void {
    this.eventStream.push(event);
  }

  /**
   * 发出最新 usage 快照，供 UI 渲染 token 汇总。
   */
  emitUsageSnapshot(): void {
    const snapshot = this.runtime.ctx?.usageSnapshot;
    if (snapshot === undefined || snapshot === null) {
      return;
    }
    this.emit({
      type: 'usage_snapshot',
      runId: snapshot.runId,
      totalUsage: snapshot.totalUsage,
      modelUsage: snapshot.modelUsageTotals,
      agentUsage: snapshot.agentUsageTotals,
    });
  }

  /**
   * Queue a single run so concurrent UI actions do not interleave.
   */
  async submit(
    input: AgentRuntimeRunInput,
    onEvent?: (event: CodingAgentEvent) => void,
  ): Promise<void> {
    this.runQueue = this.runQueue.then(() => this.runOnce(input, onEvent));
    return this.runQueue;
  }

  interrupt(): void {
    this.currentStream?.interrupt();
  }

  /**
   * 从已中断 run 缓存的可恢复消息继续执行。
   */
  async resumeInterruptedRun(onEvent?: (event: CodingAgentEvent) => void): Promise<void> {
    if (this.interruptedRecoveryMessages === null) {
      this.emit({
        type: 'diagnostic',
        level: 'warn',
        message: 'No interrupted run to resume.',
      });
      return;
    }
    const messages = this.interruptedRecoveryMessages;
    this.interruptedRecoveryMessages = null;
    await this.submit({ messages }, onEvent);
  }

  /**
   * Approve or reject a pending tool call and resume execution.
   */
  async approveToolCall(
    id: string,
    decision: 'approve' | 'reject',
    inputOverride?: unknown,
  ): Promise<void> {
    const request = this.pendingApprovals.get(id);
    if (request === undefined || this.pendingState === null) {
      this.emit({
        type: 'diagnostic',
        level: 'warn',
        message: `No pending approval found for ${id}.`,
      });
      return;
    }
    if (this.runtime.ctx === null) {
      throw new Error('AgentRuntime context is not available.');
    }
    const permission = evaluateToolPermission(
      {
        approvalMode: this.config.approvalMode,
        rules: this.config.permissionRules,
        cwd: this.config.cwd,
        allowedPaths: this.config.allowedPaths,
      },
      request.toolName,
      request.input,
    );
    await this.storage.appendEvent({
      type: 'permission_decision',
      toolCallId: id,
      toolName: request.toolName,
      action: decision,
      policyAction: permission.action,
      reason: permission.reason,
    });
    this.emit({
      type: 'permission_decision',
      toolCallId: id,
      toolName: request.toolName,
      action: decision,
      reason: permission.reason,
    });

    const result = await resolveApprovalResult({
      request,
      decision:
        decision === 'approve'
          ? true
          : { approved: false, reason: 'rejected by user' },
      ctx: this.runtime.ctx,
      toolsets: this.runtime.toolsets,
      inputOverride,
    });
    const resumeMessages = [
      ...this.pendingState.messages,
      buildApprovalToolCallMessage(request),
      buildApprovalToolResultMessage({ request, result }),
    ];
    this.pendingApprovals.delete(id);
    if (this.pendingApprovals.size === 0) {
      this.pendingState = null;
    }
    await this.submitResume(resumeMessages, id, decision);
  }

  async compact(): Promise<void> {
    this.emit({
      type: 'compacted',
      message: 'Compaction is delegated to @ello/agent automatic compact filters.',
    });
  }

  /**
   * 为新分支 run 记录父会话关系。
   */
  async branchFrom(parentSessionId: string, parentLeafId: string | null): Promise<void> {
    await this.storage.branchFrom(parentSessionId, parentLeafId);
  }

  /**
   * 渲染简洁的记忆摘要，供状态面板和诊断使用。
   */
  getMemorySummary(): string {
    return summarizeMemory(this.memory, this.config.cwd);
  }

  /**
   * 渲染简洁的权限摘要，供状态面板和诊断使用。
   */
  getPermissionSummary(): string {
    return [
      `mode\t${this.config.approvalMode}`,
      `allowedPaths\t${this.config.allowedPaths.join(', ')}`,
      formatPermissionRules(this.config.permissionRules),
    ].join('\n');
  }

  /**
   * 快照当前任务列表，不暴露内部可变状态。
   */
  listTasks(): TaskRecord[] {
    return this.tasks.snapshot();
  }

  /**
   * 为当前对话轮次创建新的跟踪任务条目。
   */
  createTask(content: string, activeForm?: string): TaskRecord {
    const task = this.tasks.create(content, activeForm === undefined ? {} : { activeForm });
    void this.publishTaskSnapshot();
    return task;
  }

  /**
   * 对已有任务应用局部更新，并持久化快照。
   */
  updateTask(id: string, patch: Parameters<TaskManager['update']>[1]): TaskRecord {
    const task = this.tasks.update(id, patch);
    void this.publishTaskSnapshot();
    return task;
  }

  /**
   * 关闭实时 runtime，并停止事件流。
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.eventStream.close();
    await this.runtime.exit();
  }

  /**
   * 同时向内部事件流和调用方回调发出事件。
   */
  private publish(event: CodingAgentEvent, onEvent?: (event: CodingAgentEvent) => void): void {
    this.emit(event);
    onEvent?.(event);
  }

  private async runOnce(
    input: AgentRuntimeRunInput,
    onEvent: ((event: CodingAgentEvent) => void) | undefined,
  ): Promise<void> {
    const runId = randomUUID().replaceAll('-', '').slice(0, 12);
    const inputLabel = typeof input === 'string' ? input : '[runtime messages]';
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
      const stream = this.runtime.stream(input);
      this.currentStream = stream;
      this.emitUsageSnapshot();
      for await (const event of stream) {
        this.publish({ type: 'core_event', event }, onEvent);
        this.emitToolDisplay(event, onEvent);
      }
      const result = await stream.result();
      if (isDeferredToolRequests(result.output)) {
        this.pendingState = stream.state;
        this.pendingApprovals.clear();
        for (const approval of result.output.approvals) {
          this.pendingApprovals.set(approval.toolCallId, approval);
          const permission = evaluateToolPermission(
            {
              approvalMode: this.config.approvalMode,
              rules: this.config.permissionRules,
              cwd: this.config.cwd,
              allowedPaths: this.config.allowedPaths,
            },
            approval.toolName,
            approval.input,
          );
          await this.storage.appendEvent({
            type: 'approval_request',
            toolCallId: approval.toolCallId,
            toolName: approval.toolName,
            action: permission.action,
            reason: permission.reason,
          });
          this.publish(
            {
              type: 'approval_request',
              toolCallId: approval.toolCallId,
              toolName: approval.toolName,
              input: approval.input,
              risk: `${describeToolRisk(approval.toolName, approval.input)} ${permission.reason}`,
            },
            onEvent,
          );
        }
      }
      if (task !== null) {
        this.tasks.update(task.id, { status: 'completed' });
        await this.publishTaskSnapshot(onEvent);
      }
      this.publish({ type: 'run_finished', runId, success: true }, onEvent);
    } catch (error) {
      if (error instanceof AgentInterrupted && this.currentStream !== null) {
        this.interruptedRecoveryMessages = this.currentStream.recoverableMessages();
        this.emit({
          type: 'diagnostic',
          level: 'info',
          message:
            this.interruptedRecoveryMessages === null
              ? 'Run interrupted.'
              : 'Run interrupted. Recoverable messages captured.',
        });
      }
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

  private async submitResume(
    messages: ModelMessage[],
    toolCallId: string,
    decision: 'approve' | 'reject',
  ): Promise<void> {
    this.emit({
      type: 'diagnostic',
      level: 'info',
      message: `${decision === 'approve' ? 'Approved' : 'Rejected'} ${toolCallId}; resuming run.`,
    });
    await this.submit({ messages });
  }

  /**
   * 持久化当前任务快照，供恢复和检查流程使用。
   */
  private async publishTaskSnapshot(
    onEvent?: (event: CodingAgentEvent) => void,
  ): Promise<void> {
    const tasks = this.tasks.snapshot();
    await this.storage.appendTaskSnapshot(tasks);
    this.publish({ type: 'task_snapshot', tasks }, onEvent);
  }

  /**
   * Translate runtime tool lifecycle events into TUI-friendly events.
   */
  private emitToolDisplay(
    event: AgentStreamEvent,
    onEvent: ((event: CodingAgentEvent) => void) | undefined,
  ): void {
    if (event.type === 'tool_execution_start') {
      const startedAt = Date.now();
      this.toolStartedAt.set(event.toolCallId, startedAt);
      this.publish(
        {
          type: 'tool_display',
          status: 'started',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          startedAt: new Date(startedAt).toISOString(),
        },
        onEvent,
      );
    }
    if (event.type === 'tool_execution_end') {
      const finishedAt = Date.now();
      const startedAt = this.toolStartedAt.get(event.toolCallId);
      this.toolStartedAt.delete(event.toolCallId);
      this.publish(
        {
          type: 'tool_display',
          status: 'finished',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
          finishedAt: new Date(finishedAt).toISOString(),
          ...(startedAt === undefined ? {} : { durationMs: finishedAt - startedAt }),
        },
        onEvent,
      );
    }
  }
}

function describeToolRisk(toolName: string, input: unknown): string {
  if (toolName === 'shell_exec') {
    return 'Shell commands can modify the workspace or execute external programs.';
  }
  if (toolName === 'delete_file') {
    return 'Deleting files can remove user work.';
  }
  if (toolName === 'write_file' || toolName === 'edit_file') {
    return 'File writes can overwrite existing content.';
  }
  if (toolName.startsWith('web_')) {
    return 'Network tools can send request metadata outside the workspace.';
  }
  return `Review arguments before approving: ${JSON.stringify(input)}`;
}
