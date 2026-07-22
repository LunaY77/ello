import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Command } from 'commander';

import {
  JsonValueSchema,
  type ClientParams,
} from '../../api/protocol-types.js';
import { writeJson, writeText } from '../render.js';
import { resolveGlobalOptions } from '../shared/options.js';
import type { GlobalCliOptions } from '../types.js';

import { requestManagement, runManagement } from './management.js';

/** 组装 Workspace 与 Repository 命令，并在进入 Server RPC 前解析用户选择器。 */
export function registerWorkspaceCommands(program: Command): void {
  registerRepositoryCommands(program);

  const workspace = program
    .command('workspace')
    .alias('ws')
    .description('list, read, or manage workspaces')
    .option('--json');

  workspace
    .command('create <selector> <repo...>')
    .description('create a workspace from registered repositories')
    .option('--tmux [name]', 'create and bind a tmux session')
    .option('--json')
    .action(
      async (
        selector: string,
        repos: readonly string[],
        options: { tmux?: true | string },
        command: Command,
      ) => {
        const global = resolveGlobalOptions(command);
        const { kind, name } = parseWorkspaceSelector(selector);
        await runManagement(global, 'workspace/create', {
          kind,
          name,
          repos: [...repos],
          ...(options.tmux === undefined
            ? {}
            : {
                tmux:
                  typeof options.tmux === 'string'
                    ? options.tmux
                    : `${kind}-${name}`,
              }),
        });
      },
    );

  workspace
    .command('list')
    .description('list active workspaces')
    .option('--kind <kind>')
    .option('--status <status>')
    .option('--json')
    .action(
      async (options: { kind?: string; status?: string }, command: Command) => {
        await runManagement(resolveGlobalOptions(command), 'workspace/list', {
          ...(options.kind === undefined
            ? {}
            : { kind: parseWorkspaceKind(options.kind) }),
          ...(options.status === undefined
            ? {}
            : { status: parseWorkspaceStatus(options.status) }),
        });
      },
    );

  workspace
    .command('archived [selector]')
    .description('list archived workspaces')
    .option('--json')
    .action(
      async (
        selector: string | undefined,
        _options: unknown,
        command: Command,
      ) => {
        await runManagement(
          resolveGlobalOptions(command),
          'workspace/archived/list',
          selector === undefined ? {} : { workspace: selector },
        );
      },
    );

  const workspaceRead = workspace
    .command('show [selector]')
    .alias('read')
    .description('read one workspace');
  workspaceRead
    .option('--id <id>')
    .option('--json')
    .action(
      async (
        selector: string | undefined,
        options: { id?: string },
        command: Command,
      ) => {
        await runManagement(resolveGlobalOptions(command), 'workspace/read', {
          workspace: requireWorkspaceIdentifier(selector, options.id),
        });
      },
    );

  const workspacePath = workspace
    .command('path [selector]')
    .description('print the workspace path');
  workspacePath
    .option('--id <id>')
    .option('--json')
    .action(
      async (
        selector: string | undefined,
        options: { id?: string },
        command: Command,
      ) => {
        await runManagement(resolveGlobalOptions(command), 'workspace/path', {
          workspace: requireWorkspaceIdentifier(selector, options.id),
        });
      },
    );

  const workspaceStatus = workspace
    .command('status [selector]')
    .description('show workspace filesystem and Git status');
  workspaceStatus
    .option('--id <id>')
    .option('--json')
    .action(
      async (
        selector: string | undefined,
        options: { id?: string },
        command: Command,
      ) => {
        await runManagement(resolveGlobalOptions(command), 'workspace/status', {
          workspace: await resolveWorkspaceIdentifier(
            resolveGlobalOptions(command),
            workspaceIdentifier(selector, options.id),
          ),
        });
      },
    );

  const workspaceRepo = workspace
    .command('repo')
    .description('manage repositories attached to a workspace');
  workspaceRepo
    .command('add <repo...>')
    .description('add repositories to a workspace')
    .option('--workspace <selector>')
    .option('--detached', 'add detached reference checkouts')
    .option('--json')
    .action(
      async (
        repos: readonly string[],
        options: { workspace?: string; detached?: boolean },
        command: Command,
      ) => {
        const global = resolveGlobalOptions(command);
        const workspaceId = await resolveWorkspaceIdentifier(
          global,
          options.workspace,
        );
        await runManagement(global, 'workspace/repo/add', {
          workspace: workspaceId,
          ...repositorySelection(repos),
          role: options.detached === true ? 'reference' : 'development',
          detached: options.detached === true,
        });
      },
    );

  workspaceRepo
    .command('create <key>')
    .description('create and attach a managed repository')
    .option('--workspace <selector>')
    .option('--json')
    .action(
      async (
        key: string,
        options: { workspace?: string },
        command: Command,
      ) => {
        await runManagement(
          resolveGlobalOptions(command),
          'workspace/repo/create',
          {
            workspace: await resolveWorkspaceIdentifier(
              resolveGlobalOptions(command),
              options.workspace,
            ),
            key,
          },
        );
      },
    );

  workspaceRepo
    .command('remove <repo...>')
    .description('remove repositories from a workspace')
    .option('--workspace <selector>')
    .option('--force', 'discard dirty worktree content')
    .option('--json')
    .action(
      async (
        repos: readonly string[],
        options: { workspace?: string; force?: boolean },
        command: Command,
      ) => {
        const global = resolveGlobalOptions(command);
        const workspaceId = await resolveWorkspaceIdentifier(
          global,
          options.workspace,
        );
        await runManagement(global, 'workspace/repo/remove', {
          workspace: workspaceId,
          ...repositorySelection(repos),
          force: options.force === true,
        });
      },
    );

  const workspaceRename = workspace
    .command('rename <selector> <newName>')
    .description('rename an active workspace');
  workspaceRename
    .option('--json')
    .action(
      async (
        selector: string,
        newName: string,
        _options: Record<string, unknown>,
        command: Command,
      ) => {
        await runManagement(resolveGlobalOptions(command), 'workspace/rename', {
          workspace: selector,
          name: newName,
        });
      },
    );

  const workspaceArchive = workspace
    .command('archive <selector>')
    .description('archive an active workspace');
  workspaceArchive
    .option('--json')
    .action(async (selector: string, _options: unknown, command: Command) => {
      await runManagement(resolveGlobalOptions(command), 'workspace/archive', {
        workspace: selector,
      });
    });

  const workspaceDelete = workspace
    .command('delete [selector]')
    .description('delete a workspace');
  workspaceDelete
    .option('--force', 'discard dirty worktree and workspace content')
    .option('--archived', 'delete an archived workspace')
    .option('--id <id>', 'delete one workspace by id')
    .option('--json')
    .action(
      async (
        selector: string | undefined,
        options: { force?: boolean; archived?: boolean; id?: string },
        command: Command,
      ) => {
        await runManagement(resolveGlobalOptions(command), 'workspace/delete', {
          workspace: requireWorkspaceIdentifier(selector, options.id),
          archived: options.archived === true,
          force: options.force === true,
        });
      },
    );

  for (const operation of ['reconcile', 'repair'] as const) {
    const command = workspace
      .command(`${operation} [selector]`)
      .description(`${operation} workspace filesystem and metadata`)
      .option('--id <id>')
      .option('--json');
    command.action(
      async (
        selector: string | undefined,
        options: { id?: string },
        cmd: Command,
      ) => {
        const selected = workspaceIdentifier(selector, options.id);
        await runManagement(
          resolveGlobalOptions(cmd),
          `workspace/${operation}`,
          {
            ...(selected === undefined ? {} : { workspace: selected }),
          },
        );
      },
    );
  }

  const workspaceTmux = workspace
    .command('tmux')
    .description('manage workspace tmux sessions');
  workspaceTmux
    .command('new <selector>')
    .option('--name <name>')
    .option('--json')
    .action(
      async (
        selector: string,
        options: { name?: string },
        command: Command,
      ) => {
        await runManagement(
          resolveGlobalOptions(command),
          'workspace/tmux/new',
          {
            workspace: selector,
            ...(options.name === undefined ? {} : { name: options.name }),
          },
        );
      },
    );
}

