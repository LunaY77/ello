import { dispatchStoreEvent, getAppClient } from '@/client/session';
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
  toggleWorkspaceContext(result.workspace.id);
  return result.workspace.id;
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
