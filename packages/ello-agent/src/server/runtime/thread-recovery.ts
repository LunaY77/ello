import { projectThreadSnapshot } from '../../domain/projection/thread-snapshot.js';
import type {
  ThreadItem,
  ThreadSnapshot,
  Turn,
} from '../../protocol/v1/index.js';
import { ThreadLeaseStore } from '../../storage/threads/thread-lease.js';
import { ThreadLogRepository } from '../../storage/threads/thread-log.js';

/**
 * Server 启动时只恢复可持久化事实：未完成 turn/item 标记 interrupted，旧 HTTP
 * stream、子进程和 AbortController 一律不猜测恢复。
 */
export async function recoverInterruptedThreads(options: {
  readonly logs: ThreadLogRepository;
  readonly leases: ThreadLeaseStore;
}): Promise<ReadonlySet<string>> {
  const activeThreadIds = new Set<string>();
  const threadIds = await options.logs.listThreadIds(false);
  for (const threadId of threadIds) {
    const lease = await options.leases.tryAcquire(threadId);
    if (lease === undefined) {
      activeThreadIds.add(threadId);
      continue;
    }
    try {
      const snapshot = projectThreadSnapshot(await options.logs.read(threadId));
      const preview = recoverablePreview(snapshot);
      if (preview !== undefined) {
        await options.logs.append(threadId, {
          kind: 'thread.metadata',
          preview,
        });
      }
      const activeTurns = snapshot.turns.filter(
        (turn) => turn.status === 'inProgress',
      );
      for (const turn of activeTurns) {
        for (const item of turn.items) {
          const interrupted = interruptItem(item);
          if (interrupted === null) continue;
          await options.logs.append(threadId, {
            kind: 'item.completed',
            turnId: turn.id,
            item: interrupted,
          });
        }
        await options.logs.append(threadId, {
          kind: 'turn.interrupted',
          turn: interruptedTurn(turn),
          reason: 'server restarted before the turn reached a terminal state',
        });
      }
      for (const request of snapshot.pendingServerRequests) {
        await options.logs.append(threadId, {
          kind: 'serverRequest.resolved',
          requestId: request.id,
          turnId: request.turnId,
          itemId: request.itemId,
          resolution: 'cancelledByRestart',
        });
      }
      if (activeTurns.length > 0 || snapshot.pendingServerRequests.length > 0) {
        await options.logs.append(threadId, {
          kind: 'thread.status',
          status: 'interrupted',
          activeFlags: [],
        });
      }
    } finally {
      await lease.release();
    }
  }
  return activeThreadIds;
}

function recoverablePreview(snapshot: ThreadSnapshot): string | undefined {
  if (snapshot.thread.preview.trim() !== '') return undefined;
  for (const turn of snapshot.turns) {
    const message = turn.items.find((item) => item.type === 'userMessage');
    if (message?.type !== 'userMessage') continue;
    const preview = message.text.trim().replace(/\s+/gu, ' ').slice(0, 500);
    if (preview !== '') return preview;
  }
  return undefined;
}

function interruptedTurn(turn: Turn): Turn {
  return {
    ...turn,
    status: 'interrupted',
    items: [],
    completedAt: new Date().toISOString(),
    errorCode: 'SERVER_RESTARTED',
  };
}

function interruptItem(item: ThreadItem): ThreadItem | null {
  switch (item.type) {
    case 'userMessage':
    case 'notice':
    case 'error':
      return null;
    case 'agentMessage':
    case 'reasoning':
    case 'plan':
    case 'commandExecution':
    case 'fileChange':
    case 'toolCall':
    case 'subagent':
    case 'contextCompaction':
      return item.status === 'inProgress'
        ? { ...item, status: 'failed' }
        : null;
  }
}
