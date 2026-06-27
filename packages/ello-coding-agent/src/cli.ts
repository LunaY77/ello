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
import {
  createCodingAgentSession,
  listCodingAgentSessions,
} from './session.js';
import { handleSlashCommand } from './slash-commands.js';

export interface CliIo {
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

/**
 * 运行 coding-agent CLI，并允许为测试和嵌入场景注入 IO。
 */
export async function runCli(
  args: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<void> {
  const options = parseArgs(args);
  if (options.command === 'help') {
    io.stdout.write(`${printHelp()}\n`);
    return;
  }
  const config = await loadCodingAgentConfig({
    ...(options.model ? { model: options.model } : {}),
    ...(options.modelCandidates.length > 0 ? { modelCandidates: options.modelCandidates } : {}),
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    ...(options.allowedPaths.length > 0 ? { allowedPaths: options.allowedPaths } : {}),
    ...(options.mcpConfigPath ? { mcpConfigPath: options.mcpConfigPath } : {}),
    ...(options.approvalMode ? { approvalMode: options.approvalMode } : {}),
    ...(options.json !== undefined ? { json: options.json } : {}),
    ...(options.noTui !== undefined ? { tui: !options.noTui } : {}),
  });

  if (options.command === 'config') {
    if (options.subcommand === 'path') {
      io.stdout.write(`${getProjectConfigPath(config.cwd)}\n`);
    } else if (options.subcommand === 'get') {
      io.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    } else if (options.subcommand === 'set') {
      const [key, rawValue] = splitConfigSetPrompt(options.prompt);
      const updated = await setProjectConfigValue(config.cwd, key, parseConfigValue(rawValue));
      io.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
    } else {
      io.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    }
    return;
  }
  if (options.command === 'tools') {
    const tools = handleSlashCommand('/tools', config);
    io.stdout.write(`${tools.handled ? tools.output : ''}\n`);
    return;
  }
  if (options.command === 'memory') {
    const memory = await loadCodingMemory(config.cwd);
    io.stdout.write(`${config.json ? JSON.stringify(memory, null, 2) : summarizeMemory(memory, config.cwd)}\n`);
    return;
  }
  if (options.command === 'permissions') {
    const output = {
      mode: config.approvalMode,
      allowedPaths: config.allowedPaths,
      rules: config.permissionRules,
    };
    io.stdout.write(
      `${config.json
          ? JSON.stringify(output, null, 2)
          : [
              `mode\t${config.approvalMode}`,
              `allowedPaths\t${config.allowedPaths.join(', ')}`,
              formatPermissionRules(config.permissionRules),
            ].join('\n')}\n`,
    );
    return;
  }
  if (options.command === 'tasks') {
    const session = await createCodingAgentSession(config);
    try {
      const tasks = session.listTasks();
      io.stdout.write(`${config.json ? JSON.stringify(tasks, null, 2) : tasks.length === 0 ? 'No tasks.' : tasks.map((task) => `${task.id}\t${task.status}\t${task.activeForm}`).join('\n')}\n`);
    } finally {
      await session.close();
    }
    return;
  }
  if (options.command === 'sessions') {
    const sessions = await listCodingAgentSessions(config);
    if (config.json) {
      io.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`);
    } else {
      io.stdout.write(
        `${sessions.length === 0
            ? `No sessions in ${config.sessionDir}`
            : sessions
                .map(
                  (session) =>
                    `${session.sessionId}\t${session.entryCount} entries\t${session.updatedAt ?? 'unknown'}`,
                )
                .join('\n')}\n`,
      );
    }
    return;
  }
  if (options.command === 'resume') {
    const sessionId = options.sessionId ?? options.prompt.trim();
    if (!sessionId) {
      throw new Error('Missing session id. Use `ello resume <sessionId>`.');
    }
    const { renderCodingAgentTui } = await import('@ello/tui');
    await renderCodingAgentTui({ config: { ...config, sessionId } });
    return;
  }
  if (options.command === 'tui' && !options.noTui) {
    const { renderCodingAgentTui } = await import('@ello/tui');
    await renderCodingAgentTui({ config });
    return;
  }

  const prompt = options.prompt || (options.command === 'run' ? '' : options.prompt);
  if (!prompt.trim()) {
    throw new Error('Missing prompt. Use `ello run <prompt>` or start `ello` for TUI.');
  }
  const slash = handleSlashCommand(prompt, config);
  if (slash.handled) {
    io.stdout.write(`${slash.output}\n`);
    return;
  }

  const session = await createCodingAgentSession(config);
  try {
    await session.submit(prompt, (event) => {
      io.stdout.write(formatCodingAgentEventOutput(event, config.json));
    });
  } finally {
    await session.close();
  }
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
  if (entrypoint === undefined) {
    return false;
  }
  return realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url));
}
