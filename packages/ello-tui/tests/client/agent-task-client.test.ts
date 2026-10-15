import { describe, expect, it, vi } from 'vitest';

import type { AppServerClient } from '../../src/api/client.js';
import type {
  AgentTaskDetail,
  AgentTaskEvent,
  AgentTaskSummary,
  AgentTaskTreeSnapshot,
  ServerNotification,
} from '../../src/api/protocol-types.js';
import { AgentTaskClient } from '../../src/client/agent-task-client.js';

const createdAt = '2026-07-29T00:00:00.000Z';

describe('AgentTaskClient', () => {
  it('以 snapshot barrier 建立订阅，并按双重序号合并任务与 transcript', async () => {
    const server = new TaskServer(snapshot(0, []));
    const client = await AgentTaskClient.connect(
      server as unknown as AppServerClient,
      'thr_root',
    );
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));

    server.emit(taskEventNotification(1, taskEvent(1, 1), summary(1)));

    expect(client.snapshot.seq).toBe(1);
    expect(client.snapshot.tasks).toEqual([summary(1)]);
    expect(events).toEqual(['task', 'event']);

    server.detail = detail(summary(1), [taskEvent(1, 1)]);
    await client.read('job_child');
    server.emit(taskEventNotification(2, taskEvent(2, 2), summary(2)));

    expect(client.detail('job_child')?.events).toHaveLength(2);
    expect(client.detail('job_child')?.events.at(-1)?.sequence).toBe(2);
    await client.close();
  });

  it('root seq 出现缺口时只启动一次重新订阅', async () => {
    const server = new TaskServer(snapshot(1, [summary(1)]));
    const client = await AgentTaskClient.connect(
      server as unknown as AppServerClient,
      'thr_root',
    );
    server.subscribeResult = snapshot(5, [summary(5)]);

    server.emit(updated(4, summary(4)));
    server.emit(updated(6, summary(6)));

    await vi.waitFor(() => expect(client.snapshot.seq).toBe(5));
    expect(
      server.requests.filter(([method]) => method === 'agent/task/subscribe'),
    ).toHaveLength(2);
    await client.close();
  });

  it('root seq 恢复会清理已删除详情并刷新 event sequence 变化的缓存', async () => {
    const server = new TaskServer(snapshot(1, [summary(1)]));
    const client = await AgentTaskClient.connect(
      server as unknown as AppServerClient,
      'thr_root',
    );
    server.detail = detail(summary(1), [taskEvent(1, 1)]);
    await client.read('job_child');

    server.detail = detail(summary(5), [
      taskEvent(1, 1),
      taskEvent(2, 2),
      taskEvent(3, 3),
      taskEvent(4, 4),
      taskEvent(5, 5),
    ]);
    server.subscribeResult = snapshot(5, [summary(5)]);
    server.emit(updated(4, summary(4)));

    await vi.waitFor(() =>
      expect(client.detail('job_child')?.task.eventSequence).toBe(5),
    );
    expect(
      server.requests.filter(([method]) => method === 'agent/task/read'),
    ).toHaveLength(2);

    server.subscribeResult = snapshot(9, []);
    server.emit(updated(8, summary(8)));
    await vi.waitFor(() => expect(client.snapshot.seq).toBe(9));
    expect(client.detail('job_child')).toBeUndefined();
    await client.close();
  });

  it('控制操作始终携带 root thread 边界', async () => {
    const server = new TaskServer(snapshot(0, [summary(1)]));
    const client = await AgentTaskClient.connect(
      server as unknown as AppServerClient,
      'thr_root',
    );

    await client.steer('继续', 'job_child', 'steer_fixture');
    await client.stop('job_child');

    expect(server.requests).toContainEqual([
      'agent/task/steer',
      {
        threadId: 'thr_root',
        taskId: 'job_child',
        steerId: 'steer_fixture',
        input: '继续',
      },
    ]);
    expect(server.requests).toContainEqual([
      'agent/task/stop',
      { threadId: 'thr_root', taskId: 'job_child' },
    ]);
    await client.close();
  });
});

class TaskServer {
  readonly requests: Array<readonly [string, unknown]> = [];
  readonly listeners = new Set<(notification: ServerNotification) => void>();
  subscribeResult: AgentTaskTreeSnapshot;
  detail: AgentTaskDetail = detail(summary(1), []);

  constructor(initial: AgentTaskTreeSnapshot) {
    this.subscribeResult = initial;
  }

  onNotification(listener: (notification: ServerNotification) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(method: string, params: unknown): Promise<unknown> {
    this.requests.push([method, params]);
    if (method === 'agent/task/subscribe') {
      return Promise.resolve(this.subscribeResult);
    }
    if (method === 'agent/task/read') return Promise.resolve(this.detail);
    if (method === 'agent/task/unsubscribe')
      return Promise.resolve({ ok: true });
    if (method === 'agent/task/stop' || method === 'agent/task/steer') {
      return Promise.resolve({ task: summary(2) });
    }
    throw new Error(`Unexpected task request ${method}.`);
  }

  emit(notification: ServerNotification): void {
    for (const listener of this.listeners) listener(notification);
  }
}

function summary(revision: number): AgentTaskSummary {
  return {
    taskId: 'job_child',
    agentId: 'agent_child',
    rootThreadId: 'thr_root',
    definitionName: 'explore',
    description: '检查实现',
    status: 'running',
    cwd: '/workspace',
    isolation: 'shared',
    revision,
    eventSequence: revision,
    toolCount: 0,
    recentTools: [],
    createdAt,
    startedAt: createdAt,
    updatedAt: createdAt,
  };
}

function taskEvent(sequence: number, rootSequence: number): AgentTaskEvent {
  return {
    rootThreadId: 'thr_root',
    taskId: 'job_child',
    sequence,
    rootSequence,
    eventType: 'messageCompleted',
    payload: { messageId: `message_${sequence}`, text: `结果 ${sequence}` },
    createdAt,
  };
}

function snapshot(
  seq: number,
  tasks: readonly AgentTaskSummary[],
): AgentTaskTreeSnapshot {
  return { rootThreadId: 'thr_root', seq, tasks };
}

function detail(
  task: AgentTaskSummary,
  events: readonly AgentTaskEvent[],
): AgentTaskDetail {
  return {
    task,
    taskPacket: {
      objective: '检查实现',
      scope: '/workspace',
      knownFacts: [],
      constraints: [],
      expectedOutcome: '返回分析结果',
      acceptanceEvidence: ['包含证据'],
    },
    events,
  };
}

function updated(seq: number, task: AgentTaskSummary): ServerNotification {
  return {
    method: 'agent/task/updated',
    params: { rootThreadId: 'thr_root', seq, task },
  };
}

function taskEventNotification(
  seq: number,
  event: AgentTaskEvent,
  task?: AgentTaskSummary,
): ServerNotification {
  return {
    method: 'agent/task/event',
    params: {
      rootThreadId: 'thr_root',
      seq,
      taskId: event.taskId,
      ...(task === undefined ? {} : { task }),
      event,
    },
  };
}
