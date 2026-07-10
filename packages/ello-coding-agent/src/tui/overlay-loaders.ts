import type { CodingAgentConfig } from '../config/index.js';

import type { OverlayState } from './component/OverlayHost.js';

export async function loadTasksOverlay(): Promise<OverlayState> {
  const [{ withCodingStorage }, { createTaskService }] = await Promise.all([
    import('../storage/index.js'),
    import('../tasks/index.js'),
  ]);
  const tasks = await withCodingStorage((storage) =>
    createTaskService(storage.tasks).list(),
  );
  return { type: 'tasks', tasks };
}

export async function loadSkillsOverlay(
  config: CodingAgentConfig,
): Promise<OverlayState> {
  const { loadCodingSkills } = await import('../skills/index.js');
  return { type: 'skills', skills: await loadCodingSkills(config) };
}

export async function loadWorkspaceOverlay(): Promise<OverlayState> {
  const [{ withCodingStorage }, { WorkspaceStore }] = await Promise.all([
    import('../storage/index.js'),
    import('../workspace/index.js'),
  ]);
  const workspaces = await withCodingStorage((storage) =>
    new WorkspaceStore(storage.workspaces).list(),
  );
  return { type: 'workspace', workspaces };
}
