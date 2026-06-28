import type { CodingAgentConfig } from './config.js';
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
        | 'model-selector'
        | 'session-selector'
        | 'session-tree'
        | 'settings'
        | 'permission-rules';
    }
  | {
      readonly type: 'runtime-action';
      readonly action: 'compact' | 'new-session' | 'fork' | 'export' | 'quit';
      readonly args?: string[];
    }
  | { readonly type: 'set-model'; readonly model: string }
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
    description: 'Clear visible transcript',
    run: () => ({ type: 'message', message: 'Transcript clear requested.' }),
  },
  {
    name: 'model',
    description: 'Switch or show model',
    run: (ctx, args) =>
      args[0]
        ? { type: 'set-model', model: args[0] }
        : { type: 'message', message: `Current model: ${ctx.config.model}` },
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
    name: 'new',
    description: 'Create a new session',
    run: () => ({ type: 'runtime-action', action: 'new-session' }),
  },
  {
    name: 'session',
    description: 'Show current session',
    run: (ctx) => ({
      type: 'message',
      message: `Session: ${ctx.config.sessionId ?? '<new>'}`,
    }),
  },
  {
    name: 'tree',
    description: 'Open session tree',
    run: () => ({ type: 'open-overlay', overlay: 'session-tree' }),
  },
  {
    name: 'fork',
    description: 'Fork active branch',
    run: (_ctx, args) => ({ type: 'runtime-action', action: 'fork', args }),
  },
  {
    name: 'compact',
    description: 'Compact current session',
    run: () => ({ type: 'runtime-action', action: 'compact' }),
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
  if (result.type === 'set-model') return `Switch model: ${result.model}`;
  if (result.type === 'set-permission-mode')
    return `Set permission mode: ${result.mode}`;
  return result.prompt;
}
