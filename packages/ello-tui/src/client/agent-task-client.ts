import type { AppServerClient } from '../api/client.js';
import type {
  AgentTaskDetail,
  AgentTaskEvent,
  AgentTaskSummary,
  AgentTaskTreeSnapshot,
} from '../api/protocol-types.js';

import { createSteerId } from './steer-id.js';

export type AgentTaskClientEvent =
  | { readonly type: 'snapshot'; readonly snapshot: AgentTaskTreeSnapshot }
  | { readonly type: 'task'; readonly task: AgentTaskSummary }
  | {
      readonly type: 'event';
      readonly taskId: string;
      readonly event: AgentTaskEvent;
    }
  | { readonly type: 'detail'; readonly detail: AgentTaskDetail }
  | {
      readonly type: 'stale';
      readonly expected: number;
      readonly actual: number;
    }
  | { readonly type: 'error'; readonly error: Error };

export type AgentTaskClientListener = (event: AgentTaskClientEvent) => void;

/** TUI 使用的子代理任务 facade，负责订阅序号校验、详情缓存和断线恢复。 */
export class AgentTaskClient {
  private tree: AgentTaskTreeSnapshot;
  private readonly details = new Map<string, AgentTaskDetail>();
  private readonly listeners = new Set<AgentTaskClientListener>();
  private readonly stopNotificationListener: () => void;
  private recoveryTask: Promise<void> | undefined;
  private closed = false;

  private constructor(
    private readonly server: AppServerClient,
    readonly rootThreadId: string,
  ) {
    this.tree = { rootThreadId, seq: 0, tasks: [] };
    this.stopNotificationListener = server.onNotification((notification) => {
      if (
        !notification.method.startsWith('agent/task/') ||
        !('rootThreadId' in notification.params) ||
        notification.params.rootThreadId !== this.rootThreadId
      ) {
        return;
      }
      if (notification.method === 'agent/task/removed') {
        this.acceptRootSequence(notification.params.seq);
        this.tree = {
          ...this.tree,
          tasks: this.tree.tasks.filter(
            (task) => task.taskId !== notification.params.taskId,
          ),
        };
        this.details.delete(notification.params.taskId);
        this.emit({ type: 'snapshot', snapshot: this.tree });
        return;
      }
      if (notification.method === 'agent/task/updated') {
        if (!this.acceptRootSequence(notification.params.seq)) return;
        this.upsertTask(notification.params.task);
        return;
      }
      if (notification.method === 'agent/task/event') {
        if (!this.acceptRootSequence(notification.params.seq)) return;
        if (notification.params.task !== undefined) {
          this.upsertTask(notification.params.task);
        }
        this.appendEvent(notification.params.taskId, notification.params.event);
      }
    });
  }

  /** 建立连接级订阅并返回已越过 snapshot barrier 的客户端。 */
  static async connect(
    server: AppServerClient,
    rootThreadId: string,
  ): Promise<AgentTaskClient> {
    const client = new AgentTaskClient(server, rootThreadId);
    try {
      client.tree = await server.request('agent/task/subscribe', {
        threadId: rootThreadId,
      });
      return client;
    } catch (error) {
      client.stopNotificationListener();
      throw error;
    }
  }

  get snapshot(): AgentTaskTreeSnapshot {
    return this.tree;
  }

  detail(taskId: string): AgentTaskDetail | undefined {
    return this.details.get(taskId);
  }

  subscribe(listener: AgentTaskClientListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async read(taskId: string): Promise<AgentTaskDetail> {
    const detail = await this.server.request('agent/task/read', {
      threadId: this.rootThreadId,
      taskId,
    });
    this.details.set(taskId, detail);
    this.emit({ type: 'detail', detail });
    return detail;
  }

  async steer(input: string, taskId: string, steerId = createSteerId()) {
    const result = await this.server.request('agent/task/steer', {
      threadId: this.rootThreadId,
      taskId,
      steerId,
      input,
    });
    this.upsertTask(result.task);
    return result.task;
  }

  async stop(taskId: string) {
    const result = await this.server.request('agent/task/stop', {
      threadId: this.rootThreadId,
      taskId,
    });
    this.upsertTask(result.task);
    return result.task;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopNotificationListener();
    this.listeners.clear();
    await this.server
      .request('agent/task/unsubscribe', { threadId: this.rootThreadId })
      .catch(() => undefined);
  }

  private acceptRootSequence(sequence: number): boolean {
    if (sequence < this.tree.seq) return false;
    if (sequence > this.tree.seq + 1) {
      this.emit({
        type: 'stale',
        expected: this.tree.seq + 1,
        actual: sequence,
      });
      void this.recover().catch(() => undefined);
      return false;
    }
    if (sequence === this.tree.seq + 1) {
      this.tree = { ...this.tree, seq: sequence };
    }
    return true;
  }

  private upsertTask(task: AgentTaskSummary): void {
    const index = this.tree.tasks.findIndex(
      (candidate) => candidate.taskId === task.taskId,
    );
    if (index >= 0) {
      const current = this.tree.tasks[index];
      if (current !== undefined && task.revision <= current.revision) return;
      const tasks = [...this.tree.tasks];
      tasks[index] = task;
      this.tree = { ...this.tree, tasks };
    } else {
      this.tree = { ...this.tree, tasks: [...this.tree.tasks, task] };
    }
    this.emit({ type: 'task', task });
  }

  private appendEvent(taskId: string, event: AgentTaskEvent): void {
    const detail = this.details.get(taskId);
    if (detail !== undefined) {
      const latest = detail.events.at(-1)?.sequence ?? 0;
      if (event.sequence <= latest) return;
      if (event.sequence !== latest + 1) {
        void this.read(taskId).catch((error: unknown) =>
          this.emit({ type: 'error', error: toError(error) }),
        );
        return;
      }
      this.details.set(taskId, {
        ...detail,
        events: [...detail.events, event],
      });
    }
    this.emit({ type: 'event', taskId, event });
  }

  private recover(): Promise<void> {
    if (this.recoveryTask !== undefined) return this.recoveryTask;
    this.recoveryTask = this.server
      .request('agent/task/subscribe', { threadId: this.rootThreadId })
      .then(async (snapshot) => {
        const tasks = new Map(
          snapshot.tasks.map((task) => [task.taskId, task]),
        );
        const staleDetails: string[] = [];
        for (const [taskId, detail] of this.details) {
          const task = tasks.get(taskId);
          if (task === undefined) {
            this.details.delete(taskId);
          } else if (task.eventSequence !== detail.task.eventSequence) {
            this.details.delete(taskId);
            staleDetails.push(taskId);
          }
        }
        this.tree = snapshot;
        this.emit({ type: 'snapshot', snapshot });
        await Promise.all(
          staleDetails.map((taskId) =>
            this.read(taskId).catch((error: unknown) =>
              this.emit({ type: 'error', error: toError(error) }),
            ),
          ),
        );
      })
      .catch((error: unknown) => {
        this.emit({ type: 'error', error: toError(error) });
        throw error;
      })
      .finally(() => {
        this.recoveryTask = undefined;
      });
    return this.recoveryTask;
  }

  private emit(event: AgentTaskClientEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
