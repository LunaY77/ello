import type { SessionMode } from '../api/protocol-types.js';

export type TuiOverlayName =
  | 'help'
  | 'agents'
  | 'models'
  | 'profiles'
  | 'session-selector'
  | 'rewind-selector'
  | 'settings'
  | 'skills'
  | 'tasks'
  | 'workspace';

export type CommandResult =
  | { readonly type: 'message'; readonly message: string }
  | { readonly type: 'open-overlay'; readonly overlay: TuiOverlayName }
  | {
      readonly type: 'runtime-action';
      readonly action:
        | 'clear'
        | 'compact'
        | 'memory'
        | 'dream'
        | 'goal'
        | 'rewind'
        | 'fork'
        | 'export'
        | 'quit';
      readonly args?: readonly string[];
    }
  | { readonly type: 'set-profile'; readonly profile: string }
  | { readonly type: 'set-mode'; readonly mode: SessionMode }
  | { readonly type: 'submit'; readonly prompt: string };

export interface SlashCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  run(args: readonly string[], rawArgs: string): CommandResult;
}

export interface SlashCommandResult {
  readonly handled: boolean;
  readonly output: string;
  readonly command?: CommandResult;
}

export const slashCommands: readonly SlashCommand[] = [
  command('mode', 'Show or change the thread mode', (args) => {
    const mode = parseSessionMode(args[0]);
    if (mode === undefined)
      return {
        type: 'message',
        message: 'Usage: /mode <ask-before-changes|accept-edits|plan|bypass>',
      };
    return { type: 'set-mode', mode };
  }),
  command('plan', 'Enter Plan mode', (_args, rawArgs) =>
    rawArgs === ''
      ? { type: 'set-mode', mode: 'plan' }
      : { type: 'submit', prompt: rawArgs },
  ),
  command(
    'help',
    'Show commands',
    () => ({ type: 'open-overlay', overlay: 'help' }),
    ['?'],
  ),
  command('clear', 'Clear terminal history', () => ({
    type: 'runtime-action',
    action: 'clear',
  })),
  command('models', 'Browse model catalog', () => ({
    type: 'open-overlay',
    overlay: 'models',
  })),
  command('agents', 'Browse delegatable agents', () => ({
    type: 'open-overlay',
    overlay: 'agents',
  })),
  command('profiles', 'Switch profile', (args) =>
    args[0] === undefined
      ? { type: 'open-overlay', overlay: 'profiles' }
      : { type: 'set-profile', profile: args[0] },
  ),
  command('settings', 'Open settings', () => ({
    type: 'open-overlay',
    overlay: 'settings',
  })),
  command('resume', 'Open thread selector', () => ({
    type: 'open-overlay',
    overlay: 'session-selector',
  })),
  command('tasks', 'Open task list', () => ({
    type: 'open-overlay',
    overlay: 'tasks',
  })),
  command('workspace', 'Open workspace list', () => ({
    type: 'open-overlay',
    overlay: 'workspace',
  })),
  command('skills', 'Open skill browser', () => ({
    type: 'open-overlay',
    overlay: 'skills',
  })),
  command('goal', 'Create or manage the thread goal', (args) => ({
    type: 'runtime-action',
    action: 'goal',
    args,
  })),
  command('fork', 'Fork the current thread', (args) => ({
    type: 'runtime-action',
    action: 'fork',
    args,
  })),
  command('compact', 'Compact the current thread', () => ({
    type: 'runtime-action',
    action: 'compact',
  })),
  command('rewind', 'Fork at a prior turn and edit its prompt', (args) => ({
    type: 'runtime-action',
    action: 'rewind',
    args,
  })),
  command('memory', 'Show or reload memory status', (args) => ({
    type: 'runtime-action',
    action: 'memory',
    args,
  })),
  command('dream', 'Start memory consolidation', () => ({
    type: 'runtime-action',
    action: 'dream',
  })),
  command('export', 'Export thread', (args) => ({
    type: 'runtime-action',
    action: 'export',
    args,
  })),
  command(
    'quit',
    'Quit TUI',
    () => ({ type: 'runtime-action', action: 'quit' }),
    ['exit'],
  ),
];

export function handleSlashCommand(input: string): SlashCommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return { handled: false, output: '' };
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(trimmed);
  const name = match?.[1] ?? '';
  const rawArgs = (match?.[2] ?? '').trim();
  const args = rawArgs === '' ? [] : rawArgs.split(/\s+/u);
  const definition = slashCommands.find(
    (candidate) => candidate.name === name || candidate.aliases?.includes(name),
  );
  if (definition === undefined)
    return { handled: true, output: `Unknown command: /${name}` };
  const result = definition.run(args, rawArgs);
  return {
    handled: true,
    output: renderCommandResult(result),
    command: result,
  };
}

function command(
  name: string,
  description: string,
  run: SlashCommand['run'],
  aliases?: readonly string[],
): SlashCommand {
  return {
    name,
    description,
    run,
    ...(aliases === undefined ? {} : { aliases }),
  };
}

function parseSessionMode(value: string | undefined): SessionMode | undefined {
  return value === 'ask-before-changes' ||
    value === 'plan' ||
    value === 'accept-edits' ||
    value === 'bypass'
    ? value
    : undefined;
}

function renderCommandResult(result: CommandResult): string {
  if (result.type === 'message') return result.message;
  if (result.type === 'open-overlay') return `Open overlay: ${result.overlay}`;
  if (result.type === 'runtime-action')
    return `Runtime action: ${result.action}`;
  if (result.type === 'set-profile') return `Switch profile: ${result.profile}`;
  if (result.type === 'set-mode') return `Set mode: ${result.mode}`;
  return result.prompt;
}
