import type { ClientResult } from '@ello/agent/protocol';

import { dispatchStoreEvent, getAppClient } from '@/client/session';

export async function refreshTasks(): Promise<void> {
  const tasks: Array<ClientResult<'task/list'>['data'][number]> = [];
  let cursor: string | undefined;
  do {
    const page = await getAppClient().request(
      'task/list',
      cursor === undefined ? {} : { cursor },
    );
    tasks.push(...page.data);
    if (cursor !== undefined && page.nextCursor === cursor) {
      throw new Error(`App Server returned a repeated task list cursor ${cursor}.`);
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  dispatchStoreEvent({ kind: 'tasks-listed', tasks, reset: true });
}

export async function setTaskStatus(
  taskId: string,
  status: 'pending' | 'inProgress' | 'completed' | 'cancelled',
): Promise<void> {
  const result = await getAppClient().request('task/update', { id: taskId, status });
  dispatchStoreEvent({ kind: 'task-upserted', task: result.task });
}

export async function claimTask(taskId: string, owner: string): Promise<void> {
  const result = await getAppClient().request('task/claim', { id: taskId, owner });
  dispatchStoreEvent({ kind: 'task-upserted', task: result.task });
}
