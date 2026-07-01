import type { CodingAgentConfig } from './config/index.js';
import type { PermissionMode } from './permissions.js';
import { describeCodingTools } from './tools/index.js';

/** slash command 的运行上下文。 */
export interface CommandContext {
  readonly config: CodingAgentConfig;
}

/** slash command 可以返回的产品动作。 */
export type CommandResult =
  | { readonly type: 'message'; readonly message: string }
  | {
      readonly type: 'open-overlay';
      readonly overlay:
        | 'help'
        | 'agents'
        | 'models'
        | 'profiles'
        | 'session-selector'
        | 'settings'
        | 'skills'
        | 'tasks'
        | 'workspace'
        | 'permission-rules';
    }
  | {
      readonly type: 'runtime-action';
      readonly action:
        | 'clear'
        | 'compact'
        | 'summary'
        | 'rewind'
        | 'new-session'
        | 'fork'
        | 'export'
        | 'quit';
      readonly args?: string[];
    }
  | { readonly type: 'set-profile'; readonly profile: string }
  | { readonly type: 'set-permission-mode'; readonly mode: PermissionMode }
  | { readonly type: 'submit'; readonly prompt: string };

/** slash command 定义。 */
export interface SlashCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  run(
    ctx: CommandContext,
    args: string[],
  ): Promise<CommandResult> | CommandResult;
}

export interface SlashCommandResult {
  readonly handled: boolean;
  readonly output: string;
  readonly command?: CommandResult;
}

/** 内置命令 registry。 */
export const slashCommands: readonly SlashCommand[] = [
  {
    name: 'help',
    aliases: ['?'],
    description: 'Show commands',
    run: () => ({ type: 'open-overlay', overlay: 'help' }),
  },
  {
    name: 'clear',
    description: 'Clear context and reset the TUI',
    run: () => ({ type: 'runtime-action', action: 'clear' }),
  },
  {
    name: 'models',
    description: 'Browse model catalog',
    run: () => ({ type: 'open-overlay', overlay: 'models' }),
  },
  {
    name: 'agents',
    description: 'Browse delegatable subagents',
    run: () => ({ type: 'open-overlay', overlay: 'agents' }),
  },
  {
    name: 'profiles',
    description: 'Switch model profile suite',
    run: (_ctx, args) =>
      args[0]
        ? { type: 'set-profile', profile: args[0] }
        : { type: 'open-overlay', overlay: 'profiles' },
  },
  {
    name: 'settings',
    description: 'Open settings',
    run: () => ({ type: 'open-overlay', overlay: 'settings' }),
  },
  {
    name: 'resume',
    description: 'Open session selector',
    run: () => ({ type: 'open-overlay', overlay: 'session-selector' }),
  },
  {
    name: 'tasks',
    description: 'Open task list',
    run: () => ({ type: 'open-overlay', overlay: 'tasks' }),
  },
  {
    name: 'skills',
    description: 'Open skill browser',
    run: () => ({ type: 'open-overlay', overlay: 'skills' }),
  },
  {
    name: 'skill',
    description: 'Invoke a skill',
    run: (_ctx, args) => {
      const [name, ...rest] = args;
      if (name === undefined) {
        return { type: 'open-overlay', overlay: 'skills' };
      }
      return {
        type: 'submit',
        prompt: [
          `Invoke skill \`${name}\`.`,
          rest.length > 0 ? `Arguments: ${rest.join(' ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
    },
  },
  {
    name: 'skill-search',
    description: 'Search skills',
    run: (_ctx, args) => ({
      type: 'submit',
      prompt: `Search available skills for: ${args.join(' ')}`,
    }),
  },
  {
    name: 'skill-create',
    description: 'Create a skill package',
    run: (_ctx, args) => ({
      type: 'submit',
      prompt: `Invoke skill \`skill-creator\` to create: ${args.join(' ')}`,
    }),
  },
  {
    name: 'workspace',
    description: 'Open workspace status',
    run: () => ({ type: 'open-overlay', overlay: 'workspace' }),
  },
  {
    name: 'new',
    description: 'Create a new session',
    run: () => ({ type: 'runtime-action', action: 'new-session' }),
  },
  {
    name: 'fork',
    description: 'Fork active branch, optionally from a message entry',
    run: (_ctx, args) => ({ type: 'runtime-action', action: 'fork', args }),
  },
  {
    name: 'compact',
    description: 'Compact current session',
    run: () => ({ type: 'runtime-action', action: 'compact' }),
  },
  {
    name: 'summary',
    description: 'Generate a human-facing session summary',
    run: () => ({ type: 'runtime-action', action: 'summary' }),
  },
  {
    name: 'rewind',
    description: 'Rewind to a user message entry for editing',
    run: (_ctx, args) => ({
      type: 'runtime-action',
      action: 'rewind',
      args,
    }),
  },
  {
    name: 'tools',
    description: 'List default tools',
    run: () => ({ type: 'message', message: describeCodingTools() }),
  },
  {
    name: 'permissions',
    description: 'Show permission rules',
    run: () => ({ type: 'open-overlay', overlay: 'permission-rules' }),
  },
  {
    name: 'memory',
    description: 'Show memory files',
    run: () => ({
      type: 'submit',
      prompt: 'Summarize the active project memory context.',
    }),
  },
  {
    name: 'export',
    description: 'Export session',
    run: (_ctx, args) => ({ type: 'runtime-action', action: 'export', args }),
  },
  {
    name: 'quit',
    aliases: ['exit'],
    description: 'Quit TUI',
    run: () => ({ type: 'runtime-action', action: 'quit' }),
  },
];

/**
 * 处理一条 slash command。
 *
 * CLI 仍需要一个简单文本接口，因此这里保留 handleSlashCommand 包装；
 * TUI/RPC 可以直接消费 command 字段执行 overlay 或 runtime action。
 */
export function handleSlashCommand(
  input: string,
  config: CodingAgentConfig,
): SlashCommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return { handled: false, output: '' };
  }
  const [nameWithSlash = '', ...args] = trimmed.split(/\s+/);
  const name = nameWithSlash.slice(1);
  const command = slashCommands.find(
    (candidate) => candidate.name === name || candidate.aliases?.includes(name),
  );
  if (command === undefined) {
    return { handled: true, output: `Unknown command: /${name}` };
  }
  const result = command.run({ config }, args);
  if (result instanceof Promise) {
    return {
      handled: true,
      output: `Command /${name} is asynchronous and must be run from TUI/RPC.`,
    };
  }
  return {
    handled: true,
    output: renderCommandResult(result),
    command: result,
  };
}

function renderCommandResult(result: CommandResult): string {
  if (result.type === 'message') return result.message;
  if (result.type === 'open-overlay') return `Open overlay: ${result.overlay}`;
  if (result.type === 'runtime-action')
    return `Runtime action: ${result.action}`;
  if (result.type === 'set-profile') return `Switch profile: ${result.profile}`;
  if (result.type === 'set-permission-mode')
    return `Set permission mode: ${result.mode}`;
  return result.prompt;
}