/** Repository registry 是 Workspace 领域的共享仓库来源，命令与 Workspace 生命周期就近注册。 */
function registerRepositoryCommands(program: Command): void {
  const repository = program
    .command('repo')
    .description('manage the Workspace repository registry')
    .option('--json');

  repository
    .command('add <key> <source>')
    .description('register a local or remote repository')
    .option('--remote-url <url>', 'attach origin after importing local source')
    .option('--json')
    .action(
      async (
        key: string,
        source: string,
        options: { remoteUrl?: string },
        command: Command,
      ) => {
        await runManagement(resolveGlobalOptions(command), 'repo/add', {
          key,
          source,
          ...(options.remoteUrl === undefined
            ? {}
            : { remoteUrl: options.remoteUrl }),
        });
      },
    );

  repository
    .command('list')
    .description('list registered repositories')
    .option('--json')
    .action(async (_options: unknown, command: Command) => {
      await runManagement(resolveGlobalOptions(command), 'repo/list', {});
    });

  const repositoryRead = repository
    .command('show <repo>')
    .alias('read')
    .description('read one registered repository');
  repositoryRead
    .option('--json')
    .action(async (repo: string, _options: unknown, command: Command) => {
      await runManagement(resolveGlobalOptions(command), 'repo/read', { repo });
    });

  repository
    .command('rename <repo> <name>')
    .description('rename a registered repository key')
    .option('--json')
    .action(
      async (
        repo: string,
        name: string,
        _options: unknown,
        command: Command,
      ) => {
        await runManagement(resolveGlobalOptions(command), 'repo/rename', {
          repo,
          name,
        });
      },
    );

  repository
    .command('remove <repo>')
    .description('remove an unreferenced registered repository')
    .option('--json')
    .action(async (repo: string, _options: unknown, command: Command) => {
      await runManagement(resolveGlobalOptions(command), 'repo/remove', {
        repo,
      });
    });

  repository
    .command('fetch <repo>')
    .description('fetch a repository origin and refresh its baseline')
    .option('--json')
    .action(async (repo: string, _options: unknown, command: Command) => {
      await runManagement(resolveGlobalOptions(command), 'repo/fetch', {
        repo,
      });
    });

  repository
    .command('fetch-local <repo> <path>')
    .description('refresh a repository from a local Git directory')
    .option('--json')
    .action(
      async (
        repo: string,
        sourcePath: string,
        _options: unknown,
        command: Command,
      ) => {
        await runManagement(resolveGlobalOptions(command), 'repo/fetchLocal', {
          repo,
          path: sourcePath,
        });
      },
    );

  registerRepositoryRemoteCommands(repository);

  repository
    .command('export [repos...]')
    .description('export registered repositories as a portable JSON document')
    .option('--json')
    .action(
      async (repos: readonly string[], _options: unknown, command: Command) => {
        const global = resolveGlobalOptions(command);
        const result = await requestManagement(global, 'repo/export', {
          ...(repos.length === 0 ? {} : { repos: [...repos] }),
        });
        if (global.json === true) writeJson(result.document);
        else writeText(result.document);
      },
    );

  repository
    .command('import <file>')
    .description('import a portable repository JSON document')
    .option('--json')
    .action(async (file: string, _options: unknown, command: Command) => {
      await runManagement(resolveGlobalOptions(command), 'repo/import', {
        document: await readRepositoryImport(file),
      });
    });
}

