import type { Command } from 'commander';

import type {
  ProviderRegistry,
  RuntimeModel,
  RuntimeProvider,
} from '../../provider/index.js';
import type { CliCommandContext, CliCommandModule } from '../types.js';

export const infoCommands: CliCommandModule = {
  register(program, ctx) {
    registerSessionCommands(program, ctx);
    registerToolCommands(program, ctx);
    registerProviderCommands(program, ctx);
    registerModelCommands(program, ctx);
    registerPermissionCommands(program, ctx);
    registerMemoryCommands(program, ctx);
  },
};

function registerSessionCommands(
  program: Command,
  ctx: CliCommandContext,
): void {
  program
    .command('sessions')
    .description('list sessions')
    .option('--rebuild-catalog', 'rebuild catalog from v3 session files')
    .action(async (opts: { rebuildCatalog?: boolean }, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { JsonlSessionRepository } =
        await import('../../session/repository.js');
      const repository = new JsonlSessionRepository({
        sessionDir: config.sessionDir,
        cwd: config.cwd,
      });
      if (opts.rebuildCatalog === true) {
        const rebuilt = await repository.rebuildCatalog();
        ctx.io.stdout.write(
          `Rebuilt session catalog with ${rebuilt} sessions.\n`,
        );
      }
      const sessions = await repository.list();
      ctx.io.stdout.write(
        `${
          config.json
            ? JSON.stringify(sessions, null, 2)
            : sessions.length === 0
              ? `No sessions in ${config.sessionDir}`
              : sessions
                  .map(
                    (s) =>
                      `${s.sessionId}\t${s.entryCount} entries\t${s.updatedAt ?? 'unknown'}`,
                  )
                  .join('\n')
        }\n`,
      );
    });
}

function registerToolCommands(program: Command, ctx: CliCommandContext): void {
  program
    .command('tools')
    .description('list available tools')
    .action(async () => {
      const { describeCodingTools } = await import('../../tools/index.js');
      ctx.io.stdout.write(`${describeCodingTools()}\n`);
    });
}

