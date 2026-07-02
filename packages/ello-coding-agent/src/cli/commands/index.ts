import type { Command } from 'commander';

import type { CliCommandContext, CliCommandModule } from '../types.js';

import { configCommands } from './config.js';
import { infoCommands } from './info.js';
import { taskCommands } from './tasks.js';
import { workspaceCommands } from './workspace.js';

const modules: readonly CliCommandModule[] = [
  infoCommands,
  configCommands,
  taskCommands,
  workspaceCommands,
];

export function registerCommands(
  program: Command,
  ctx: CliCommandContext,
): void {
  for (const module of modules) {
    module.register(program, ctx);
  }
}
