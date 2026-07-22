import type { Command } from 'commander';

import type {
  ClientMethod,
  ClientParams,
  ClientResult,
} from '../../api/protocol-types.js';
import { writeJson, writeText } from '../render.js';
import {
  closeConnection,
  connectClientFor,
  firstThreadId,
} from '../shared/connection.js';
import { resolveGlobalOptions } from '../shared/options.js';
import type { GlobalCliOptions } from '../types.js';

/** 管理类命令统一在 finally 关闭连接，避免短生命周期 CLI 遗留 transport。 */
export function registerManagementCommands(program: Command): void {
  program
    .command('sessions')
    .alias('threads')
    .description('list threads')
    .option('--json')
    .action(async (_options: Record<string, unknown>, command: Command) => {
      await runManagement(resolveGlobalOptions(command), 'thread/list', {
        archived: false,
        limit: 50,
      });
    });

  program
    .command('tools')
    .description('list tools')
    .option('--thread <threadId>')
    .option('--json')
    .action(async (options: { thread?: string }, command: Command) => {
      const global = resolveGlobalOptions(command);
      await runManagement(global, 'tool/list', {
        cwd: global.root ?? process.cwd(),
        ...(options.thread === undefined ? {} : { threadId: options.thread }),
      });
    });

  program
    .command('config <operation>')
    .description('read, initialize, or list config sources')
    .option('--json')
    .action(
      async (
        operation: string,
        _options: Record<string, unknown>,
        command: Command,
      ) => {
        const global = resolveGlobalOptions(command);
        const cwd = global.root ?? process.cwd();
        if (operation === 'read') {
          await runManagement(global, 'config/read', {
            cwd,
            includeSources: true,
          });
        } else if (operation === 'sources') {
          await runManagement(global, 'config/sources', { cwd });
        } else if (operation === 'init') {
          await runManagement(global, 'config/init', { cwd, force: false });
        } else {
          throw new Error(`Unsupported config operation ${operation}.`);
        }
      },
    );

  program
    .command('skills [operation] [name]')
    .description('list, read, or reload skills')
    .option('--thread <threadId>')
    .option('--json')
    .action(
      async (
        operation = 'list',
        name: string | undefined,
        options: { thread?: string },
        command: Command,
      ) => {
        const global = resolveGlobalOptions(command);
        const common = {
          cwd: global.root ?? process.cwd(),
          ...(options.thread === undefined ? {} : { threadId: options.thread }),
        };
        if (operation === 'list') {
          await runManagement(global, 'skills/list', common);
        } else if (operation === 'reload') {
          await runManagement(global, 'skills/reload', common);
        } else if (operation === 'get' && name !== undefined) {
          await runManagement(global, 'skills/get', { ...common, name });
        } else {
          throw new Error(`Unsupported skills operation ${operation}.`);
        }
      },
    );

  program
    .command('goal <operation> [objective...]')
    .description('read or update a thread goal')
    .option('--thread <threadId>')
    .option('--tokens <count>')
    .option('--json')
    .action(
      async (
        operation: string,
        objective: readonly string[],
        options: { thread?: string; tokens?: string },
        command: Command,
      ) => {
        const global = resolveGlobalOptions(command);
        const threadId = options.thread ?? (await firstThreadId(global));
        if (threadId === undefined) {
          throw new Error('A thread is required for goal operations.');
        }
        if (operation === 'get') {
          await runManagement(global, 'thread/goal/get', { threadId });
        } else if (operation === 'clear') {
          await runManagement(global, 'thread/goal/clear', { threadId });
        } else if (operation === 'set' && objective.length > 0) {
          const tokenBudget =
            options.tokens === undefined ? undefined : Number(options.tokens);
          if (
            tokenBudget !== undefined &&
            (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
          ) {
            throw new Error('--tokens must be a positive integer.');
          }
          await runManagement(global, 'thread/goal/set', {
            threadId,
            objective: objective.join(' '),
            ...(tokenBudget === undefined ? {} : { tokenBudget }),
          });
        } else {
          throw new Error(`Unsupported goal operation ${operation}.`);
        }
      },
    );

  program
    .command('thread <operation> [threadId]')
    .description('read or manage threads')
    .option('--archived')
    .option('--format <format>', 'jsonl, html, or markdown', 'markdown')
    .option('--json')
    .action(
      async (
        operation: string,
        threadId: string | undefined,
        options: { archived?: boolean; format: string },
        command: Command,
      ) => {
        const global = resolveGlobalOptions(command);
        if (operation === 'list') {
          await runManagement(global, 'thread/list', {
            archived: options.archived === true,
            limit: 50,
          });
          return;
        }
        if (operation === 'loaded') {
          await runManagement(global, 'thread/loaded/list', {});
          return;
        }
        if (threadId === undefined) {
          throw new Error(`thread ${operation} requires a thread id.`);
        }
        if (operation === 'read') {
          await runManagement(global, 'thread/read', {
            threadId,
            includeTurns: true,
            includeItems: true,
          });
        } else if (operation === 'archive') {
          await runManagement(global, 'thread/archive', { threadId });
        } else if (operation === 'unarchive') {
          await runManagement(global, 'thread/unarchive', { threadId });
        } else if (operation === 'delete') {
          await runManagement(global, 'thread/delete', { threadId });
        } else if (operation === 'compact') {
          await runManagement(global, 'thread/compact/start', { threadId });
        } else if (operation === 'export') {
          await runManagement(global, 'thread/export', {
            threadId,
            format: parseThreadExportFormat(options.format),
          });
        } else {
          throw new Error(`Unsupported thread operation ${operation}.`);
        }
      },
    );

  program
    .command('memory <operation>')
    .description('read or run memory jobs')
    .option('--thread <threadId>')
    .option('--json')
    .action(
      async (
        operation: string,
        options: { thread?: string },
        command: Command,
      ) => {
        const global = resolveGlobalOptions(command);
        const params = {
          cwd: global.root ?? process.cwd(),
          ...(options.thread === undefined ? {} : { threadId: options.thread }),
        };
        if (operation === 'status') {
          await runManagement(global, 'memory/status', params);
        } else if (operation === 'reload') {
          await runManagement(global, 'memory/reload', params);
        } else if (operation === 'dream') {
          await runManagement(global, 'memory/dream/start', params);
        } else {
          throw new Error(`Unsupported memory operation ${operation}.`);
        }
      },
    );

  program
    .command('tasks <operation> [id]')
    .description('list, read, claim, or delete tasks')
    .option('--board <boardId>')
    .option('--owner <owner>')
    .option('--json')
    .action(
      async (
        operation: string,
        id: string | undefined,
        options: { board?: string; owner?: string },
        command: Command,
      ) => {
        const global = resolveGlobalOptions(command);
        if (operation === 'list') {
          await runManagement(global, 'task/list', {
            limit: 50,
            ...(options.board === undefined ? {} : { boardId: options.board }),
          });
          return;
        }
        if (id === undefined) {
          throw new Error(`tasks ${operation} requires an id.`);
        }
        if (operation === 'get') {
          await runManagement(global, 'task/get', { id });
        } else if (operation === 'delete') {
          await runManagement(global, 'task/delete', { id });
        } else if (operation === 'claim' && options.owner !== undefined) {
          await runManagement(global, 'task/claim', {
            id,
            owner: options.owner,
          });
        } else {
          throw new Error(`Unsupported tasks operation ${operation}.`);
        }
      },
    );
}

export async function runManagement<
  M extends Exclude<ClientMethod, 'initialize'>,
>(global: GlobalCliOptions, method: M, params: ClientParams<M>): Promise<void> {
  const result = await requestManagement(global, method, params);
  if (global.json === true) writeJson(result);
  else writeText(result);
}

export async function requestManagement<
  M extends Exclude<ClientMethod, 'initialize'>,
>(
  global: GlobalCliOptions,
  method: M,
  params: ClientParams<M>,
): Promise<ClientResult<M>> {
  const connection = await connectClientFor(global);
  try {
    return await connection.client.request(method, params);
  } finally {
    await closeConnection(connection.client);
  }
}

function parseThreadExportFormat(
  value: string,
): ClientParams<'thread/export'>['format'] {
  switch (value) {
    case 'jsonl':
    case 'html':
    case 'markdown':
      return value;
    default:
      throw new Error(`Unsupported export format ${value}.`);
  }
}
