import type { CodingAgentConfig } from '../config/index.js';

import type { OverlayState } from './component/OverlayHost.js';

export async function loadTasksOverlay(): Promise<OverlayState> {
  const { createTaskService } = await import('../tasks/index.js');
  return { type: 'tasks', tasks: await createTaskService().list() };
}

export async function loadSkillsOverlay(
  config: CodingAgentConfig,
): Promise<OverlayState> {
  const { loadCodingSkills } = await import('../skills/index.js');
  return { type: 'skills', skills: await loadCodingSkills(config) };
}

export async function loadWorkspaceOverlay(): Promise<OverlayState> {
  const { WorkspaceStore } = await import('../workspace/index.js');
  return { type: 'workspace', workspaces: await new WorkspaceStore().list() };
}
