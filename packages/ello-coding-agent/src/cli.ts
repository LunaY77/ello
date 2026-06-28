#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './cli/args.js';
import { parseConfigValue, splitConfigSetPrompt } from './cli/config-values.js';
import { formatCodingAgentEventOutput, printHelp } from './cli/output.js';
import {
  getProjectConfigPath,
  loadCodingAgentConfig,
  setProjectConfigValue,
} from './config.js';
import { loadCodingMemory, summarizeMemory } from './memory.js';
import { formatPermissionRules } from './permissions.js';
import { CodingAgentRuntime } from './product/runtime.js';
import { runRpcServer } from './rpc/server.js';
import { JsonlSessionRepository } from './session/repository.js';
import { handleSlashCommand } from './slash-commands.js';
import type { CommandResult } from './slash-commands.js';
import { describeCodingTools } from './tools/index.js';
import { renderCodingAgentTui } from './tui/index.js';

export interface CliIo {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
  readonly stdin?: NodeJS.ReadableStream;
}

/** 运行 coding-agent CLI，并允许测试注入 IO。 */
export async function runCli(
  args: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin },
): Promise<void> {
  const options = parseArgs(args);
  if (options.command === 'help') {
    io.stdout.write(`${printHelp()}\n`);
    return;
  }
  const config = await loadCodingAgentConfig({
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.modelCandidates.length > 0 ? { modelCandidates: options.modelCandidates } : {}),
    ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    ...(options.allowedPaths.length > 0 ? { allowedPaths: options.allowedPaths } : {}),
    ...(options.mcpConfigPath !== undefined ? { mcpConfigPath: options.mcpConfigPath } : {}),
    ...(options.approvalMode !== undefined ? { approvalMode: options.approvalMode } : {}),
    ...(options.json !== undefined ? { json: options.json } : {}),
    ...(options.noTui !== undefined ? { tui: !options.noTui } : {}),
  });

  if (options.command === 'config') {
    await handleConfigCommand(options.subcommand, options.prompt, config.cwd, io);
    return;
  }
  if (options.command === 'tools') {
    io.stdout.write(`${describeCodingTools()}\n`);
    return;
  }
  if (options.command === 'memory') {
    const memory = await loadCodingMemory(config.cwd);
    io.stdout.write(`${config.json ? JSON.stringify(memory, null, 2) : summarizeMemory(memory, config.cwd)}\n`);
    return;
  }
  if (options.command === 'permissions') {
    io.stdout.write(`${config.json ? JSON.stringify({ mode: config.approvalMode, allowedPaths: config.allowedPaths, rules: config.permissionRules }, null, 2) : [`mode\t${config.approvalMode}`, `allowedPaths\t${config.allowedPaths.join(', ')}`, formatPermissionRules(config.permissionRules)].join('\n')}\n`);
    return;
  }
  if (options.command === 'sessions') {
    const sessions = await new JsonlSessionRepository({ sessionDir: config.sessionDir, cwd: config.cwd }).list();
    io.stdout.write(`${config.json ? JSON.stringify(sessions, null, 2) : sessions.length === 0 ? `No sessions in ${config.sessionDir}` : sessions.map((session) => `${session.sessionId}\t${session.entryCount} entries\t${session.updatedAt ?? 'unknown'}`).join('\n')}\n`);
    return;
  }
  if (options.command === 'rpc') {
    await runRpcServer(config, { stdin: io.stdin ?? process.stdin, stdout: io.stdout });
    return;
  }
  if ((options.command === 'tui' || options.command === 'resume') && !options.noTui) {
    await renderCodingAgentTui({ config: { ...config, ...(options.command === 'resume' && options.prompt.trim() ? { sessionId: options.prompt.trim() } : {}) } });
    return;
  }

  const prompt = options.prompt.trim();
  if (!prompt) {
    throw new Error('Missing prompt. Use `ello run <prompt>` or start `ello` for TUI.');
  }
  const slash = handleSlashCommand(prompt, config);
  if (slash.handled) {
    if (slash.command !== undefined) {
      const handled = await executeCommandResult(slash.command, config);
      io.stdout.write(`${handled ?? slash.output}\n`);
    } else {
      io.stdout.write(`${slash.output}\n`);
    }
    return;
  }

  const runtime = await CodingAgentRuntime.create({ config });
  const unsubscribe = runtime.events.subscribe((event) => {
    io.stdout.write(formatCodingAgentEventOutput(event, config.json));
  });
  try {
    await runtime.submit(prompt);
  } finally {
    unsubscribe();
    await runtime.close();
  }
}

async function executeCommandResult(command: CommandResult, config: Awaited<ReturnType<typeof loadCodingAgentConfig>>): Promise<string | null> {
  if (command.type === 'runtime-action') {
    const runtime = await CodingAgentRuntime.create({ config });
    try {
      if (command.action === 'compact') {
        await runtime.compact();
        return 'Compacted current session.';
      }
      if (command.action === 'new-session') {
        const info = await runtime.newSession();
        return `New session: ${info.sessionId}`;
      }
      if (command.action === 'fork') {
        await runtime.fork(command.args?.[0] ?? '', { reason: command.args?.slice(1).join(' ') || 'slash-command' });
        return 'Forked current session.';
      }
      if (command.action === 'export') {
        return await runtime.exportSession(command.args?.[0] === 'html' ? 'html' : 'jsonl');
      }
      if (command.action === 'quit') {
        return 'Quit requested.';
      }
    } finally {
      await runtime.close();
    }
  }
  if (command.type === 'set-model') {
    const runtime = await CodingAgentRuntime.create({ config });
    try {
      await runtime.switchModel(command.model);
      return `Switched model: ${command.model}`;
    } finally {
      await runtime.close();
    }
  }
  return null;
}

async function handleConfigCommand(subcommand: string | null, prompt: string, cwd: string, io: CliIo): Promise<void> {
  if (subcommand === 'path') {
    io.stdout.write(`${getProjectConfigPath(cwd)}\n`);
    return;
  }
  if (subcommand === 'set') {
    const [key, rawValue] = splitConfigSetPrompt(prompt);
    io.stdout.write(`${JSON.stringify(await setProjectConfigValue(cwd, key, parseConfigValue(rawValue)), null, 2)}\n`);
    return;
  }
  io.stdout.write(`${JSON.stringify(await loadCodingAgentConfig({ cwd }), null, 2)}\n`);
}

if (isCliEntrypoint()) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    process.exitCode = 0;
    return;
  }
  throw error;
});

function isCliEntrypoint(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url));
}
