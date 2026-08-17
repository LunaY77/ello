/**
 * 本文件提供子代理任务的 typed JSON-RPC 投影与连接级订阅。
 *
 * subscribe 先登记监听，再读取 Store 快照；ServerConnection 的 response barrier 会把期间产生的
 * notification 保留到响应之后，从而形成无空窗的 snapshot barrier。
 */
import type { RpcPeer, RpcRouteFragment } from '../../../server/rpc/route.js';
import { route } from '../../../server/rpc/route.js';

import {
  agentTaskDetail,
  agentTaskEvent,
  agentTaskSummary,
  agentTaskTreeSnapshot,
} from './task-projection.js';
import type { AgentTaskService } from './task-service.js';

type AgentTaskMethod =
  | 'agent/task/subscribe'
  | 'agent/task/unsubscribe'
  | 'agent/task/list'
  | 'agent/task/read'
  | 'agent/task/steer'
  | 'agent/task/stop';

/** 子代理公开任务投影，拥有 connection subscription 的释放职责。 */
export class AgentTaskRpcFeature {
  readonly routes: RpcRouteFragment<AgentTaskMethod>;
  private readonly subscriptions = new Map<string, Map<string, () => void>>();

  /**
   * 创建连接级任务投影；订阅释放由本实例统一管理。
   *
   * Args:
   * - `service`: 提供任务快照、控制操作和实时变化的运行服务。
   */
  constructor(private readonly service: AgentTaskService) {
    this.routes = {
      'agent/task/subscribe': route('read', (peer, params) => {
        this.subscribe(peer, params.threadId);
        return agentTaskTreeSnapshot(this.service.snapshot(params.threadId));
      }),
      'agent/task/unsubscribe': route('read', (peer, params) => {
        this.unsubscribe(peer.connectionId, params.threadId);
        return { ok: true };
      }),
      'agent/task/list': route('read', (_peer, params) =>
        agentTaskTreeSnapshot(this.service.snapshot(params.threadId)),
      ),
      'agent/task/read': route('read', (_peer, params) => {
        const detail = this.service.read(params.taskId, params.threadId);
        return agentTaskDetail(detail.task, detail.events);
      }),
      'agent/task/steer': route('submit', (_peer, params) => ({
        task: agentTaskSummary(
          this.service.steer(
            params.taskId,
            params.threadId,
            params.steerId,
            params.input,
          ),
        ),
      })),
      'agent/task/stop': route('write', async (_peer, params) => ({
        task: agentTaskSummary(
          await this.service.stop(params.taskId, params.threadId),
        ),
      })),
    };
  }

  /** 释放一条 RPC connection 的全部 Agent task 订阅。 */
  releaseConnection(connectionId: string): void {
    const roots = this.subscriptions.get(connectionId);
    if (roots === undefined) return;
    for (const stop of roots.values()) stop();
    this.subscriptions.delete(connectionId);
  }

  /** 关闭公开投影并释放全部订阅，不影响仍在运行的 task。 */
  close(): void {
    for (const roots of this.subscriptions.values()) {
      for (const stop of roots.values()) stop();
    }
    this.subscriptions.clear();
  }

  private subscribe(peer: RpcPeer, rootThreadId: string): void {
    const roots = this.subscriptions.get(peer.connectionId) ?? new Map();
    let delivery = Promise.resolve();
    roots.get(rootThreadId)?.();
    roots.set(
      rootThreadId,
      this.service.subscribe(rootThreadId, (change) => {
        const task = agentTaskSummary(change.task);
        const event = agentTaskEvent(change.event);
        delivery = delivery
          .then(() =>
            peer.notify({
              method: 'agent/task/event',
              params: {
                rootThreadId,
                seq: change.event.rootSequence,
                taskId: change.task.id,
                task,
                event,
              },
            }),
          )
          .catch(() => undefined);
      }),
    );
    this.subscriptions.set(peer.connectionId, roots);
  }

  private unsubscribe(connectionId: string, rootThreadId: string): void {
    const roots = this.subscriptions.get(connectionId);
    if (roots === undefined) return;
    roots.get(rootThreadId)?.();
    roots.delete(rootThreadId);
    if (roots.size === 0) this.subscriptions.delete(connectionId);
  }
}