function registerProviderCommands(
  program: Command,
  ctx: CliCommandContext,
): void {
  const providersCmd = program
    .command('providers')
    .description('inspect configured model providers');
  providersCmd
    .command('list')
    .description('list providers')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { createProviderRegistry } =
        await import('../../provider/index.js');
      const registry = createProviderRegistry(config);
      const providers = registry.listProviders();
      ctx.io.stdout.write(
        `${
          config.json
            ? JSON.stringify(providers.map(providerForOutput), null, 2)
            : formatProviderList(providers, registry)
        }\n`,
      );
    });
  providersCmd
    .command('doctor')
    .description('check local provider auth/config status')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { createProviderRegistry } =
        await import('../../provider/index.js');
      const registry = createProviderRegistry(config);
      const report = registry
        .listProviders()
        .map((provider) => providerDoctorReport(provider, registry));
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(report, null, 2) : formatProviderDoctor(report)}\n`,
      );
    });
}

function registerModelCommands(program: Command, ctx: CliCommandContext): void {
  const modelsCmd = program
    .command('models')
    .description('inspect provider model catalog');
  modelsCmd
    .command('list')
    .argument('[provider]', 'provider id')
    .description('list configured models')
    .action(
      async (provider: string | undefined, _opts: unknown, cmd: Command) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const { createProviderRegistry } =
          await import('../../provider/index.js');
        const registry = createProviderRegistry(config);
        const models = registry.listModels(provider);
        ctx.io.stdout.write(
          `${
            config.json
              ? JSON.stringify(models, null, 2)
              : formatModelList(models)
          }\n`,
        );
      },
    );
  modelsCmd
    .command('show')
    .argument('<model>', 'model ref, e.g. openai/gpt-5.5')
    .description('show one model')
    .action(async (model: string, _opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { createProviderRegistry, normalizeModelRef } =
        await import('../../provider/index.js');
      const registry = createProviderRegistry(config);
      const runtimeModel = registry.getModel(normalizeModelRef(model));
      ctx.io.stdout.write(
        `${
          config.json
            ? JSON.stringify(runtimeModel, null, 2)
            : formatModelDetail(runtimeModel)
        }\n`,
      );
    });
}

function registerPermissionCommands(
  program: Command,
  ctx: CliCommandContext,
): void {
  program
    .command('permissions')
    .description('show approval mode and rules')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { formatPermissionRules } = await import('../../permissions.js');
      ctx.io.stdout.write(
        `${
          config.json
            ? JSON.stringify(
                {
                  mode: config.approvalMode,
                  allowedPaths: config.allowedPaths,
                  rules: config.permissionRules,
                },
                null,
                2,
              )
            : [
                `mode\t${config.approvalMode}`,
                `allowedPaths\t${config.allowedPaths.join(', ')}`,
                formatPermissionRules(config.permissionRules),
              ].join('\n')
        }\n`,
      );
    });
}

function registerMemoryCommands(
  program: Command,
  ctx: CliCommandContext,
): void {
  program
    .command('memory')
    .description('show memory file summary')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      if (!config.context.memory.enabled) {
        const memory = {
          enabled: false,
          privateRoot: config.context.memory.private_dir,
          teamRoot: config.context.memory.team_dir,
        };
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(memory, null, 2) : `disabled\nprivate\t${memory.privateRoot}\nteam\t${memory.teamRoot}`}\n`,
        );
        return;
      }
      const { MemoryRepository, memoryRoots } =
        await import('../../memory/index.js');
      const repository = new MemoryRepository(memoryRoots(config));
      await repository.initialize();
      const counts = await repository.status();
      const memory = {
        enabled: true,
        privateRoot: repository.roots.private,
        teamRoot: repository.roots.team,
        ...counts,
      };
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(memory, null, 2) : `enabled\nprivate\t${memory.privateRoot}\t${memory.privateEntries}\nteam\t${memory.teamRoot}\t${memory.teamEntries}`}\n`,
      );
    });
}

function providerForOutput(provider: RuntimeProvider): Record<string, unknown> {
  const { apiKey: _apiKey, ...safe } = provider;
  return {
    ...safe,
    auth: providerAuthState(provider),
  };
}

function formatProviderList(
  providers: readonly RuntimeProvider[],
  registry: ProviderRegistry,
): string {
  if (providers.length === 0) {
    return 'No providers configured';
  }
  return providers
    .map(
      (provider) =>
        `${provider.id}\t${provider.enabled ? 'enabled' : 'disabled'}\t${providerAuthState(provider)}\tmodels=${registry.listModels(provider.id).length}\t${provider.kind}`,
    )
    .join('\n');
}

function providerDoctorReport(
  provider: RuntimeProvider,
  registry: ProviderRegistry,
): Record<string, unknown> {
  return {
    id: provider.id,
    enabled: provider.enabled,
    auth: providerAuthState(provider),
    apiKeyEnv: provider.apiKeyEnv ?? null,
    baseUrl: provider.baseUrl ?? null,
    kind: provider.kind,
    models: registry.listModels(provider.id).length,
  };
}

function formatProviderDoctor(
  report: readonly Record<string, unknown>[],
): string {
  if (report.length === 0) {
    return 'No providers configured';
  }
  return report
    .map(
      (item) =>
        `${item.id}\t${item.enabled === true ? 'enabled' : 'disabled'}\t${item.auth}\tmodels=${item.models}\tapi_key_env=${String(item.apiKeyEnv ?? '<none>')}`,
    )
    .join('\n');
}

function providerAuthState(provider: RuntimeProvider): string {
  if (!provider.enabled) {
    return 'disabled';
  }
  if (provider.apiKey !== undefined) {
    return 'ready';
  }
  return provider.apiKeyEnv === undefined ? 'none' : 'missing';
}

function formatModelList(models: readonly RuntimeModel[]): string {
  if (models.length === 0) {
    return 'No models configured';
  }
  return models
    .map(
      (model) =>
        `${model.ref}\t${formatEndpoint(model)}\tctx=${model.limit.context}\tout=${model.limit.output}\t${formatCapabilities(model)}`,
    )
    .join('\n');
}

function formatModelDetail(model: RuntimeModel): string {
  return [
    `ref\t${model.ref}`,
    `provider\t${model.providerId}`,
    `api_id\t${model.apiId}`,
    `endpoint\t${formatEndpoint(model)}`,
    `status\t${model.status}`,
    `context\t${model.limit.context}`,
    `output\t${model.limit.output}`,
    `capabilities\t${formatCapabilities(model)}`,
    `variants\t${Object.keys(model.variants).join(', ') || '<none>'}`,
  ].join('\n');
}

function formatEndpoint(model: RuntimeModel): string {
  return model.endpoint ?? 'languageModel';
}

function formatCapabilities(model: RuntimeModel): string {
  return [
    model.capabilities.reasoning ? 'reasoning' : null,
    model.capabilities.temperature ? 'temperature' : null,
    model.capabilities.toolCall ? 'tools' : null,
    `in:${model.capabilities.input.join('+')}`,
    `out:${model.capabilities.output.join('+')}`,
  ]
    .filter((item): item is string => item !== null)
    .join(',');
}