/** origin 是当前 Repository 唯一公开 remote，CLI 不暴露无效的任意 remote 名称。 */
function registerRepositoryRemoteCommands(repository: Command): void {
  const remote = repository
    .command('remote')
    .description('read or update the repository origin');
  const remoteRead = remote
    .command('show <repo>')
    .alias('read')
    .description('read the repository origin');
  remoteRead
    .option('--json')
    .action(async (repo: string, _options: unknown, command: Command) => {
      await runManagement(resolveGlobalOptions(command), 'repo/remote/read', {
        repo,
      });
    });

  for (const operation of ['add', 'set'] as const) {
    remote
      .command(`${operation} <repo> <url>`)
      .description(`${operation} the repository origin`)
      .option('--json')
      .action(
        async (
          repo: string,
          url: string,
          _options: unknown,
          command: Command,
        ) => {
          await runManagement(
            resolveGlobalOptions(command),
            `repo/remote/${operation}`,
            { repo, name: 'origin', url },
          );
        },
      );
  }

  remote
    .command('remove <repo>')
    .description('remove the repository origin')
    .option('--json')
    .action(async (repo: string, _options: unknown, command: Command) => {
      await runManagement(resolveGlobalOptions(command), 'repo/remote/remove', {
        repo,
        name: 'origin',
      });
    });
}

