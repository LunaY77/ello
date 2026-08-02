import { useCallback, useEffect, useState } from 'react';

import type {
  AgentTaskDetail,
  AgentTaskSummary,
  AgentTaskTreeSnapshot,
} from '../../api/protocol-types.js';
import type { AgentTaskClient } from '../../client/agent-task-client.js';
import type { ThreadClient } from '../../client/thread-client.js';

import { clearTerminalScrollback } from './use-runtime-events.js';

export type ActiveAgentView =
  | { readonly kind: 'main'; readonly threadId: string }
  | {
      readonly kind: 'task';
      readonly rootThreadId: string;
      readonly taskId: string;
    };

export type AgentInputFocus = 'composer' | 'agent-switcher';

const EMPTY_TREE: AgentTaskTreeSnapshot = {
  rootThreadId: '',
  seq: 0,
  tasks: [],
};

/** 管理 TUI 本地 Agent 视图、选择焦点和 task detail 缓存。 */
export function useAgentTasks(
  thread: ThreadClient,
  onError: (error: unknown) => void,
  onTaskTerminal: (task: AgentTaskSummary) => void,
) {
  const [client, setClient] = useState<AgentTaskClient>();
  const [tree, setTree] = useState<AgentTaskTreeSnapshot>({
    ...EMPTY_TREE,
    rootThreadId: thread.threadId,
  });
  const [details, setDetails] = useState<ReadonlyMap<string, AgentTaskDetail>>(
    new Map(),
  );
  const [activeView, setActiveView] = useState<ActiveAgentView>({
    kind: 'main',
    threadId: thread.threadId,
  });
  const [focus, setFocus] = useState<AgentInputFocus>('composer');
  const [highlightedTaskId, setHighlightedTaskId] = useState<'main' | string>(
    'main',
  );
  const [viewEpoch, setViewEpoch] = useState(0);

  useEffect(() => {
    let disposed = false;
    let activeClient: AgentTaskClient | undefined;
    let stopClientListener: (() => void) | undefined;
    void thread
      .createAgentTaskClient()
      .then((created) => {
        if (disposed) return created.close();
        activeClient = created;
        setClient(created);
        setTree(created.snapshot);
        for (const task of created.snapshot.tasks) {
          if (isTerminalTask(task)) onTaskTerminal(task);
        }
        stopClientListener = created.subscribe((event) => {
          if (event.type === 'snapshot') setTree(event.snapshot);
          if (event.type === 'snapshot') {
            for (const task of event.snapshot.tasks) {
              if (isTerminalTask(task)) onTaskTerminal(task);
            }
          }
          if (event.type === 'task') {
            setTree(created.snapshot);
            if (isTerminalTask(event.task)) onTaskTerminal(event.task);
          }
          if (event.type === 'detail') {
            setDetails((current) =>
              new Map(current).set(event.detail.task.taskId, event.detail),
            );
          }
          if (event.type === 'event') {
            const detail = created.detail(event.taskId);
            if (detail !== undefined) {
              setDetails((current) =>
                new Map(current).set(event.taskId, detail),
              );
            }
          }
          if (event.type === 'error') onError(event.error);
        });
      })
      .catch(onError);
    return () => {
      disposed = true;
      stopClientListener?.();
      if (activeClient !== undefined) void activeClient.close();
    };
  }, [onError, onTaskTerminal, thread]);

  const activate = useCallback(
    (taskId: 'main' | string) => {
      if (taskId === 'main') {
        setActiveView({ kind: 'main', threadId: thread.threadId });
        setHighlightedTaskId('main');
        setFocus('composer');
        clearTerminalScrollback();
        setViewEpoch((current) => current + 1);
        return;
      }
      setActiveView({
        kind: 'task',
        rootThreadId: thread.threadId,
        taskId,
      });
      setHighlightedTaskId(taskId);
      setFocus('composer');
      clearTerminalScrollback();
      setViewEpoch((current) => current + 1);
      void client?.read(taskId).catch(onError);
    },
    [client, onError, thread.threadId],
  );

  const returnToParent = useCallback(() => {
    if (activeView.kind === 'main') {
      setFocus('composer');
      return;
    }
    const task = tree.tasks.find(
      (candidate) => candidate.taskId === activeView.taskId,
    );
    activate(task?.parentTaskId ?? 'main');
  }, [activate, activeView, tree.tasks]);

  const activeTask =
    activeView.kind === 'task'
      ? tree.tasks.find((task) => task.taskId === activeView.taskId)
      : undefined;

  return {
    client,
    tree,
    details,
    activeView,
    activeTask,
    activeDetail:
      activeView.kind === 'task' ? details.get(activeView.taskId) : undefined,
    focus,
    highlightedTaskId,
    viewEpoch,
    setFocus,
    setHighlightedTaskId,
    activate,
    returnToParent,
    tasks: tree.tasks as readonly AgentTaskSummary[],
  };
}

function isTerminalTask(task: AgentTaskSummary): boolean {
  return task.status !== 'queued' && task.status !== 'running';
}
