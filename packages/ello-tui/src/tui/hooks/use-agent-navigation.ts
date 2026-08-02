import type { Dispatch, SetStateAction } from 'react';

import type { AgentTaskSummary } from '../../api/protocol-types.js';
import type { ThreadClient } from '../../client/thread-client.js';
import type { OverlayState } from '../component/OverlayHost.js';

import type { useAgentTasks } from './use-agent-tasks.js';
import { useStableInput } from './use-stable-input.js';

interface AgentNavigationOptions {
  readonly thread: ThreadClient;
  readonly agentTasks: ReturnType<typeof useAgentTasks>;
  readonly visibleTasks: readonly AgentTaskSummary[];
  readonly overlay: OverlayState;
  readonly running: boolean;
  readonly setOverlay: Dispatch<SetStateAction<OverlayState>>;
  onError(error: unknown): void;
}

/** 统一处理 Agent switcher 的焦点、导航和任务快捷键。 */
export function useAgentNavigation({
  thread,
  agentTasks,
  visibleTasks,
  overlay,
  running,
  setOverlay,
  onError,
}: AgentNavigationOptions): void {
  useStableInput((input, key) => {
    if (key.escape) {
      if (overlay.type !== 'none') {
        setOverlay({ type: 'none' });
      } else if (agentTasks.focus === 'agent-switcher') {
        agentTasks.setFocus('composer');
      } else if (agentTasks.activeView.kind === 'task') {
        agentTasks.returnToParent();
      } else if (running) {
        void thread.interrupt('user interrupted from TUI').catch(onError);
      }
      return;
    }
    if (overlay.type !== 'none') return;

    if (key.ctrl && input === 'b') {
      const task = agentTasks.activeTask;
      if (
        task !== undefined &&
        task.status === 'running' &&
        task.executionMode === 'foreground'
      ) {
        void agentTasks.client?.background(task.taskId).catch(onError);
      }
      return;
    }
    if (agentTasks.focus !== 'agent-switcher') return;

    const visibleTaskIds = ['main', ...visibleTasks.map((task) => task.taskId)];
    const highlightedTaskId = visibleTaskIds.includes(
      agentTasks.highlightedTaskId,
    )
      ? agentTasks.highlightedTaskId
      : 'main';

    if (key.upArrow) {
      moveHighlight(
        visibleTaskIds,
        highlightedTaskId,
        -1,
        agentTasks.setHighlightedTaskId,
      );
      return;
    }
    if (key.downArrow) {
      moveHighlight(
        visibleTaskIds,
        highlightedTaskId,
        1,
        agentTasks.setHighlightedTaskId,
      );
      return;
    }
    if (input === '\u001b[H') {
      agentTasks.setHighlightedTaskId('main');
      return;
    }
    if (input === '\u001b[F') {
      agentTasks.setHighlightedTaskId(visibleTasks.at(-1)?.taskId ?? 'main');
      return;
    }
    if (key.return) {
      agentTasks.activate(highlightedTaskId);
      return;
    }
    if (input !== 'x') return;

    const task = visibleTasks.find(
      (candidate) => candidate.taskId === highlightedTaskId,
    );
    if (
      task !== undefined &&
      (task.status === 'running' || task.status === 'queued')
    ) {
      void agentTasks.client?.stop(task.taskId).catch(onError);
    }
  });
}

function moveHighlight(
  taskIds: readonly string[],
  highlightedTaskId: string,
  delta: number,
  setHighlightedTaskId: (taskId: string) => void,
): void {
  const index = taskIds.indexOf(highlightedTaskId);
  const next = Math.max(0, Math.min(taskIds.length - 1, index + delta));
  setHighlightedTaskId(taskIds[next] ?? 'main');
}
