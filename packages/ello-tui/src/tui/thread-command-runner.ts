import type { ThreadSummary } from '../api/protocol-types.js';
import {
  handleSlashCommand,
  type CommandResult,
} from '../cli/slash-commands.js';
import type { ThreadClient } from '../client/thread-client.js';
import { loadLocalUiConfig } from '../config/local-ui-config.js';

import type { OverlayState } from './component/OverlayHost.js';
import type { CatalogData } from './hooks/use-catalogs.js';
import { rewindTargets } from './hooks/use-runtime-actions.js';
import type { useRuntimeActions } from './hooks/use-runtime-actions.js';
import type { useRuntimeEvents } from './hooks/use-runtime-events.js';
import { loadSettings } from './profile-config.js';
import { isResumableThread } from './screen-utils.js';
import type { TuiEventState } from './store/tui-event-store.js';
import type { SelectOption } from './ui/List.js';

type Dispatch = ReturnType<typeof useRuntimeEvents>['dispatch'];
type RuntimeActions = ReturnType<typeof useRuntimeActions>;

interface ThreadCommandRunnerInput {
  readonly thread: ThreadClient;
  readonly state: TuiEventState;
  readonly catalogs: Pick<CatalogData, 'agents' | 'skills' | 'tasks'>;
  readonly modelOptions: readonly SelectOption[];
  readonly profileOptions: readonly SelectOption[];
  readonly runtime: RuntimeActions;
  readonly dispatch: Dispatch;
  setOverlay(overlay: OverlayState): void;
  submitText(value: string): Promise<void>;
}

/** 命令路由只翻译用户意图，不持有 Composer、overlay 或 runtime 状态。 */
export function createThreadCommandRunner(input: ThreadCommandRunnerInput): {
  submitPrompt(value: string): Promise<void>;
} {
  const openOverlay = async (
    name: Extract<CommandResult, { type: 'open-overlay' }>['overlay'],
  ): Promise<void> => {
    switch (name) {
      case 'help':
        input.setOverlay({ type: 'help' });
        return;
      case 'models':
        input.setOverlay({
          type: 'models',
          title: 'Model catalog',
          options: input.modelOptions,
        });
        return;
      case 'profiles':
        input.setOverlay({ type: 'profiles', options: input.profileOptions });
        return;
      case 'settings':
        input.setOverlay({
          type: 'settings',
          settings: await loadSettings(input.thread, await loadLocalUiConfig()),
        });
        return;
      case 'agents':
        input.setOverlay({ type: 'agents', agents: input.catalogs.agents });
        return;
      case 'skills':
        input.setOverlay({ type: 'skills', skills: input.catalogs.skills });
        return;
      case 'tasks':
        input.setOverlay({ type: 'tasks', tasks: input.catalogs.tasks });
        return;
      case 'workspace': {
        const result = await input.thread.request('workspace/list', {});
        input.setOverlay({ type: 'workspace', workspaces: result.data });
        return;
      }
      case 'session-selector': {
        await openSessionSelector(false, 'resume');
        return;
      }
      case 'archived-session-selector': {
        await openSessionSelector(true, 'unarchive');
        return;
      }
      case 'rewind-selector':
        input.setOverlay({
          type: 'rewind-selector',
          targets: rewindTargets(input.state.history),
        });
        return;
      default:
        name satisfies never;
        throw new Error(`Unhandled overlay: ${String(name)}`);
    }
  };

  const openSessionSelector = async (
    archived: boolean,
    action: 'resume' | 'unarchive',
  ): Promise<void> => {
    const sessions = await listThreads(input.thread, archived);
    input.setOverlay({
      type: 'session-selector',
      action,
      sessions: sessions.filter(isResumableThread),
      currentCwd: input.thread.cwd,
    });
  };

  const runShellCommand = async (command: string): Promise<void> => {
    if (command === '') return;
    const result = await input.thread.request('thread/shellCommand', {
      threadId: input.thread.threadId,
      command,
    });
    const output = [result.stdout, result.stderr]
      .filter((part) => part !== '')
      .join('\n');
    input.dispatch({
      type: 'ui.message',
      text: `$ ${command}\n${output === '' ? `exit ${result.exitCode}` : output}`,
      level: result.exitCode === 0 ? 'info' : 'error',
    });
  };

  const runCommand = async (command: CommandResult): Promise<void> => {
    switch (command.type) {
      case 'message':
        input.dispatch({ type: 'ui.message', text: command.message });
        return;
      case 'submit':
        await submitPrompt(command.prompt);
        return;
      case 'set-mode':
        await input.thread.setMode(command.mode);
        return;
      case 'set-profile':
        await input.thread.setProfile(command.profile);
        return;
      case 'open-overlay':
        await openOverlay(command.overlay);
        return;
      case 'runtime-action':
        await input.runtime.runRuntimeAction(command);
        return;
      default:
        command satisfies never;
        throw new Error(`Unhandled command: ${String(command)}`);
    }
  };

  const submitPrompt = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    if (trimmed === '') return;
    if (trimmed.startsWith('/')) {
      const parsed = handleSlashCommand(trimmed);
      if (parsed.command !== undefined) await runCommand(parsed.command);
      else if (parsed.output !== '') {
        input.dispatch({ type: 'ui.message', text: parsed.output });
      }
      return;
    }
    if (trimmed.startsWith('!')) {
      await runShellCommand(trimmed.slice(1).trim());
      return;
    }
    await input.submitText(value);
  };

  return { submitPrompt };
}

async function listThreads(
  thread: ThreadClient,
  archived: boolean,
): Promise<readonly ThreadSummary[]> {
  const sessions: ThreadSummary[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await thread.request('thread/list', {
      archived,
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    sessions.push(...page.data);
    if (page.nextCursor === undefined) return sessions;
    if (cursors.has(page.nextCursor)) {
      throw new Error(`thread/list repeated cursor ${page.nextCursor}.`);
    }
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
