import type { ApprovalMode } from '../config.js';

import type { CliOptions } from './types.js';

/**
 * 将 argv 解析为产品层 CLI 选项。
 */
export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    command: 'tui',
    subcommand: null,
    prompt: '',
    modelCandidates: [],
    allowedPaths: [],
  };
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (
      arg === 'run' ||
      arg === 'resume' ||
      arg === 'sessions' ||
      arg === 'config' ||
      arg === 'tools' ||
      arg === 'memory' ||
      arg === 'permissions' ||
      arg === 'tasks'
    ) {
      options.command = arg;
      if ((arg === 'config' || arg === 'tools') && args[index + 1]?.startsWith('-') === false) {
        options.subcommand = args[(index += 1)] ?? null;
      }
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.command = 'help';
      continue;
    }
    if (arg === '--model') {
      options.model = readOptionValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--model-candidate') {
      options.modelCandidates.push(readOptionValue(args, (index += 1), arg));
      continue;
    }
    if (arg === '--base-url') {
      options.baseUrl = readOptionValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--cwd') {
      options.cwd = readOptionValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--session') {
      options.sessionId = readOptionValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--allowed-path') {
      options.allowedPaths.push(readOptionValue(args, (index += 1), arg));
      continue;
    }
    if (arg === '--mcp') {
      options.mcpConfigPath = readOptionValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--approval-mode') {
      options.approvalMode = readApprovalMode(readOptionValue(args, (index += 1), arg));
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--no-tui') {
      options.noTui = true;
      options.command = options.command === 'tui' ? 'run' : options.command;
      continue;
    }
    rest.push(arg);
  }
  options.prompt = rest.join(' ');
  return options;
}

function readOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function readApprovalMode(value: string): ApprovalMode {
  if (value === 'never' || value === 'on-request' || value === 'always') {
    return value;
  }
  throw new Error(`Invalid approval mode: ${value}`);
}
