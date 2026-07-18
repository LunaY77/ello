#!/usr/bin/env node
import { Command } from 'commander';

import type { AppServerClient } from '../api/client.js';
import type {
  ClientMethod,
  ClientParams,
  ServerNotification,
} from '../api/protocol-types.js';
import { connectClient } from '../client/connection.js';
import { createThreadClient } from '../client/thread-client.js';
import { renderTui } from '../tui/index.js';
import { ELLO_TUI_VERSION } from '../version.js';

import { renderSnapshot, writeJson, writeText } from './render.js';
import { runAppServer } from './server-launcher.js';
import { authTokenFromOptions, type GlobalCliOptions } from './types.js';

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

program
  .command('app-server')
  .description('run the App Server process')
  .requiredOption('--listen <endpoint>')
  .option('--root <path>')
  .option('--auth-token-env <name>')
  .option('--capabilities <list>', 'comma-separated remote capabilities')
  .action(
    async (commandOptions: {
      listen: string;
      root?: string;
      authTokenEnv?: string;
      capabilities?: string;
    }) => {
      await runAppServer(commandOptions);
    },
  );

program
  .command('run [prompt...]')
  .description('start a thread turn')
  .option('--thread <threadId>')
  .option('--model <model>')
  .option('--profile <profile>')
  .option('--mode <mode>', 'ask-before-changes, accept-edits, plan, or bypass')
  .option('--json')
  .option('--no-tui')
  .action(
    async (
      promptParts: readonly string[],
      commandOptions: Record<string, unknown>,
      command: Command,
    ) => {
      const global = resolveGlobalOptions(command);
      await runPrompt(promptParts.join(' ').trim(), {
        ...global,
        ...normalizeOptions(commandOptions),
      });
    },
  );

program
  .command('resume [threadId]')
  .description('resume a thread')
  .option('--json')
  .option('--no-tui')
  .action(
    async (
      threadId: string | undefined,
      commandOptions: Record<string, unknown>,
      command: Command,
    ) => {
      const global = resolveGlobalOptions(command);
      const connection = await connectClientFor(global);
      try {
        const id =
          threadId ??
          (
            await connection.client.request('thread/list', {
              archived: false,
              limit: 1,
            })
          ).data[0]?.id;
        if (id === undefined)
          throw new Error('No active thread is available to resume.');
        const snapshot = await connection.client.request('thread/resume', {
          threadId: id,
          subscribe: true,
        });
        if (global.json || commandOptions.json === true) writeJson(snapshot);
        else if (
          global.noTui ||
          commandOptions.tui === false ||
          !process.stdout.isTTY
        )
          renderSnapshot(snapshot);
        else
          await renderTui(
            createThreadClient({ server: connection.client, snapshot }),
          );
      } finally {
        await closeConnection(connection.client);
      }
    },
  );

