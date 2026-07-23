import { dispatchStoreEvent, getAppClient } from '@/client/session';
import { useAppStore } from '@/store/store';
import type { CatalogEntry } from '@/store/types';

export type SkillEntry = CatalogEntry;

/** skills 目录读取的 cwd 解析顺序:当前会话 → 当前工作区 → 纯聊天目录。 */
export function resolveSkillsCwd(): string | null {
  const state = useAppStore.getState();
  const threadId = state.view.selectedThreadId;
  if (threadId !== null) {
    const thread = state.entities.threads[threadId];
    if (thread !== undefined) return thread.cwd;
  }
  const workspaceId = state.view.selectedWorkspaceId;
  if (workspaceId !== null) {
    const workspace = state.entities.workspaces[workspaceId];
    if (workspace !== undefined) return workspace.rootPath;
  }
  return state.preferences.lastChatCwd;
}

export async function refreshSkills(cwd: string): Promise<void> {
  const result = await getAppClient().request('skills/list', { cwd });
  dispatchStoreEvent({ kind: 'catalog-loaded', catalog: 'skills', entries: result.data });
}

export async function reloadSkills(cwd: string): Promise<void> {
  const result = await getAppClient().request('skills/reload', { cwd });
  dispatchStoreEvent({ kind: 'catalog-loaded', catalog: 'skills', entries: result.data });
}

export async function getSkill(cwd: string, name: string): Promise<SkillEntry> {
  const result = await getAppClient().request('skills/get', { cwd, name });
  return result.skill;
}
