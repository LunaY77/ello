import type { CodingAgentConfig } from './config.js';

export type SlashCommandResult =
  | { handled: false }
  | {
      handled: true;
      command:
        | 'help'
        | 'clear'
        | 'model'
        | 'resume'
        | 'new'
        | 'compact'
        | 'tools'
        | 'config'
        | 'tasks'
        | 'memory'
        | 'permissions'
        | 'exit'
        | 'unknown';
      args: string[];
      exit?: boolean;
      output: string;
    };

export function handleSlashCommand(
  input: string,
  config: CodingAgentConfig,
): SlashCommandResult {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return { handled: false };
  }
  const [command = '', ...args] = trimmed.split(/\s+/);
  if (trimmed === '/exit') {
    return { handled: true, command: 'exit', args, exit: true, output: 'bye' };
  }
  if (trimmed === '/help') {
    return {
      handled: true,
      command: 'help',
      args,
      output: ['/help', '/model', '/tools', '/config', '/exit'].join('\n'),
    };
  }
  if (command === '/clear') {
    return { handled: true, command: 'clear', args, output: '' };
  }
  if (command === '/model') {
    return {
      handled: true,
      command: 'model',
      args,
      output: args[0] ? `switch model ${args[0]}` : config.model,
    };
  }
  if (command === '/resume') {
    return {
      handled: true,
      command: 'resume',
      args,
      output: args[0] ? `resume ${args[0]}` : 'resume requires a session id',
    };
  }
  if (command === '/new') {
    return { handled: true, command: 'new', args, output: 'new session' };
  }
  if (command === '/compact') {
    return { handled: true, command: 'compact', args, output: 'compact requested' };
  }
  if (trimmed === '/tools') {
    return {
      handled: true,
      command: 'tools',
      args,
      output: [
        'read_file',
        'write_file',
        'edit_file',
        'list_dir',
        'grep',
        'glob',
        'mkdir',
        'delete_file',
        'move_copy',
        'shell_exec',
        'web_fetch',
        'web_search',
      ].join('\n'),
    };
  }
  if (trimmed === '/config') {
    return {
      handled: true,
      command: 'config',
      args,
      output: JSON.stringify(config, null, 2),
    };
  }
  if (trimmed === '/tasks' || trimmed === '/todo') {
    return {
      handled: true,
      command: 'tasks',
      args,
      output: 'Task list is available from an active CodingAgentSession.',
    };
  }
  if (trimmed === '/memory') {
    return {
      handled: true,
      command: 'memory',
      args,
      output: 'Memory files are loaded at session startup and written to session metadata.',
    };
  }
  if (trimmed === '/permissions') {
    return {
      handled: true,
      command: 'permissions',
      args,
      output: [
        `mode\t${config.approvalMode}`,
        `allowedPaths\t${config.allowedPaths.join(', ')}`,
        `rules\t${config.permissionRules.length}`,
      ].join('\n'),
    };
  }
  return {
    handled: true,
    command: 'unknown',
    args,
    output: `Unknown command: ${trimmed}`,
  };
}
