import type { CommandResult } from '../../cli/slash-commands.js';
import type { ThreadClient } from '../../client/thread-client.js';
import type { OverlayState, RewindTarget } from '../component/OverlayHost.js';
import type { HistoryEntry } from '../store/history-entry.js';

import type { useRuntimeEvents } from './use-runtime-events.js';

type Dispatch = ReturnType<typeof useRuntimeEvents>['dispatch'];
type RuntimeCommand = Extract<CommandResult, { type: 'runtime-action' }>;

/** Slash runtime action 只调用 typed ThreadClient，不直接改动 reducer 状态。 */
export function useRuntimeActions(input: {
  readonly thread: ThreadClient;
  readonly history: readonly HistoryEntry[];
  readonly dispatch: Dispatch;
  setOverlay(overlay: OverlayState): void;
  switchThread(thread: ThreadClient, draft?: string): Promise<void>;
  closeCurrentThread(): Promise<void>;
  exit(): void;
}) {
  const rewindToTarget = async (target: RewindTarget): Promise<void> => {
    const next = await input.thread.fork(target.turnId);
    await input.switchThread(next, target.text);
  };

  const run = async (command: RuntimeCommand): Promise<void> => {
    switch (command.action) {
      case 'clear':
        await input.switchThread(await input.thread.startNewThread());
        return;
      case 'compact': {
        const result = await input.thread.request('thread/compact/start', {
          threadId: input.thread.threadId,
        });
        message(`Context compaction completed (${result.jobId}).`);
        return;
      }
      case 'archive':
        await archiveActiveThread(input.thread, input.exit);
        return;
      case 'fork':
        assertMaximumArguments(command.args, 1, '/fork [entry-id]');
        await input.switchThread(await input.thread.fork(command.args[0]));
        return;
      case 'rewind': {
        assertMaximumArguments(command.args, 1, '/rewind [entry-id]');
        const targets = rewindTargets(input.history);
        if (command.args[0] === undefined) {
          input.setOverlay({ type: 'rewind-selector', targets });
          return;
        }
        const target = targets.find(
          (candidate) => candidate.entryId === command.args[0],
        );
        if (target === undefined) {
          throw new Error(`Unknown rewind target ${command.args[0]}.`);
        }
        await rewindToTarget(target);
        return;
      }
      case 'memory': {
        assertMaximumArguments(command.args, 1, '/memory [reload]');
        const operation = command.args[0];
        if (operation !== undefined && operation !== 'reload') {
          throw new Error('Usage: /memory [reload].');
        }
        if (operation === 'reload') {
          await input.thread.request('memory/reload', {
            cwd: input.thread.cwd,
            threadId: input.thread.threadId,
          });
        }
        const result = await input.thread.request('memory/status', {
          cwd: input.thread.cwd,
          threadId: input.thread.threadId,
        });
        message(`memory ${result.state}, ${result.pendingJobs} pending job(s)`);
        return;
      }
      case 'dream': {
        const result = await input.thread.request('memory/dream/start', {
          cwd: input.thread.cwd,
          threadId: input.thread.threadId,
        });
        message(`Memory dream job ${result.jobId} started.`);
        return;
      }
      case 'goal':
        await runGoal(command.args);
        return;
      case 'export': {
        assertMaximumArguments(
          command.args,
          1,
          '/export [markdown|html|jsonl]',
        );
        const result = await input.thread.request('thread/export', {
          threadId: input.thread.threadId,
          format: exportFormat(command.args[0]),
        });
        message(
          result.kind === 'inline'
            ? result.content
            : `Export artifact ${result.artifactId} (${result.byteCount} bytes).`,
        );
        return;
      }
      case 'quit':
        await input.closeCurrentThread();
        input.exit();
        return;
      default:
        command satisfies never;
        throw new Error(`Unhandled runtime action: ${String(command)}`);
    }
  };

  const runGoal = async (args: readonly string[]): Promise<void> => {
    const operation = args[0];
    if (operation === undefined || operation === 'get') {
      assertMaximumArguments(
        args,
        operation === undefined ? 0 : 1,
        '/goal [get]',
      );
      const result = await input.thread.request('thread/goal/get', {
        threadId: input.thread.threadId,
      });
      message(
        result.goal === null
          ? 'No active goal.'
          : `${result.goal.status}: ${result.goal.objective}`,
      );
      return;
    }
    if (operation === 'clear') {
      await input.thread.request('thread/goal/clear', {
        threadId: input.thread.threadId,
      });
      return;
    }
    if (operation === 'set' && args.length > 1) {
      await input.thread.request('thread/goal/set', {
        threadId: input.thread.threadId,
        objective: args.slice(1).join(' '),
      });
      return;
    }
    throw new Error('Usage: /goal <get|set <objective>|clear>.');
  };

  const message = (text: string): void =>
    input.dispatch({ type: 'ui.message', text });

  return { runRuntimeAction: run, rewindToTarget };
}

export async function archiveActiveThread(
  thread: ThreadClient,
  exit: () => void,
): Promise<void> {
  await thread.request('thread/archive', { threadId: thread.threadId });
  await thread.close();
  exit();
}

export function rewindTargets(
  entries: readonly HistoryEntry[],
): readonly RewindTarget[] {
  return entries
    .filter(
      (entry): entry is Extract<HistoryEntry, { kind: 'user' }> =>
        entry.kind === 'user',
    )
    .map((entry, index) => ({
      entryId: entry.id,
      turnId: entry.turnId,
      index,
      text: entry.text,
    }));
}

function exportFormat(value: string | undefined) {
  if (value === undefined) return 'markdown';
  if (value === 'jsonl' || value === 'html' || value === 'markdown') {
    return value;
  }
  throw new Error('Usage: /export [markdown|html|jsonl].');
}

function assertMaximumArguments(
  args: readonly string[],
  maximum: number,
  usage: string,
): void {
  if (args.length > maximum) throw new Error(`Usage: ${usage}.`);
}
