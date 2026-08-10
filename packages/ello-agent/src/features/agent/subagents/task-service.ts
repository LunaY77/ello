/**
 * 本文件把持久任务与当前进程的 AgentRun 连接起来。
 *
 * Store 是事实源；Service 只保留可中断 run、前台交付门和实时订阅。进程重启后这些句柄
 * 会消失，数据库中的 recovered 状态、transcript 和通知仍然完整。
 */
import { renderPromptTemplate } from '../context/prompts.js';
import type {
  AgentInteraction,
  AgentRun,
  AgentRunEvent,
} from '../contracts.js';
import type { AgentMessage } from '../engine/index.js';

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
  readonly delivery: Promise<AgentTask>;
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

interface DeliveryGate {
  readonly promise: Promise<AgentTask>;
  /** 首次调用时完成前台交付，后续竞态调用保持幂等。 */
  resolve(task: AgentTask): void;
}

/** 进程级子代理任务服务。 */
export class AgentTaskService {
  private readonly runs = new Map<string, AgentRun>();
  private readonly completions = new Map<string, Promise<AgentTask>>();
  private readonly deliveries = new Map<string, DeliveryGate>();
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
    this.publish(change);
    const gate = createDeliveryGate();
    this.deliveries.set(change.task.id, gate);
    const completion = this.launchTask(change.task.id);
    if (change.task.executionMode === 'background') gate.resolve(change.task);
    return { task: change.task, completion, delivery: gate.promise };
  }

  /** 从 terminal/recovered task 的 sidechain 创建一个新任务。 */
  resume(
    taskId: string,
    rootThreadId: string,
    prompt: string,
    options: {
      readonly name?: string;
      readonly description?: string;
      readonly executionMode?: 'foreground' | 'background';
    } = {},
  ): StartedAgentTask {
    const previous = this.store.requireForRoot(taskId, rootThreadId);
    if (!isTerminalAgentTaskStatus(previous.status)) {
      throw new Error(`Agent task ${taskId} is still ${previous.status}.`);
    }
    return this.start({
      rootThreadId: previous.rootThreadId,
      ...(previous.parentTaskId === undefined
        ? {}
        : { parentTaskId: previous.parentTaskId }),
      resumeFromTaskId: previous.id,
      ...(options.name === undefined ? {} : { name: options.name }),
      description: options.description ?? previous.description,
      definitionName: previous.definitionName,
      ...(previous.modelSelector === undefined
        ? {}
        : { modelSelector: previous.modelSelector }),
      contextMode: previous.contextMode,
      executionMode: options.executionMode ?? 'background',
      prompt,
      cwd: previous.cwd,
      isolation: previous.isolation,
      maxTurns: previous.maxTurns,
      depth: previous.depth,
      sidechain: previous.sidechain,
      commandNames: previous.commandNames,
      permissionRules: previous.permissionRules,
      externalPaths: previous.externalPaths,
    });
  }

  /** 查询任务；可选择等待当前进程中的运行完成。 */
  async output(
    selector: string,
    rootThreadId: string,
    waitMs: number,
  ): Promise<AgentTask> {
    const task = this.store.requireForRoot(selector, rootThreadId);
    const completion = this.completions.get(task.id);
    if (completion === undefined || waitMs === 0) return task;
    return await waitFor(completion, waitMs, task);
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

  /** 将 foreground task 单向转为 background，并释放父工具调用。 */
  background(selector: string, rootThreadId: string): AgentTask {
    const task = this.store.requireForRoot(selector, rootThreadId);
    const change = this.store.background(task.id);
    if (change.task.revision !== task.revision) {
      this.publish(change);
      this.deliveries.get(task.id)?.resolve(change.task);
    }
    return change.task;
  }

  /** 停止 queued/running 任务及全部活动后代；终态调用保持幂等。 */
  async stop(selector: string, rootThreadId: string): Promise<AgentTask> {
    const task = this.store.requireForRoot(selector, rootThreadId);
    if (isTerminalAgentTaskStatus(task.status)) return task;
    const subtree = this.activeSubtree(task);
    for (const member of subtree) this.cancellingTasks.add(member.id);
    try {
      await this.cancelInteractions(
        task.rootThreadId,
        subtree.map((member) => member.id),
        'Agent task stopped by user.',
      );
      for (const member of [...subtree].sort((a, b) => b.depth - a.depth)) {
        this.stopTask(
          member,
          member.id === task.id
            ? 'Parent stopped the task.'
            : `Ancestor task ${task.id} was stopped.`,
          `agent task tree ${task.id} stopped`,
        );
      }
      return this.store.require(task.id);
    } finally {
      for (const member of subtree) this.cancellingTasks.delete(member.id);
    }
  }

  /** root Turn 中断时停止整棵活动任务树。 */
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
      for (const task of [...active].sort((a, b) => b.depth - a.depth)) {
        this.stopTask(task, reason, reason);
      }
      return active.map((task) => this.store.require(task.id));
    } finally {
      for (const task of active) this.cancellingTasks.delete(task.id);
      this.cancellingRoots.delete(rootThreadId);
    }
  }

  /** 写入单个任务的 killed 终态，并收口当前进程中的交付门与 run。 */
  private stopTask(
    task: AgentTask,
    errorMessage: string,
    interruptReason: string,
  ): AgentTask {
    const change = this.store.settleChange(task.id, {
      status: 'killed',
      errorMessage,
      sidechain: task.sidechain,
    });
    this.publish(change);
    this.runs.get(task.id)?.interrupt(interruptReason);
    this.deliveries.get(task.id)?.resolve(change.task);
    this.notify(change.task);
    return change.task;
  }

  /** 读取并消费父线程的完成通知。 */
  takeNotifications(rootThreadId: string): string {
    const notifications = this.store.pendingNotifications(rootThreadId);
    if (notifications.length === 0) return '';
    const entries = notifications.map((notification) => ({
      notification,
      task: this.store.require(notification.taskId),
    }));
    this.store.markNotificationsDelivered(
      notifications.map((notification) => notification.id),
    );
    return renderNotifications(entries);
  }

  /** 主 run 自然停止时等待下一批后台任务通知；没有活动后台任务时立即返回。 */
  async waitForNotification(
    rootThreadId: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    while (!signal.aborted) {
      const notification = this.takeNotifications(rootThreadId);
      if (notification !== '') return notification;
      const hasActiveBackgroundTask = this.store
        .list(rootThreadId)
        .some(
          (task) =>
            task.executionMode === 'background' &&
            !isTerminalAgentTaskStatus(task.status),
        );
      if (!hasActiveBackgroundTask) return undefined;
      await this.waitForTaskChange(rootThreadId, signal);
    }
    return undefined;
  }

  /** foreground tool_result 已携带终态时消费对应通知，避免下一轮重复注入。 */
  acknowledge(taskId: string): void {
    const task = this.store.require(taskId);
    const notification = this.store
      .pendingNotifications(task.rootThreadId)
      .find((candidate) => candidate.taskId === taskId);
    if (notification !== undefined) {
      this.store.markNotificationsDelivered([notification.id]);
    }
  }

  /** 停止当前进程拥有的全部子任务并等待运行收口。 */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const [taskId, run] of this.runs) {
      const current = this.store.require(taskId);
      if (!isTerminalAgentTaskStatus(current.status)) {
        const change = this.store.settleChange(taskId, {
          status: 'killed',
          errorMessage: 'Agent task service closed.',
          sidechain: current.sidechain,
        });
        this.publish(change);
        this.deliveries.get(taskId)?.resolve(change.task);
      }
      run.interrupt('agent task service closing');
    }
    await Promise.allSettled(this.completions.values());
    this.runs.clear();
    this.completions.clear();
    this.deliveries.clear();
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
      this.deliveries.delete(taskId);
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
      if (current.status === 'killed') {
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
            this.publish(change);
            if (event.type === 'interactionRequired') {
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
      const change =
        result.status === 'completed' && output !== ''
          ? this.store.settleChange(task.id, {
              status: 'completed',
              output,
              usage: result.usage,
              sidechain,
            })
          : result.status === 'completed'
            ? this.store.settleChange(task.id, {
                status: 'failed',
                errorMessage: 'Agent task completed without a final answer.',
                usage: result.usage,
                sidechain,
              })
            : result.status === 'interrupted'
              ? this.store.settleChange(task.id, {
                  status: 'killed',
                  errorMessage: result.reason,
                  usage: result.usage,
                  sidechain,
                })
              : this.store.settleChange(task.id, {
                  status: 'failed',
                  errorMessage: result.error.message,
                  usage: result.usage,
                  sidechain,
                });
      this.publish(change);
      this.deliveries.get(task.id)?.resolve(change.task);
      this.notify(change.task);
      if (change.task.status === 'killed') {
        await this.stopDescendants(change.task, change.task.errorMessage ?? '');
      }
      return change.task;
    } catch (error) {
      const latest = this.store.require(task.id);
      if (isTerminalAgentTaskStatus(latest.status)) return latest;
      const change = this.store.settleChange(task.id, {
        status: 'failed',
        errorMessage: errorMessage(error),
        sidechain,
      });
      this.publish(change);
      this.deliveries.get(task.id)?.resolve(change.task);
      this.notify(change.task);
      return change.task;
    }
  }

  private persistRunEvent(
    taskId: string,
    event: AgentRunEvent,
  ): AgentTaskChange {
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
    if (this.cancellingRoots.has(input.rootThreadId)) return true;
    let parentTaskId = input.parentTaskId;
    while (parentTaskId !== undefined) {
      if (this.cancellingTasks.has(parentTaskId)) return true;
      parentTaskId = this.store.get(parentTaskId)?.parentTaskId;
    }
    return false;
  }

  private activeSubtree(root: AgentTask): readonly AgentTask[] {
    const descendants = new Set([root.id]);
    const tasks = this.store.list(root.rootThreadId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (
          task.parentTaskId !== undefined &&
          descendants.has(task.parentTaskId) &&
          !descendants.has(task.id)
        ) {
          descendants.add(task.id);
          changed = true;
        }
      }
    }
    return tasks.filter(
      (task) =>
        descendants.has(task.id) && !isTerminalAgentTaskStatus(task.status),
    );
  }

  private async stopDescendants(
    parent: AgentTask,
    reason: string,
  ): Promise<void> {
    const descendants = this.activeSubtree(parent).filter(
      (task) => task.id !== parent.id,
    );
    if (descendants.length === 0) return;
    for (const task of descendants) this.cancellingTasks.add(task.id);
    try {
      await this.cancelInteractions(
        parent.rootThreadId,
        descendants.map((task) => task.id),
        reason,
      );
      for (const task of [...descendants].sort((a, b) => b.depth - a.depth)) {
        this.stopTask(
          task,
          `Ancestor task ${parent.id} was stopped.`,
          `ancestor task ${parent.id} stopped`,
        );
      }
    } finally {
      for (const task of descendants) this.cancellingTasks.delete(task.id);
    }
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
    if (notifier === undefined || task.executionMode === 'foreground') return;
    const notification = this.store
      .pendingNotifications(task.rootThreadId)
      .find((candidate) => candidate.taskId === task.id);
    if (
      notification !== undefined &&
      notifier(
        task.rootThreadId,
        notification.id,
        renderNotifications([{ notification, task }]),
      )
    ) {
      this.store.markNotificationsDelivered([notification.id]);
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

function createDeliveryGate(): DeliveryGate {
  let settled = false;
  let resolvePromise: (task: AgentTask) => void = () => undefined;
  const promise = new Promise<AgentTask>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(task) {
      if (settled) return;
      settled = true;
      resolvePromise(task);
    },
  };
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
        ...(notification.result === undefined
          ? []
          : [
              `  <result>${escapeXml(notification.result)}</result>`,
              `  <how-to-consume>${escapeXml(reportContract)}</how-to-consume>`,
            ]),
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

async function waitFor(
  completion: Promise<AgentTask>,
  waitMs: number,
  fallback: AgentTask,
): Promise<AgentTask> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<AgentTask>((resolve) => {
        timer = setTimeout(() => resolve(fallback), waitMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
