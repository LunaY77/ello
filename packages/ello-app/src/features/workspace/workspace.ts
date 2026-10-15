import { dispatchStoreEvent, getAppClient } from '@/client/session';
import { startThread } from '@/features/thread';
import { appMutations, useAppStore } from '@/store/store';
import type { WorkspaceKind } from '@/store/types';

const { toggleWorkspaceContext } = appMutations;

export async function refreshWorkspaces(): Promise<void> {
  const result = await getAppClient().request('workspace/list', {});
  dispatchStoreEvent({ kind: 'workspaces-listed', workspaces: result.data });
}

export async function createWorkspace(options: {
  readonly kind: WorkspaceKind;
  readonly name: string;
  readonly repos: readonly string[];
}): Promise<string> {
  const result = await getAppClient().request('workspace/create', {
    kind: options.kind,
    name: options.name,
    repos: [...options.repos],
  });
  await refreshWorkspaces();
  // 任务流打通:创建后立即在该工作区开会话,直达聊天(selectThread 会同步选中工作区)。
  await startThread({
    cwd: result.workspace.rootPath,
    name: `${options.kind}/${options.name}`,
  });
  return result.workspace.id;
}

/** 注册本地 git 仓库到 registry;注册后刷新仓库列表供工作区勾选。 */
export async function addRepo(options: {
  readonly key: string;
  readonly source: string;
}): Promise<void> {
  await getAppClient().request('repo/add', {
    key: options.key,
    source: options.source,
  });
  await refreshRepos();
}

export async function archiveWorkspace(workspaceId: string): Promise<void> {
  await getAppClient().request('workspace/archive', { workspace: workspaceId });
  await refreshWorkspaces();
  const state = useAppStore.getState();
  if (state.view.selectedWorkspaceId === workspaceId) {
    toggleWorkspaceContext(workspaceId);
  }
}

export async function refreshRepos(): Promise<void> {
  const result = await getAppClient().request('repo/list', {});
  dispatchStoreEvent({ kind: 'repos-listed', repos: result.data });
}
