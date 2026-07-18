import type { Command } from 'commander';

import type { CliCommandContext, CliCommandModule } from '../types.js';

import { configCommands } from './config.js';
import { goalCommands } from './goal.js';
import { infoCommands } from './info.js';
import { skillCommands } from './skills.js';
import { taskCommands } from './tasks.js';
import { workspaceCommands } from './workspace.js';

const modules: readonly CliCommandModule[] = [
  infoCommands,
  configCommands,
  taskCommands,
  skillCommands,
  goalCommands,
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
