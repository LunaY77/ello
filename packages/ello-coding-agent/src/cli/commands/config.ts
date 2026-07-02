import type { Command } from 'commander';

import {
  ensureGlobalConfig,
  ensureProjectConfig,
  getConfigValue,
  getProjectConfigPath,
  globalConfigPath,
  loadConfigSources,
  setConfigValue,
  type ConfigSourceName,
  type WritableConfigSourceName,
} from '../../config/index.js';
import { parseConfigValue, splitConfigSetPrompt } from '../config-values.js';
import type { CliCommandModule } from '../types.js';

export const configCommands: CliCommandModule = {
  register(program, ctx) {
    const configCmd = program
      .command('config')
      .description('read/write project config');
    configCmd
      .command('path')
      .option('--global', 'print global config path')
      .option('--project', 'print project config path')
      .description('print project config path')
      .action(async (opts: { global?: boolean }, cmd: Command) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const target = opts.global
          ? globalConfigPath()
          : getProjectConfigPath(config.cwd);
        ctx.io.stdout.write(`${target}\n`);
      });
    configCmd
      .command('init')
      .option('--global', 'initialize global config')
      .option('--project', 'initialize project config directory')
      .option('--force', 'overwrite existing target config file')
      .description('initialize config files/directories')
      .action(
        async (
          opts: {
            global?: boolean;
            project?: boolean;
            force?: boolean;
          },
          cmd: Command,
        ) => {
          const config = await ctx.resolveConfig(cmd.optsWithGlobals());
          if (opts.global === true) {
            await ensureGlobalConfig({ force: opts.force ?? false });
            ctx.io.stdout.write(`initialized\t${globalConfigPath()}\n`);
            return;
          }
          await ensureProjectConfig(config.cwd, { force: opts.force ?? false });
          ctx.io.stdout.write(
            `initialized\t${getProjectConfigPath(config.cwd)}\n`,
          );
        },
      );
    configCmd
      .command('get')
      .argument('[key]', 'dotted config key')
      .option('--source <source>', 'merged | global | project | override')
      .description('print merged config')
      .action(
        async (
          key: string | undefined,
          opts: { source?: string },
          cmd: Command,
        ) => {
          const config = await ctx.resolveConfig(cmd.optsWithGlobals());
          const value = await getConfigValue(
            config.cwd,
            key,
            normalizeConfigSource(opts.source),
          );
          ctx.io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
        },
      );
    configCmd
      .command('set')
      .argument('<key>', 'config key')
      .argument('<value>', 'config value')
      .option('--global', 'write global config')
      .option('--project', 'write project config')
      .description('set a project config key')
      .action(
        async (
          key: string,
          value: string,
          opts: { global?: boolean },
          cmd: Command,
        ) => {
          const config = await ctx.resolveConfig(cmd.optsWithGlobals());
          const [parsedKey, rawValue] = splitConfigSetPrompt(`${key} ${value}`);
          const next = await setConfigValue(
            config.cwd,
            writableConfigSource(opts),
            parsedKey,
            parseConfigValue(rawValue),
          );
          ctx.io.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
        },
      );
    configCmd
      .command('sources')
      .description('print config source order')
      .action(async (_opts: unknown, cmd: Command) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const sources = await loadConfigSources(config.cwd);
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(sources, null, 2) : sources.map((source) => `${source.name}\t${source.path ?? '<runtime>'}`).join('\n')}\n`,
        );
      });
  },
};

function normalizeConfigSource(
  value: string | undefined,
): ConfigSourceName | 'merged' {
  if (value === undefined || value === 'merged') {
    return 'merged';
  }
  if (
    value === 'defaults' ||
    value === 'global' ||
    value === 'project' ||
    value === 'override'
  ) {
    return value;
  }
  throw new Error(`Unknown config source: ${value}`);
}

function writableConfigSource(opts: {
  readonly global?: boolean;
}): WritableConfigSourceName {
  if (opts.global === true) {
    return 'global';
  }
  return 'project';
}