program
  .command('sessions')
  .alias('threads')
  .description('list threads')
  .option('--json')
  .action(async (_options: Record<string, unknown>, command: Command) => {
    const global = resolveGlobalOptions(command);
    await runManagement(global, 'thread/list', { archived: false, limit: 50 });
  });

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
      const global = resolveGlobalOptions(command);
      await runCatalog(global, 'model/list', operation, modelId);
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
      const global = resolveGlobalOptions(command);
      await runCatalog(global, 'provider/list', operation, providerId);
    },
  );

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
      if (operation === 'read')
        await runManagement(global, 'config/read', {
          cwd,
          includeSources: true,
        });
      else if (operation === 'sources')
        await runManagement(global, 'config/sources', { cwd });
      else if (operation === 'init')
        await runManagement(global, 'config/init', { cwd, force: false });
      else throw new Error(`Unsupported config operation ${operation}.`);
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
      if (operation === 'list')
        await runManagement(global, 'skills/list', common);
      else if (operation === 'reload')
        await runManagement(global, 'skills/reload', common);
      else if (operation === 'get' && name !== undefined)
        await runManagement(global, 'skills/get', { ...common, name });
      else throw new Error(`Unsupported skills operation ${operation}.`);
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
      if (threadId === undefined)
        throw new Error('A thread is required for goal operations.');
      if (operation === 'get')
        await runManagement(global, 'thread/goal/get', { threadId });
      else if (operation === 'clear')
        await runManagement(global, 'thread/goal/clear', { threadId });
      else if (operation === 'set' && objective.length > 0) {
        const tokenBudget =
          options.tokens === undefined ? undefined : Number(options.tokens);
        if (
          tokenBudget !== undefined &&
          (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)
        )
          throw new Error('--tokens must be a positive integer.');
        await runManagement(global, 'thread/goal/set', {
          threadId,
          objective: objective.join(' '),
          ...(tokenBudget === undefined ? {} : { tokenBudget }),
        });
      } else throw new Error(`Unsupported goal operation ${operation}.`);
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
      if (operation === 'list')
        await runManagement(global, 'thread/list', {
          archived: options.archived === true,
          limit: 50,
        });
      else if (operation === 'loaded')
        await runManagement(global, 'thread/loaded/list', {});
      else {
        if (threadId === undefined)
          throw new Error(`thread ${operation} requires a thread id.`);
        if (operation === 'read')
          await runManagement(global, 'thread/read', {
            threadId,
            includeTurns: true,
            includeItems: true,
          });
        else if (operation === 'archive')
          await runManagement(global, 'thread/archive', { threadId });
        else if (operation === 'unarchive')
          await runManagement(global, 'thread/unarchive', { threadId });
        else if (operation === 'delete')
          await runManagement(global, 'thread/delete', { threadId });
        else if (operation === 'compact')
          await runManagement(global, 'thread/compact/start', { threadId });
        else if (operation === 'export') {
          if (!['jsonl', 'html', 'markdown'].includes(options.format))
            throw new Error(`Unsupported export format ${options.format}.`);
          await runManagement(global, 'thread/export', {
            threadId,
            format: options.format as 'jsonl' | 'html' | 'markdown',
          });
        } else throw new Error(`Unsupported thread operation ${operation}.`);
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
      if (operation === 'status')
        await runManagement(global, 'memory/status', params);
      else if (operation === 'reload')
        await runManagement(global, 'memory/reload', params);
      else if (operation === 'dream')
        await runManagement(global, 'memory/dream/start', params);
      else throw new Error(`Unsupported memory operation ${operation}.`);
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
      if (operation === 'list')
        await runManagement(global, 'task/list', {
          limit: 50,
          ...(options.board === undefined ? {} : { boardId: options.board }),
        });
      else {
        if (id === undefined)
          throw new Error(`tasks ${operation} requires an id.`);
        if (operation === 'get')
          await runManagement(global, 'task/get', { id });
        else if (operation === 'delete')
          await runManagement(global, 'task/delete', { id });
        else if (operation === 'claim' && options.owner !== undefined)
          await runManagement(global, 'task/claim', {
            id,
            owner: options.owner,
          });
        else throw new Error(`Unsupported tasks operation ${operation}.`);
      }
    },
  );

program
  .command('repo <operation> [repo]')
  .description('list, read, fetch, or remove repositories')
  .option('--json')
  .action(
    async (
      operation: string,
      repo: string | undefined,
      _options: Record<string, unknown>,
      command: Command,
    ) => {
      const global = resolveGlobalOptions(command);
      if (operation === 'list') await runManagement(global, 'repo/list', {});
      else {
        if (repo === undefined)
          throw new Error(`repo ${operation} requires a repository.`);
        if (operation === 'read')
          await runManagement(global, 'repo/read', { repo });
        else if (operation === 'fetch')
          await runManagement(global, 'repo/fetch', { repo });
        else if (operation === 'remove')
          await runManagement(global, 'repo/remove', { repo });
        else throw new Error(`Unsupported repo operation ${operation}.`);
      }
    },
  );

