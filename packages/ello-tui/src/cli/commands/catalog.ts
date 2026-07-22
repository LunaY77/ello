import type { Command } from 'commander';

import { writeJson, writeText } from '../render.js';
import { closeConnection, connectClientFor } from '../shared/connection.js';
import { resolveGlobalOptions } from '../shared/options.js';
import type { GlobalCliOptions } from '../types.js';

/** Catalog 命令复用单次连接，并在本地完成 show 选择，不新增 Server 方法。 */
export function registerCatalogCommands(program: Command): void {
  program
    .command('models [operation] [modelId]')
    .description('list available models')
    .option('--json')
    .action(
      async (
        operation = 'list',
        modelId: string | undefined,
        _options: Record<string, unknown>,
        command: Command,
      ) => {
        await runCatalog(
          resolveGlobalOptions(command),
          'model/list',
          operation,
          modelId,
        );
      },
    );

  program
    .command('providers [operation] [providerId]')
    .description('list providers')
    .option('--json')
    .action(
      async (
        operation = 'list',
        providerId: string | undefined,
        _options: Record<string, unknown>,
        command: Command,
      ) => {
        await runCatalog(
          resolveGlobalOptions(command),
          'provider/list',
          operation,
          providerId,
        );
      },
    );
}

async function runCatalog(
  global: GlobalCliOptions,
  method: 'model/list' | 'provider/list',
  operation: string,
  id: string | undefined,
): Promise<void> {
  const connection = await connectClientFor(global);
  try {
    const result = await connection.client.request(method, {
      cwd: global.root ?? process.cwd(),
    });
    if (operation === 'list') {
      if (global.json === true) writeJson(result);
      else writeText(result);
      return;
    }
    if (operation !== 'show' || id === undefined) {
      throw new Error(`Unsupported catalog operation ${operation}.`);
    }
    const entry = result.data.find(
      (candidate) => candidate.id === id || candidate.name === id,
    );
    if (entry === undefined) {
      throw new Error(`Catalog entry ${id} does not exist.`);
    }
    if (global.json === true) writeJson(entry);
    else writeText(entry);
  } finally {
    await closeConnection(connection.client);
  }
}
