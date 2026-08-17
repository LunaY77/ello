/**
 * 本文件把持久任务与当前进程的 AgentRun 连接起来。
 *
 * Store 是事实源；Service 只保留可中断 run、通知保留和实时订阅。进程重启后这些句柄
 * 会消失，未确认通知仍由数据库重新投递。
 */
import { renderPromptTemplate } from '../context/prompts.js';
import type {
  AgentInteraction,
  AgentRun,
  AgentRunEvent,
  AgentRunResult,
} from '../contracts.js';
import type { AgentMessage } from '../engine/index.js';

import type { AgentTaskResult } from './task-result.js';
import { parseAgentTaskResult, salvageAgentTaskResult } from './task-result.js';
import {
  AgentTaskStore,
  type AgentTask,
  type AgentTaskChange,
  type AgentTaskEvent,
  type AgentTaskNotification,
  type AgentTaskSnapshot,
  type CreateAgentTask,
} from './task-store.js';
import { isTerminalAgentTaskStatus } from './task-types.js';

/** 把已领取的持久任务装配为当前进程可控制的 Agent 运行。 */
export type LaunchAgentTask = (task: AgentTask) => Promise<AgentRun>;

/** 把运行事件转换为可持久化的有界公开副本。 */
export type PrepareAgentTaskEvent = (
  task: AgentTask,
  event: AgentRunEvent,
) => Promise<AgentRunEvent>;

/** 启动结果同时提供最终完成和 foreground 工具调用的单次交付门。 */
export interface StartedAgentTask {
  readonly task: AgentTask;
  readonly completion: Promise<AgentTask>;
}

export interface AgentWaitResult {
  readonly task: AgentTask;
  readonly waitStatus: 'completed' | 'timed_out';
}

/** 一批已为某个 Primary run 保留、但尚未确认模型消费的持久通知。 */
export interface AgentTaskNotificationDelivery {
  readonly notificationIds: readonly string[];
  readonly text: string;
}

/** task 投影或 transcript 变化的进程内订阅函数。 */
export type AgentTaskChangeListener = (change: AgentTaskChange) => void;

/** 把 child 暂停交互交给 root thread 的持久 Server Request 管线。 */
export type HandleAgentTaskInteraction = (
  task: AgentTask,
  interaction: AgentInteraction,
  run: AgentRun,
) => Promise<void>;

/** 取消指定 root thread 及任务集合中尚未完成的 child 交互。 */
export type CancelAgentTaskInteractions = (
  rootThreadId: string,
  taskIds: readonly string[],
  reason: string,
) => Promise<void>;

/** 进程级子代理任务服务。 */
export class AgentTaskService {
  private readonly runs = new Map<string, AgentRun>();
  private readonly completions = new Map<string, Promise<AgentTask>>();
  private readonly ownedTaskIds = new Set<string>();
  private readonly listeners = new Map<string, Set<AgentTaskChangeListener>>();
  private notifier:
    | ((
        rootThreadId: string,
        notificationId: string,
        notification: string,
      ) => boolean)
    | undefined;
  private interactionHandler: HandleAgentTaskInteraction | undefined;
  private interactionCanceller: CancelAgentTaskInteractions | undefined;
  private readonly cancellingTasks = new Set<string>();
  private readonly cancellingRoots = new Set<string>();
  private readonly reservedNotifications = new Set<string>();
  private closing = false;

  /**
   * 创建任务运行服务；Store 与 Agent launcher 的生命周期仍由调用方持有。
   *
   * Args:
   * - `store`: 任务、事件和通知的唯一持久化入口。
   * - `launch`: 把已领取任务装配为实际 AgentRun 的函数。
   * - `prepareEvent`: 在落库前裁剪或转存大事件；省略时保留原事件。
   */
  constructor(
    private readonly store: AgentTaskStore,
    private readonly launch: LaunchAgentTask,
    private readonly prepareEvent: PrepareAgentTaskEvent = (_task, event) =>
      Promise.resolve(event),
    private readonly closeTimeoutMs = 5_000,
  ) {}

  /** 收口上次进程遗留的 running 任务。 */
  initialize(): number {
    return this.store.recoverRunning();
  }