program
  .command('workspace <operation> [workspace]')
  .description('list, read, or manage workspaces')
  .option('--force')
  .option('--json')
  .action(
    async (
      operation: string,
      workspace: string | undefined,
      options: { force?: boolean },
      command: Command,
    ) => {
      const global = resolveGlobalOptions(command);
      if (operation === 'list')
        await runManagement(global, 'workspace/list', {});
      else if (operation === 'archived')
        await runManagement(global, 'workspace/archived/list', {});
      else {
        if (workspace === undefined)
          throw new Error(`workspace ${operation} requires a workspace.`);
        if (operation === 'read')
          await runManagement(global, 'workspace/read', { workspace });
        else if (operation === 'path')
          await runManagement(global, 'workspace/path', { workspace });
        else if (operation === 'status')
          await runManagement(global, 'workspace/status', { workspace });
        else if (operation === 'archive')
          await runManagement(global, 'workspace/archive', { workspace });
        else if (operation === 'delete')
          await runManagement(global, 'workspace/delete', {
            workspace,
            force: options.force === true,
          });
        else if (operation === 'reconcile')
          await runManagement(global, 'workspace/reconcile', { workspace });
        else if (operation === 'repair')
          await runManagement(global, 'workspace/repair', { workspace });
        else throw new Error(`Unsupported workspace operation ${operation}.`);
      }
    },
  );

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

async function runPrompt(
  prompt: string,
  options: GlobalCliOptions & {
    thread?: string;
    model?: string;
    profile?: string;
    mode?: string;
  },
): Promise<void> {
  if (prompt === '') {
    if (options.noTui === true && !process.stdout.isTTY)
      throw new Error('run requires a prompt in non-interactive mode.');
    const connection = await connectClientFor(options);
    try {
      const snapshot =
        options.thread === undefined
          ? await connection.client.request('thread/start', {
              cwd: options.root ?? process.cwd(),
              subscribe: true,
            })
          : await connection.client.request('thread/resume', {
              threadId: options.thread,
              subscribe: true,
            });
      await renderTui(
        createThreadClient({ server: connection.client, snapshot }),
      );
    } finally {
      await closeConnection(connection.client);
    }
    return;
  }
  const connection = await connectClientFor(options);
  try {
    const snapshot =
      options.thread === undefined
        ? await connection.client.request('thread/start', {
            cwd: options.root ?? process.cwd(),
            subscribe: true,
          })
        : await connection.client.request('thread/resume', {
            threadId: options.thread,
            subscribe: true,
          });
    const thread = createThreadClient({ server: connection.client, snapshot });
    const notifications: ServerNotification[] = [];
    const stop = connection.client.onNotification((notification) => {
      notifications.push(notification);
      if (options.json === true) writeJson(notification);
    });
    if (options.model !== undefined) await thread.setModel(options.model);
    if (options.profile !== undefined) await thread.setProfile(options.profile);
    if (options.mode !== undefined) {
      await thread.setMode(parseMode(options.mode));
    }
    const turnId = await thread.submit(prompt);
    if (options.json !== true) writeText(`turn ${turnId}`);
    await waitForTurn(connection.client, thread.threadId, turnId);
    stop();
    if (options.json !== true) renderSnapshot(thread.snapshot);
    void notifications;
  } finally {
    await closeConnection(connection.client);
  }
}

function parseMode(
  value: string,
): import('../api/protocol-types.js').SessionMode {
  if (
    value === 'ask-before-changes' ||
    value === 'plan' ||
    value === 'accept-edits' ||
    value === 'bypass'
  ) {
    return value;
  }
  throw new Error(`Unsupported mode ${value}.`);
}

