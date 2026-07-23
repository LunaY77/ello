/**
 * 本文件负责 thread feature 的通知投影。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type {
  ServerNotification,
  ThreadSnapshot,
} from '../../protocol/v1/index.js';
import type { ThreadRecord } from '../../storage/threads/thread-record.js';

/**
 * 将 append-only ThreadRecord 映射为客户端可见通知，并保留公开 seq 连续性。
 *
 * Args:
 * - `record`: 要由 `notificationsFor` 读取或写入的单个领域值；所有权仍归调用方。
 * - `snapshot`: `notificationsFor` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 */
export function notificationsFor(
  record: ThreadRecord,
  snapshot: ThreadSnapshot,
): readonly ServerNotification[] {
  switch (record.kind) {
    case 'thread.created':
      return [
        {
          method: 'thread/started',
          params: {
            threadId: record.threadId,
            seq: record.seq,
            thread: snapshot.thread,
          },
        },
      ];
    case 'thread.status':
      return [
        {
          method: 'thread/status/changed',
          params: {
            threadId: record.threadId,
            seq: record.seq,
            status: record.status,
            activeFlags: record.activeFlags,
          },
        },
      ];
    case 'thread.metadata':
      if (record.settings !== undefined) {
        return [
          {
            method: 'thread/settings/updated',
            params: {
              threadId: record.threadId,
              seq: record.seq,
              settings: record.settings,
            },
          },
        ];
      }
      if (record.name !== undefined) {
        return [
          {
            method: 'thread/name/updated',
            params: {
              threadId: record.threadId,
              seq: record.seq,
              name: record.name,
            },
          },
        ];
      }
      return [sequenceAdvanced(record)];
    case 'thread.archived':
      return [
        {
          method: 'thread/archived',
          params: { threadId: record.threadId, seq: record.seq },
        },
      ];
    case 'thread.unarchived':
      return [
        {
          method: 'thread/unarchived',
          params: {
            threadId: record.threadId,
            seq: record.seq,
            thread: snapshot.thread,
          },
        },
      ];
    case 'turn.started':
      return [
        {
          method: 'turn/started',
          params: {
            threadId: record.threadId,
            turnId: record.turn.id,
            seq: record.seq,
            turn: record.turn,
          },
        },
      ];
    case 'turn.completed':
    case 'turn.interrupted':
    case 'turn.failed':
      return [
        {
          method: 'turn/completed',
          params: {
            threadId: record.threadId,
            turnId: record.turn.id,
            seq: record.seq,
            turn:
              snapshot.turns.find((turn) => turn.id === record.turn.id) ??
              record.turn,
          },
        },
      ];
    case 'item.started':
      return [
        {
          method: 'item/started',
          params: {
            threadId: record.threadId,
            turnId: record.turnId,
            itemId: record.item.id,
            seq: record.seq,
            item: record.item,
          },
        },
      ];
    case 'item.completed':
      return [
        {
          method: 'item/completed',
          params: {
            threadId: record.threadId,
            turnId: record.turnId,
            itemId: record.item.id,
            seq: record.seq,
            item: record.item,
          },
        },
      ];
    case 'item.delta': {
      const base = {
        threadId: record.threadId,
        turnId: record.turnId,
        itemId: record.itemId,
        seq: record.seq,
      };
      switch (record.delta.type) {
        case 'agentMessage':
          return [
            {
              method: 'item/agentMessage/delta',
              params: { ...base, delta: record.delta.text },
            },
          ];
        case 'plan':
          return [
            {
              method: 'item/plan/delta',
              params: { ...base, delta: record.delta.text },
            },
          ];
        case 'commandOutput':
          return [
            {
              method: 'item/commandExecution/outputDelta',
              params: {
                ...base,
                stream: record.delta.stream,
                delta: record.delta.text,
              },
            },
          ];
        default:
          record.delta satisfies never;
          throw new Error(`Unhandled item delta: ${String(record.delta)}`);
      }
    }
    case 'goal.state':
      return record.goal === null
        ? [
            {
              method: 'thread/goal/cleared',
              params: {
                threadId: record.threadId,
                seq: record.seq,
                goalId: record.goalId ?? `${record.threadId}:goal`,
              },
            },
          ]
        : [
            {
              method: 'thread/goal/updated',
              params: {
                threadId: record.threadId,
                seq: record.seq,
                goal: record.goal,
              },
            },
          ];
    case 'serverRequest.resolved': {
      return [
        {
          method: 'serverRequest/resolved',
          params: {
            threadId: record.threadId,
            turnId: record.turnId,
            itemId: record.itemId,
            requestId: record.requestId,
            seq: record.seq,
          },
        },
      ];
    }
    case 'usage.updated':
      return [
        {
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: record.threadId,
            seq: record.seq,
            usage: record.usage,
          },
        },
      ];
    case 'plan.state':
      return [
        {
          method: 'thread/plan/updated',
          params: {
            threadId: record.threadId,
            seq: record.seq,
            plan: record.plan,
          },
        },
      ];
    case 'compaction':
      return [
        {
          method: 'thread/compaction/updated',
          params: {
            threadId: record.threadId,
            turnId: record.turnId,
            seq: record.seq,
            summary: record.summary,
            firstKeptSeq: record.firstKeptSeq,
            tokensBefore: record.tokensBefore,
          },
        },
      ];
    case 'transcript.entry':
    case 'content.replacement':
    case 'serverRequest.created':
      // 这些记录属于 Server 内部事实，不向 Client 暴露内容；仍必须推进公开 seq，
      // 否则下一条可见事件会被严格 reducer 误判为 transport 丢包。
      return [sequenceAdvanced(record)];
    default:
      record satisfies never;
      throw new Error(`Unhandled thread record: ${String(record)}`);
  }
}

function sequenceAdvanced(record: ThreadRecord): ServerNotification {
  return {
    method: 'thread/sequence/advanced',
    params: { threadId: record.threadId, seq: record.seq },
  };
}
