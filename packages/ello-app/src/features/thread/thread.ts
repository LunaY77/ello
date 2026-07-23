/**
 * Thread 域动作:打开/新建/发送/打断/归档/删除。
 * 动作只调用 typed Client;Server 投影一律由 result 快照或事件流经
 * event-reducer 写入,动作不直接改实体字段。
 */
import type {
  SessionMode,
  ThreadSnapshot,
  Turn,
  UserInput,
} from '@ello/agent/protocol';

import { dispatchStoreEvent } from '@/client/session';
import { getAppClient } from '@/client/session';
import { pickDirectory } from '@/lib/tauri/bridge';
import { appMutations, useAppStore } from '@/store/store';
import type { AppState } from '@/store/types';

const openingThreads = new Set<string>();
const { clearSelectedThread, selectThread, setLastChatCwd } = appMutations;

/** 打开 Thread:未加载则 resume + subscribe 取得完整快照;工作区展示上下文按 cwd 派生。 */
export async function openThread(threadId: string): Promise<void> {
  const state = useAppStore.getState();
  const summary = state.entities.threads[threadId];
  if (summary === undefined) {
    throw new Error(`Thread ${threadId} is not in the loaded list.`);
  }
  if (summary.archived) {
    throw new Error(`Thread ${threadId} must be unarchived before opening.`);
  }
  selectThread(threadId);
  if (state.entities.snapshots[threadId] !== undefined) return;
  if (openingThreads.has(threadId)) return;
  openingThreads.add(threadId);
  try {
    const snapshot = await getAppClient().request('thread/resume', {
      threadId,
      subscribe: true,
    });
    dispatchStoreEvent({ kind: 'snapshot-loaded', snapshot });
  } finally {
    openingThreads.delete(threadId);
  }
}

export interface StartThreadOptions {
  readonly cwd: string;
  readonly name?: string;
  readonly mode?: SessionMode;
}

/** 在明确 cwd 中新建独立 Thread 并选中。 */
export async function startThread(
  options: StartThreadOptions,
): Promise<string> {
  const snapshot = await getAppClient().request('thread/start', {
    cwd: options.cwd,
    subscribe: true,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  });
  dispatchStoreEvent({ kind: 'snapshot-loaded', snapshot });
  selectThread(snapshot.thread.id);
  return snapshot.thread.id;
}

/**
 * 在当前上下文新建会话:选中工作区时使用其执行目录;
 * 未选中时创建纯聊天,工作目录取上次选择,首次经系统目录选择器确定。
 */
export async function newThreadInContext(): Promise<string | null> {
  const state = useAppStore.getState();
  const workspaceId = state.view.selectedWorkspaceId;
  if (workspaceId !== null) {
    const workspace = state.entities.workspaces[workspaceId];
    if (workspace === undefined) {
      throw new Error(`Selected workspace ${workspaceId} is not loaded.`);
    }
    return startThread({ cwd: workspace.rootPath });
  }
  let cwd = state.preferences.lastChatCwd;
  if (cwd === null) {
    cwd = await pickDirectory('选择纯聊天的工作目录');
    if (cwd === null) return null;
    setLastChatCwd(cwd);
  }
  return startThread({ cwd });
}

/** 发送新回合;turn 实体经 turn/started 事件到达,这里只返回 turnId。 */
export async function sendTurn(
  threadId: string,
  input: readonly UserInput[],
): Promise<string> {
  const result = await getAppClient().request('turn/start', {
    threadId,
    input,
  });
  return result.turn.id;
}

/** 运行中插队(steer);expectedTurnId 必须是当前活跃 turn。 */
export async function steerTurn(
  threadId: string,
  input: readonly UserInput[],
): Promise<void> {
  const snapshot = useAppStore.getState().entities.snapshots[threadId];
  const activeTurn = snapshot?.turns.findLast(
    (turn) => turn.status === 'inProgress',
  );
  if (activeTurn === undefined) {
    throw new Error('Thread has no active turn to steer.');
  }
  await getAppClient().request('turn/steer', {
    threadId,
    expectedTurnId: activeTurn.id,
    input,
  });
}

/** 打断当前活跃回合。 */
export async function interruptActiveTurn(threadId: string): Promise<void> {
  const snapshot = useAppStore.getState().entities.snapshots[threadId];
  const activeTurn = snapshot?.turns.findLast(
    (turn) => turn.status === 'inProgress',
  );
  if (activeTurn === undefined) {
    throw new Error('Thread has no active turn to interrupt.');
  }
  await getAppClient().request('turn/interrupt', {
    threadId,
    turnId: activeTurn.id,
  });
}

export async function archiveThread(threadId: string): Promise<void> {
  const result = await getAppClient().request('thread/archive', { threadId });
  dispatchStoreEvent({ kind: 'thread-upserted', thread: result.thread });
  if (useAppStore.getState().view.selectedThreadId === threadId) {
    clearSelectedThread();
  }
}

export async function unarchiveThread(threadId: string): Promise<void> {
  const result = await getAppClient().request('thread/unarchive', { threadId });
  dispatchStoreEvent({ kind: 'thread-upserted', thread: result.thread });
}

/** 派生分支继承源 Thread 的执行目录。 */
export async function forkThread(threadId: string): Promise<string> {
  const snapshot = await getAppClient().request('thread/fork', {
    threadId,
    subscribe: true,
  });
  dispatchStoreEvent({ kind: 'snapshot-loaded', snapshot });
  selectThread(snapshot.thread.id);
  return snapshot.thread.id;
}

/** 删除是不可逆操作;确认在 UI 层完成。删除后清空选中。 */
export async function deleteThread(threadId: string): Promise<void> {
  await getAppClient().request('thread/delete', { threadId });
  dispatchStoreEvent({ kind: 'thread-removed', threadId });
  const state = useAppStore.getState();
  if (state.view.selectedThreadId === threadId) {
    clearSelectedThread();
  }
}

/** 切换会话模式(plan / ask-before-changes / accept-edits / bypass)。 */
export async function setThreadMode(
  threadId: string,
  mode: SessionMode,
): Promise<void> {
  await getAppClient().request('thread/settings/update', { threadId, mode });
}

/** 切换模型。 */
export async function setThreadModel(
  threadId: string,
  model: string,
): Promise<void> {
  await getAppClient().request('thread/settings/update', { threadId, model });
}

export function selectActiveTurn(snapshot: ThreadSnapshot): Turn | undefined {
  return snapshot.turns.findLast((turn) => turn.status === 'inProgress');
}

/** 当前是否允许提交新回合:连接就绪且快照已加载。 */
export function selectCanSubmit(state: AppState, threadId: string): boolean {
  const snapshot = state.entities.snapshots[threadId];
  return (
    state.connection.phase === 'ready' &&
    snapshot !== undefined &&
    !snapshot.thread.archived
  );
}

export function threadDisplayName(
  summary: { readonly name: string; readonly preview: string } | undefined,
): string {
  if (summary === undefined) return '新会话';
  if (summary.name !== '') return summary.name;
  if (summary.preview !== '') return summary.preview;
  return '新会话';
}
