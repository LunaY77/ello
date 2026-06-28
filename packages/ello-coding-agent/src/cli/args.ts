import { normalizeApprovalMode, type ApprovalMode } from '../config.js';

import type { CliCommand, CliOptions } from './types.js';

/** 将 argv 解析为产品层 CLI 选项。 */
export function parseArgs(args: string[]): CliOptions {
  let command: CliCommand = 'tui';
  let subcommand: string | null = null;
  const rest: string[] = [];
  const modelCandidates: string[] = [];
  const allowedPaths: string[] = [];
  let model: string | undefined;
  let baseUrl: string | undefined;
  let cwd: string | undefined;
  let sessionId: string | undefined;
  let mcpConfigPath: string | undefined;
  let approvalMode: ApprovalMode | undefined;
  let json: boolean | undefined;
  let noTui: boolean | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (isCommand(arg)) {
      command = arg;
      if (arg === 'config' && args[index + 1] !== undefined && !args[index + 1]!.startsWith('-')) {
        subcommand = args[(index += 1)] ?? null;
      }
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      command = 'help';
      continue;
    }
    if (arg === '--model') {
      model = readOptionValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--model-candidate') {
      modelCandidates.push(readOptionValue(args, (index += 1), arg));
      continue;
    }
    if (arg === '--base-url') {
      baseUrl = readOptionValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--cwd') {
      cwd = readOptionValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--session') {
      sessionId = readOptionValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--allowed-path') {
      allowedPaths.push(readOptionValue(args, (index += 1), arg));
      continue;
    }
    if (arg === '--mcp') {
      mcpConfigPath = readOptionValue(args, (index += 1), arg);
      continue;
    }
    if (arg === '--approval-mode') {
      approvalMode = normalizeApprovalMode(readOptionValue(args, (index += 1), arg));
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--no-tui') {
      noTui = true;
      if (command === 'tui') command = 'run';
      continue;
    }
    rest.push(arg);
  }

  return {
    command,
    subcommand,
    prompt: rest.join(' '),
    ...(model !== undefined ? { model } : {}),
    modelCandidates,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    allowedPaths,
    ...(mcpConfigPath !== undefined ? { mcpConfigPath } : {}),
    ...(approvalMode !== undefined ? { approvalMode } : {}),
    ...(json !== undefined ? { json } : {}),
    ...(noTui !== undefined ? { noTui } : {}),
  };
}

function isCommand(value: string): value is CliCommand {
  return value === 'run' || value === 'rpc' || value === 'resume' || value === 'sessions' || value === 'config' || value === 'tools' || value === 'memory' || value === 'permissions';
}

function readOptionValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}