  /** 设置父模型在线通知入口。 */
  setNotifier(
    notifier: (
      rootThreadId: string,
      notificationId: string,
      notification: string,
    ) => boolean,
  ): void {
    this.notifier = notifier;
  }

  /** 设置 child 审批与用户问题的 root thread 上浮入口。 */
  setInteractionHandler(handler: HandleAgentTaskInteraction): void {
    this.interactionHandler = handler;
  }

  /** 设置 child 挂起审批与用户问题的批量取消入口。 */
  setInteractionCanceller(canceller: CancelAgentTaskInteractions): void {
    this.interactionCanceller = canceller;
  }

  /** 建立 root thread 实时订阅；调用方负责在连接释放时执行返回函数。 */
  subscribe(
    rootThreadId: string,
    listener: AgentTaskChangeListener,
  ): () => void {
    const listeners = this.listeners.get(rootThreadId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(rootThreadId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(rootThreadId);
    };
  }

  /** 读取可作为 subscribe 响应屏障的完整任务树。 */
  snapshot(rootThreadId: string): AgentTaskSnapshot {
    return this.store.snapshot(rootThreadId);
  }

  /** 读取 root thread 下的稳定任务列表。 */
  list(rootThreadId: string): readonly AgentTask[] {
    return this.store.list(rootThreadId);
  }

  /** 读取单个任务和 transcript。 */
  read(
    selector: string,
    rootThreadId: string,
  ): { readonly task: AgentTask; readonly events: readonly AgentTaskEvent[] } {
    const task = this.store.requireForRoot(selector, rootThreadId);
    return { task, events: this.store.events(task.id) };
  }

  /** 创建并立即启动子代理任务。 */
  start(input: CreateAgentTask): StartedAgentTask {
    if (this.closing) throw new Error('Agent task service is closing.');
    if (this.isCreationBlocked(input)) {
      throw new Error('Agent task cannot start while its tree is cancelling.');
    }
    const change = this.store.createChange(input);
    this.ownedTaskIds.add(change.task.id);
    this.publish(change);
    const completion = this.launchTask(change.task.id);
    return { task: change.task, completion };
  }

  /** 在明确的依赖屏障等待任务进入终态。 */
  async wait(
    selector: string,
    rootThreadId: string,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<AgentWaitResult> {
    const task = this.store.requireForRoot(selector, rootThreadId);
    if (isTerminalAgentTaskStatus(task.status)) {
      return { task, waitStatus: 'completed' };
    }
    const waitController = new AbortController();
    const abortWait = () => waitController.abort(signal.reason);
    signal.addEventListener('abort', abortWait, { once: true });
    if (signal.aborted) abortWait();
    const completion = this.completions.get(task.id);
    const waiting =
      completion !== undefined
        ? waitWithSignal(completion, waitController.signal)
        : this.waitForTerminalTask(task, rootThreadId, waitController.signal);
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        waiting.then((completed) => ({
          task: completed,
          waitStatus: 'completed' as const,
        })),
        new Promise<AgentWaitResult>((resolve) => {
          timer = setTimeout(
            () =>
              resolve({
                task: this.store.require(task.id),
                waitStatus: 'timed_out',
              }),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abortWait);
      if (!waitController.signal.aborted) {
        waitController.abort(new Error('Agent dependency barrier closed.'));
      }
    }
  }

  private waitForTerminalTask(
    task: AgentTask,
    rootThreadId: string,
    signal: AbortSignal,
  ): Promise<AgentTask> {
    return new Promise<AgentTask>((resolve, reject) => {
      let unsubscribe: () => void = () => undefined;
      const finish = () => {
        const latest = this.store.require(task.id);
        if (isTerminalAgentTaskStatus(latest.status)) {
          unsubscribe();
          signal.removeEventListener('abort', abort);
          resolve(latest);
        }
      };
      const abort = () => {
        unsubscribe();
        reject(signal.reason ?? new Error('Agent wait interrupted.'));
      };
      unsubscribe = this.subscribe(rootThreadId, () => finish());
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else finish();
    });
  }

  /** 向 running task 追加幂等 steer。 */
  steer(
    selector: string,
    rootThreadId: string,
    steerId: string,
    text: string,
  ): AgentTask {
    const task = this.store.requireForRoot(selector, rootThreadId);
    if (task.status !== 'running') {
      throw new Error(
        `Agent task ${task.id} cannot be steered from ${task.status}.`,
      );
    }
    const run = this.runs.get(task.id);
    if (run === undefined) {
      throw new Error(`Agent task ${task.id} has no live run in this Server.`);
    }
    const change = this.store.recordSteer(task.id, steerId, text);
    if (change.task.revision !== task.revision) {
      run.steer(steerId, text);
      this.publish(change);
    }
    return change.task;
  }

  /** 停止 queued/running 任务；终态调用保持幂等。 */
  async stop(selector: string, rootThreadId: string): Promise<AgentTask> {
    const task = this.store.requireForRoot(selector, rootThreadId);
    if (isTerminalAgentTaskStatus(task.status)) return task;
    this.cancellingTasks.add(task.id);
    try {
      await this.cancelInteractions(
        task.rootThreadId,
        [task.id],
        'Agent task stopped by user.',
      );
      this.stopTask(
        task,
        'Primary stopped the Agent.',
        `agent task ${task.id} stopped`,
      );
      return this.store.require(task.id);
    } finally {
      this.cancellingTasks.delete(task.id);
    }
  }

  /** root Turn 中断时停止该 Primary 创建的全部活动任务。 */
  async stopRoot(
    rootThreadId: string,
    reason: string,
  ): Promise<readonly AgentTask[]> {
    this.cancellingRoots.add(rootThreadId);
    const active = this.store
      .list(rootThreadId)
      .filter((task) => !isTerminalAgentTaskStatus(task.status));
    for (const task of active) this.cancellingTasks.add(task.id);
    try {
      await this.cancelInteractions(
        rootThreadId,
        active.map((task) => task.id),
        reason,
      );
      for (const task of active) {
        this.stopTask(task, reason, reason);
      }
      return active.map((task) => this.store.require(task.id));
    } finally {
      for (const task of active) this.cancellingTasks.delete(task.id);
      this.cancellingRoots.delete(rootThreadId);
    }
  }

  /** 写入单个任务的 stopped 终态并中断当前进程中的 run。 */
  private stopTask(
    task: AgentTask,
    errorMessage: string,
    interruptReason: string,
  ): AgentTask {
    const result: AgentTaskResult = {
      status: 'stopped',
      summary: 'Subagent execution stopped before completion.',
      reason: errorMessage,
      partialWork: [],
      evidence: [],
    };
    const change = this.store.settleChange(task.id, {
      result,
      errorMessage,
      sidechain: task.sidechain,
    });
    this.publish(change);
    this.runs.get(task.id)?.interrupt(interruptReason);
    this.notify(change.task);
    return change.task;
  }

  /** 为父线程保留一批完成通知；保留本身不改变数据库 delivered 状态。 */
  takeNotifications(
    rootThreadId: string,
  ): AgentTaskNotificationDelivery | undefined {
    const notifications = this.store
      .pendingNotifications(rootThreadId)
      .filter(
        (notification) => !this.reservedNotifications.has(notification.id),
      );
    if (notifications.length === 0) return undefined;
    const entries = notifications.map((notification) => ({
      notification,
      task: this.store.require(notification.taskId),
    }));
    const notificationIds = notifications.map(
      (notification) => notification.id,
    );
    for (const id of notificationIds) this.reservedNotifications.add(id);
    return { notificationIds, text: renderNotifications(entries) };
  }

  /** 主 run 自然停止时等待下一批后台任务通知；没有活动后台任务时立即返回。 */
  async waitForNotification(
    rootThreadId: string,
    signal: AbortSignal,
  ): Promise<AgentTaskNotificationDelivery | undefined> {
    while (!signal.aborted) {
      const notification = this.takeNotifications(rootThreadId);
      if (notification !== undefined) return notification;
      const hasActiveTask = this.store
        .list(rootThreadId)
        .some((task) => !isTerminalAgentTaskStatus(task.status));
      if (!hasActiveTask) return undefined;
      await this.waitForTaskChange(rootThreadId, signal);
    }
    return undefined;
  }

  /** 模型输入已经消费通知后，原子确认并释放进程内保留。 */
  acknowledgeNotifications(notificationIds: readonly string[]): void {
    this.store.markNotificationsDelivered(notificationIds);
    for (const id of notificationIds) this.reservedNotifications.delete(id);
  }

  /** 模型输入未消费时释放保留，使同进程后续 run 可重新投递。 */
  releaseNotifications(notificationIds: readonly string[]): void {
    for (const id of notificationIds) this.reservedNotifications.delete(id);
  }

  /** 停止当前进程拥有的全部子任务并等待运行收口。 */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const taskId of this.ownedTaskIds) {
      const current = this.store.require(taskId);
      if (!isTerminalAgentTaskStatus(current.status)) {
        const result: AgentTaskResult = {
          status: 'stopped',
          summary: 'Subagent execution stopped during Server shutdown.',
          reason: 'Agent task service closed.',
          partialWork: [],
          evidence: [],
        };
        const change = this.store.settleChange(taskId, {
          result,
          errorMessage: 'Agent task service closed.',
          sidechain: current.sidechain,
        });
        this.publish(change);
      }
      this.runs.get(taskId)?.interrupt('agent task service closing');
    }
    await waitForClose(this.completions.values(), this.closeTimeoutMs);
    this.runs.clear();
    this.completions.clear();
    this.ownedTaskIds.clear();
    this.reservedNotifications.clear();
    this.listeners.clear();
  }

  private launchTask(taskId: string): Promise<AgentTask> {
    const existing = this.completions.get(taskId);
    if (existing !== undefined) return existing;
    const completion = this.execute(taskId);
    this.completions.set(taskId, completion);
    void completion.finally(() => {
      this.completions.delete(taskId);
      this.runs.delete(taskId);
      this.ownedTaskIds.delete(taskId);
    });
    return completion;
  }

  private async execute(taskId: string): Promise<AgentTask> {
    const runningChange = this.store.markRunningChange(taskId);
    if (runningChange === undefined) return this.store.require(taskId);
    this.publish(runningChange);
    const task = runningChange.task;
    const sidechain: AgentMessage[] = [...task.sidechain];
    let lastMessage = '';
    try {
      const run = await this.launch(task);
      this.runs.set(task.id, run);
      const current = this.store.require(task.id);
      if (current.status === 'stopped') {
        run.interrupt('agent task stopped before the child run was ready');
      } else if (this.closing) {
        run.interrupt('agent task service closing');
      }
      const consumeEvents = (async () => {
        for await (const event of run.events) {
          try {
            if (event.type === 'messageCompleted') lastMessage = event.text;
            if (event.type === 'messagesAppended')
              sidechain.push(...event.messages);
            const persistedEvent = await this.prepareEvent(task, event);
            const change = this.persistRunEvent(task.id, persistedEvent);
            if (change === undefined) continue;
            this.publish(change);
            if (event.type === 'interactionRequired') {
              if (isTerminalAgentTaskStatus(change.task.status)) continue;
              await this.forwardInteraction(task, event.interaction, run);
            }
            if (event.type === 'contextCompacted') {
              run.acknowledgeCompaction(event.compactionId);
            }
          } catch (error) {
            if (event.type === 'contextCompacted') {
              run.acknowledgeCompaction(event.compactionId, error);
            }
            throw error;
          }
        }
      })();
      const result = await run.result;
      await consumeEvents;
      const latest = this.store.require(task.id);
      if (isTerminalAgentTaskStatus(latest.status)) return latest;
      const output = lastMessage.trim();
      const terminal = terminalResult(result, output);
      const change = this.store.settleChange(task.id, {
        result: terminal.result,
        ...(output === '' ? {} : { output }),
        ...(terminal.errorMessage === undefined
          ? {}
          : { errorMessage: terminal.errorMessage }),
        usage: result.usage,
        sidechain,
      });
      this.publish(change);
      this.notify(change.task);
      return change.task;
    } catch (error) {
      const latest = this.store.require(task.id);
      if (isTerminalAgentTaskStatus(latest.status)) return latest;
      const message = errorMessage(error);
      const failure: AgentTaskResult = {
        status: 'failed',
        summary: 'Subagent execution failed.',
        error: message,
        evidence: [],
        retryable: false,
      };
      const change = this.store.settleChange(task.id, {
        result: failure,
        errorMessage: message,
        sidechain,
      });
      this.publish(change);
      this.notify(change.task);
      return change.task;
    }
  }

  private persistRunEvent(
    taskId: string,
    event: AgentRunEvent,
  ): AgentTaskChange | undefined {
    if (isTerminalAgentTaskStatus(this.store.require(taskId).status)) {
      return undefined;
    }
    const commandEvent =
      event.type === 'commandRunEvent' ? event.event : undefined;
    if (commandEvent?.type === 'command.started') {
      const record = commandEvent.record;
      const current = this.store.require(taskId);
      return this.store.append(
        taskId,
        commandEvent.type,
        event,
        {
          currentTool: {
            toolCallId: record.commandId,
            name: record.name,
            startedAt: commandEvent.occurredAt,
          },
          toolCount: current.toolCount + 1,
          recentTools: [
            ...current.recentTools,
            {
              toolCallId: record.commandId,
              name: record.name,
              invocationPreview: invocationPreview(record.input),
              status: 'running' as const,
              startedAt: commandEvent.occurredAt,
            },
          ].slice(-4),
        },
        `command.started:${record.commandId}`,
      );
    }
    if (
      commandEvent?.type === 'command.completed' ||
      commandEvent?.type === 'command.failed' ||
      commandEvent?.type === 'command.denied' ||
      commandEvent?.type === 'command.blocked'
    ) {
      const record = commandEvent.record;
      const current = this.store.require(taskId);
      const completedAt = commandEvent.occurredAt;
      return this.store.append(
        taskId,
        commandEvent.type,
        event,
        {
          ...(current.currentTool?.toolCallId === record.commandId
            ? { currentTool: null }
            : {}),
          recentTools: current.recentTools.map((tool) =>
            tool.toolCallId === record.commandId
              ? {
                  ...tool,
                  status:
                    commandEvent.type === 'command.completed'
                      ? ('completed' as const)
                      : ('failed' as const),
                  completedAt,
                }
              : tool,
          ),
        },
        `command.finished:${record.commandId}`,
      );
    }
    return this.store.append(taskId, event.type, event);
  }

  private async forwardInteraction(
    task: AgentTask,
    interaction: AgentInteraction,
    run: AgentRun,
  ): Promise<void> {
    try {
      if (this.interactionHandler === undefined) {
        throw new Error('Root thread interaction handler is unavailable.');
      }
      await this.interactionHandler(task, interaction, run);
    } catch (error) {
      run.resume({
        type: 'rejected',
        interactionId: interaction.interactionId,
        error: { code: -32_003, message: errorMessage(error) },
      });
      throw error;
    }
  }

  private isCreationBlocked(input: CreateAgentTask): boolean {
    return this.cancellingRoots.has(input.rootThreadId);
  }

  private cancelInteractions(
    rootThreadId: string,
    taskIds: readonly string[],
    reason: string,
  ): Promise<void> {
    return (
      this.interactionCanceller?.(rootThreadId, taskIds, reason) ??
      Promise.resolve()
    );
  }

  private publish(change: AgentTaskChange): void {
    for (const listener of this.listeners.get(change.task.rootThreadId) ?? []) {
      listener(change);
    }
  }

  private waitForTaskChange(
    rootThreadId: string,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        stop();
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const stop = this.subscribe(rootThreadId, finish);
      if (signal.aborted) finish();
      else signal.addEventListener('abort', finish, { once: true });
    });
  }

  private notify(task: AgentTask): void {
    const notifier = this.notifier;
    if (notifier === undefined) return;
    const notification = this.store
      .pendingNotifications(task.rootThreadId)
      .find(
        (candidate) =>
          candidate.taskId === task.id &&
          !this.reservedNotifications.has(candidate.id),
      );
    if (notification === undefined) return;
    this.reservedNotifications.add(notification.id);
    if (
      !notifier(
        task.rootThreadId,
        notification.id,
        renderNotifications([{ notification, task }]),
      )
    ) {
      this.reservedNotifications.delete(notification.id);
    }
  }
}