async function waitForTurn(
  client: AppServerClient,
  threadId: string,
  turnId: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const pending: { timeout?: NodeJS.Timeout } = {};
    let stop = (): void => undefined;
    let settled = false;
    const settle = (result: { readonly error?: Error }): void => {
      if (settled) return;
      settled = true;
      stop();
      if (pending.timeout !== undefined) clearTimeout(pending.timeout);
      if (result.error === undefined) resolve();
      else reject(result.error);
    };
    stop = client.onNotification((notification) => {
      if (
        notification.method !== 'turn/completed' ||
        notification.params.threadId !== threadId ||
        notification.params.turnId !== turnId
      ) {
        return;
      }
      const turn = notification.params.turn;
      if (turn.status === 'completed') {
        settle({});
        return;
      }
      if (turn.status === 'interrupted') {
        settle({ error: new Error(`Turn ${turnId} was interrupted.`) });
        return;
      }
      if (turn.status === 'failed') {
        const errorItem = [...turn.items]
          .reverse()
          .find((item) => item.type === 'error');
        const detail =
          errorItem === undefined
            ? turn.errorCode
            : `${errorItem.code}: ${errorItem.message}`;
        settle({
          error: new Error(
            `Turn ${turnId} failed${detail === undefined ? '.' : ` (${detail}).`}`,
          ),
        });
        return;
      }
      settle({
        error: new Error(
          `Turn ${turnId} emitted a terminal notification with status ${turn.status}.`,
        ),
      });
    });
    if (settled) {
      stop();
      return;
    }
    pending.timeout = setTimeout(
      () => {
        settle({
          error: new Error(
            `Turn ${turnId} did not complete before the client timeout.`,
          ),
        });
      },
      24 * 60 * 60 * 1000,
    );
    pending.timeout.unref();
  });
}

async function runManagement<M extends Exclude<ClientMethod, 'initialize'>>(
  global: GlobalCliOptions,
  method: M,
  params: ClientParams<M>,
): Promise<void> {
  const connection = await connectClientFor(global);
  try {
    const result = await connection.client.request(method, params);
    if (global.json === true) writeJson(result);
    else writeText(result);
  } finally {
    await closeConnection(connection.client);
  }
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
    if (operation !== 'show' || id === undefined)
      throw new Error(`Unsupported catalog operation ${operation}.`);
    const entry = result.data.find(
      (candidate) => candidate.id === id || candidate.name === id,
    );
    if (entry === undefined)
      throw new Error(`Catalog entry ${id} does not exist.`);
    if (global.json === true) writeJson(entry);
    else writeText(entry);
  } finally {
    await closeConnection(connection.client);
  }
}

async function connectClientFor(options: GlobalCliOptions) {
  const authToken = authTokenFromOptions(options);
  return connectClient({
    ...(options.remote === undefined ? {} : { endpoint: options.remote }),
    ...(options.root === undefined ? {} : { root: options.root }),
    ...(authToken === undefined ? {} : { authToken }),
    ...(options.timeout === undefined
      ? {}
      : { requestTimeoutMs: options.timeout }),
  });
}

async function closeConnection(
  client: import('../api/client.js').AppServerClient,
): Promise<void> {
  await client.close();
}

async function firstThreadId(
  options: GlobalCliOptions,
): Promise<string | undefined> {
  const connection = await connectClientFor(options);
  try {
    return (
      await connection.client.request('thread/list', {
        archived: false,
        limit: 1,
      })
    ).data[0]?.id;
  } finally {
    await closeConnection(connection.client);
  }
}

function resolveGlobalOptions(command: Command): GlobalCliOptions {
  const values = command.optsWithGlobals() as Record<string, unknown>;
  return {
    ...(typeof values.remote === 'string' ? { remote: values.remote } : {}),
    ...(typeof values.remoteAuthTokenEnv === 'string'
      ? { remoteAuthTokenEnv: values.remoteAuthTokenEnv }
      : {}),
    ...(typeof values.root === 'string' ? { root: values.root } : {}),
    ...(values.json === true ? { json: true } : {}),
    ...(values.tui === false ? { noTui: true } : {}),
  };
}

function normalizeOptions(
  values: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(typeof values.thread === 'string' ? { thread: values.thread } : {}),
    ...(typeof values.model === 'string' ? { model: values.model } : {}),
    ...(typeof values.profile === 'string' ? { profile: values.profile } : {}),
    ...(typeof values.mode === 'string' ? { mode: values.mode } : {}),
    ...(values.json === true ? { json: true } : {}),
    ...(values.tui === false ? { noTui: true } : {}),
  };
}
