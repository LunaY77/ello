#!/usr/bin/env node
import { Command } from 'commander';

import { ELLO_TUI_VERSION } from '../version.js';

import { registerAppServerCommand } from './commands/app-server.js';
import { registerCatalogCommands } from './commands/catalog.js';
import { registerManagementCommands } from './commands/management.js';
import { registerRunCommands, runPrompt } from './commands/run.js';
import { registerWorkspaceCommands } from './commands/workspace.js';
import { resolveGlobalOptions } from './shared/options.js';

/** CLI 入口只组装 Commander；命令实现按领域拆分并自行管理依赖加载。 */
const program = new Command()
  .name('ello')
  .description('Ello JSON-RPC client and terminal UI')
  .version(ELLO_TUI_VERSION)
  .option('--remote <endpoint>', 'connect to a running App Server')
  .option(
    '--remote-auth-token-env <name>',
    'read the remote bearer token from an environment variable',
  )
  .option('--root <path>', 'workspace root for a local App Server')
  .option('--json', 'render results as JSON lines')
  .option('--no-tui', 'use the non-interactive client renderer');

registerAppServerCommand(program);
registerRunCommands(program);
registerCatalogCommands(program);
registerManagementCommands(program);
registerWorkspaceCommands(program);

program.action(async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    program.outputHelp();
    return;
  }
  await runPrompt('', resolveGlobalOptions(program));
});

export async function runCli(
  argv: readonly string[] = process.argv,
): Promise<void> {
  await program.parseAsync([...argv]);
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('/cli/main.js')) {
  runCli().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