function invocationPreview(input: unknown): string {
  if (typeof input === 'string') return singleLine(input);
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  for (const key of [
    'filePath',
    'path',
    'command',
    'pattern',
    'url',
    'query',
  ]) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return singleLine(value);
  }
  try {
    return singleLine(JSON.stringify(input));
  } catch {
    return '';
  }
}

function singleLine(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 239)}…`;
}

function renderNotifications(
  entries: readonly {
    readonly notification: AgentTaskNotification;
    readonly task: AgentTask;
  }[],
): string {
  return entries
    .map(({ notification, task }) => {
      const reportContract = renderReportContract(task.definitionName);
      return [
        '<task-notification>',
        `  <notification-id>${notification.id}</notification-id>`,
        `  <task-id>${notification.taskId}</task-id>`,
        `  <status>${notification.status}</status>`,
        `  <summary>${escapeXml(notification.summary)}</summary>`,
        `  <result>${escapeXml(JSON.stringify(notification.result))}</result>`,
        `  <how-to-consume>${escapeXml(reportContract)}</how-to-consume>`,
        '</task-notification>',
      ].join('\n');
    })
    .join('\n');
}

function renderReportContract(definitionName: string): string {
  const contracts = [renderPromptTemplate('report-contract/any')];
  if (definitionName === 'explore' || definitionName === 'worker') {
    contracts.push(renderPromptTemplate(`report-contract/${definitionName}`));
  }
  return contracts.join('\n\n');
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function waitWithSignal(
  completion: Promise<AgentTask>,
  signal: AbortSignal,
): Promise<AgentTask> {
  if (signal.aborted)
    throw signal.reason ?? new Error('Agent wait interrupted.');
  return await new Promise<AgentTask>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      action();
    };
    const abort = () =>
      finish(() =>
        reject(signal.reason ?? new Error('Agent wait interrupted.')),
      );
    signal.addEventListener('abort', abort, { once: true });
    void completion.then(
      (task) => finish(() => resolve(task)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

async function waitForClose(
  completions: Iterable<Promise<AgentTask>>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...completions]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function terminalResult(
  result: AgentRunResult,
  output: string,
): { readonly result: AgentTaskResult; readonly errorMessage?: string } {
  if (result.status === 'interrupted') {
    return {
      result: {
        status: 'stopped',
        summary: 'Subagent execution was interrupted.',
        reason: result.reason,
        partialWork: [],
        evidence: [],
      },
      errorMessage: result.reason,
    };
  }
  if (result.status === 'failed') {
    return {
      result: {
        status: 'failed',
        summary: 'Subagent execution failed.',
        error: result.error.message,
        evidence: [],
        retryable: false,
      },
      errorMessage: result.error.message,
    };
  }
  if (output === '') {
    const message = 'Agent task completed without a final answer.';
    return {
      result: {
        status: 'failed',
        summary: 'Subagent returned no structured result.',
        error: message,
        evidence: [],
        retryable: true,
      },
      errorMessage: message,
    };
  }
  try {
    return { result: parseAgentTaskResult(output) };
  } catch (error) {
    const message = errorMessage(error);
    const diagnostic = `${message}\nRaw Subagent output:\n${boundedRawOutput(output)}`;
    const salvaged = salvageAgentTaskResult(output);
    return {
      result: {
        status: 'failed',
        summary:
          salvaged?.summary ??
          'Subagent returned an invalid structured result.',
        error: diagnostic,
        evidence: salvaged?.evidence ?? [],
        retryable: true,
      },
      errorMessage: diagnostic,
    };
  }
}

function boundedRawOutput(output: string): string {
  const limit = 8_000;
  return output.length <= limit
    ? output
    : `${output.slice(0, limit)}\n… [truncated]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