/** 从单个 JSON 文件读取 portable repository document，非法 JSON 值直接失败。 */
async function readRepositoryImport(
  filePath: string,
): Promise<ClientParams<'repo/import'>['document']> {
  const text = await readFile(path.resolve(filePath), 'utf8');
  return JsonValueSchema.parse(JSON.parse(text));
}

function parseWorkspaceSelector(selector: string): {
  readonly kind: 'feature' | 'fix' | 'refactor' | 'explore';
  readonly name: string;
} {
  const slash = selector.indexOf('/');
  if (
    slash <= 0 ||
    slash === selector.length - 1 ||
    selector.indexOf('/', slash + 1) !== -1
  ) {
    throw new Error(`Invalid workspace selector: ${selector}`);
  }
  const kind = selector.slice(0, slash);
  if (
    kind !== 'feature' &&
    kind !== 'fix' &&
    kind !== 'refactor' &&
    kind !== 'explore'
  ) {
    throw new Error(`Invalid workspace selector: ${selector}`);
  }
  return { kind, name: selector.slice(slash + 1) };
}

type WorkspaceListParams = ClientParams<'workspace/list'>;
type WorkspaceKind = NonNullable<WorkspaceListParams['kind']>;
type WorkspaceStatus = NonNullable<WorkspaceListParams['status']>;

function parseWorkspaceKind(value: string): WorkspaceKind {
  switch (value) {
    case 'feature':
    case 'fix':
    case 'refactor':
    case 'explore':
      return value;
    default:
      throw new Error(`Invalid workspace kind: ${value}`);
  }
}

function parseWorkspaceStatus(value: string): WorkspaceStatus {
  switch (value) {
    case 'active':
    case 'archived':
    case 'missing':
    case 'deleted':
      return value;
    default:
      throw new Error(`Invalid workspace status: ${value}`);
  }
}

function repositorySelection(
  repositories: readonly string[],
): { readonly repo: string } | { readonly repos: string[] } {
  const first = repositories.at(0);
  if (first === undefined) {
    throw new Error('At least one repository is required.');
  }
  return repositories.length === 1
    ? { repo: first }
    : { repos: [...repositories] };
}

function workspaceIdentifier(
  selector: string | undefined,
  id?: string,
): string | undefined {
  if (selector !== undefined && id !== undefined)
    throw new Error('Specify a workspace selector or --id');
  return selector ?? id;
}

function requireWorkspaceIdentifier(
  selector: string | undefined,
  id?: string,
): string {
  const workspace = workspaceIdentifier(selector, id);
  if (workspace === undefined)
    throw new Error('Workspace selector or --id is required');
  return workspace;
}

async function resolveWorkspaceIdentifier(
  global: GlobalCliOptions,
  selector: string | undefined,
): Promise<string> {
  if (selector !== undefined) return selector;
  const result = await requestManagement(global, 'workspace/list', {});
  const cwd = path.resolve(global.root ?? process.cwd());
  const workspace = result.data.find(
    (candidate) => path.resolve(candidate.rootPath) === cwd,
  );
  if (workspace === undefined) {
    throw new Error(`Current directory is not a workspace root: ${cwd}`);
  }
  return workspace.id;
}
