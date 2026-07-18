import type { CodingSession } from '../runtime/index.js';

import type { OverlayState } from './component/OverlayHost.js';

export async function loadTasksOverlay(
  session: CodingSession,
): Promise<OverlayState> {
  return { type: 'tasks', tasks: session.listTasks() };
}
