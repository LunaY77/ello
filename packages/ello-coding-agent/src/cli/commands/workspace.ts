import path from 'node:path';

import type { Command } from 'commander';

import type {
  RepoStore,
  Workspace,
  WorkspaceStore,
} from '../../workspace/index.js';
import { resolveWorkspaceMount } from '../../workspace/paths.js';
import type { CliCommandContext, CliCommandModule } from '../types.js';

export const workspaceCommands: CliCommandModule = {
  register(program, ctx) {
    registerRepoCommands(program, ctx);
    registerWorkspaceCommands(program, ctx);
  },
};

function registerRepoCommands(program: Command, ctx: CliCommandContext): void {
  const repo = program.command('repo').description('manage repository mirrors');

  repo
    .command('add')
    .argument('[source]', 'local Git path or remote Git URL')
    .option('--key <key>', 'repository key')
    .description('register a local or remote repository')
    .action(
      async (
        source: string | undefined,
        opts: { key?: string },
        cmd: Command,
      ) => {
        await withRepoStore(ctx, cmd, async (store, config) => {
          print(
            ctx,
            config.json,
            await store.add(source ?? config.cwd, opts.key),
          );
        });
      },
    );

  repo
    .command('list')
    .alias('ls')
    .description('list registered repositories')
    .action(async (_opts: unknown, cmd: Command) => {
      await withRepoStore(ctx, cmd, async (store, config) => {
        const { formatRepoList } = await import('../../workspace/index.js');
        print(ctx, config.json, store.list(), formatRepoList(store.list()));
      });
    });

  repo
    .command('show')
    .argument('<key>')
    .description('show one repository')
    .action(async (key: string, _opts: unknown, cmd: Command) => {
      await withRepoStore(ctx, cmd, async (store, config) => {
        const value = store.show(key);
        if (value === null) throw new Error(`Unknown repo: ${key}`);
        print(ctx, config.json, value);
      });
    });

  repo
    .command('rename')
    .argument('<key>')
    .argument('<new-key>')
    .description('rename a repository key')
    .action(
      async (key: string, newKey: string, _opts: unknown, cmd: Command) => {
        await withRepoStore(ctx, cmd, async (store, config) => {
          print(ctx, config.json, store.rename(key, newKey));
        });
      },
    );

  repo
    .command('remove')
    .argument('<key>')
    .description('remove an unreferenced repository and its mirror')
    .action(async (key: string, _opts: unknown, cmd: Command) => {
      await withRepoStore(ctx, cmd, async (store, config) => {
        await store.remove(key);
        print(ctx, config.json, { key, removed: true }, `removed\t${key}`);
      });
    });

  repo
    .command('fetch')
    .argument('[key...]')
    .option('--all', 'fetch all remote-backed repositories')
    .description('fetch registered remote repositories')
    .action(async (keys: string[], opts: { all?: boolean }, cmd: Command) => {
      await withRepoStore(ctx, cmd, async (store, config) => {
        print(ctx, config.json, await store.fetch(keys, opts.all === true));
      });
    });

  repo
    .command('fetch-local')
    .argument('<key>')
    .argument('<path>')
    .description('ingest refs once from a local Git repository')
    .action(
      async (key: string, source: string, _opts: unknown, cmd: Command) => {
        await withRepoStore(ctx, cmd, async (store, config) => {
          print(ctx, config.json, await store.fetchLocal(key, source));
        });
      },
    );

  const remote = repo
    .command('remote')
    .description('manage repository remotes');
  remote
    .command('show')
    .argument('<key>')
    .action(async (key: string, _opts: unknown, cmd: Command) => {
      await withRepoStore(ctx, cmd, async (store, config) => {
        print(ctx, config.json, store.remoteShow(key));
      });
    });
  remote
    .command('add')
    .argument('<key>')
    .argument('<url>')
    .action(async (key: string, url: string, _opts: unknown, cmd: Command) => {
      await withRepoStore(ctx, cmd, async (store, config) => {
        print(ctx, config.json, await store.remoteAdd(key, url));
      });
    });
  remote
    .command('set')
    .argument('<key>')
    .argument('<url>')
    .action(async (key: string, url: string, _opts: unknown, cmd: Command) => {
      await withRepoStore(ctx, cmd, async (store, config) => {
        print(ctx, config.json, await store.remoteSet(key, url));
      });
    });
  remote
    .command('remove')
    .argument('<key>')
    .action(async (key: string, _opts: unknown, cmd: Command) => {
      await withRepoStore(ctx, cmd, async (store, config) => {
        print(ctx, config.json, await store.remoteRemove(key));
      });
    });

  repo
    .command('export')
    .argument('[key...]')
    .requiredOption('--output <dir>')
    .description('export repository metadata and local-only bundles')
    .action(async (keys: string[], opts: { output: string }, cmd: Command) => {
      await withRepoStore(ctx, cmd, async (store, config) => {
        print(
          ctx,
          config.json,
          await store.export(keys, path.resolve(opts.output)),
        );
      });
    });

  repo
    .command('import')
    .argument('<dir>')
    .description('import a repository registry export')
    .action(async (dir: string, _opts: unknown, cmd: Command) => {
      await withRepoStore(ctx, cmd, async (store, config) => {
        print(ctx, config.json, await store.import(path.resolve(dir)));
      });
    });
}

function registerWorkspaceCommands(
  program: Command,
  ctx: CliCommandContext,
): void {
  const workspace = program
    .command('workspace')
    .alias('ws')
    .description('manage multi-repository workspaces');

  workspace
    .command('create')
    .argument('<selector>', 'feature/name | fix/name | explore/name')
    .argument('<repo...>', 'registered repository keys')
    .option('--tmux [name]', 'create and bind a tmux session')
    .description('create a workspace')
    .action(
      async (
        selector: string,
        keys: string[],
        opts: { tmux?: true | string },
        cmd: Command,
      ) => {
        await withWorkspaceStore(ctx, cmd, async (store, config) => {
          const { kind, name } = parseSelector(selector);
          const session =
            opts.tmux === undefined
              ? undefined
              : typeof opts.tmux === 'string'
                ? opts.tmux
                : `${kind}-${name}`;
          print(
            ctx,
            config.json,
            await store.create(kind, name, keys, session),
          );
        });
      },
    );

  workspace
    .command('list')
    .option('--kind <kind>')
    .option('--status <status>')
    .description('list workspaces')
    .action(async (opts: { kind?: string; status?: string }, cmd: Command) => {
      await withWorkspaceStore(ctx, cmd, async (store, config) => {
        const values = store.list(opts);
        const { formatWorkspaceList } =
          await import('../../workspace/index.js');
        print(ctx, config.json, values, formatWorkspaceList(values));
      });
    });

  workspace
    .command('archived')
    .argument('[selector]')
    .description('list archived workspaces')
    .action(
      async (selector: string | undefined, _opts: unknown, cmd: Command) => {
        await withWorkspaceStore(ctx, cmd, async (store, config) => {
          const values =
            selector === undefined
              ? store.list({ status: 'archived' })
              : store.listArchived(...selectorParts(selector));
          const { formatWorkspaceList } =
            await import('../../workspace/index.js');
          print(ctx, config.json, values, formatWorkspaceList(values));
        });
      },
    );

  workspace
    .command('show')
    .argument('[selector]')
    .option('--id <id>')
    .action(
      async (
        selector: string | undefined,
        opts: { id?: string },
        cmd: Command,
      ) => {
        await withWorkspaceStore(ctx, cmd, async (store, config) => {
          print(ctx, config.json, workspaceTarget(store, selector, opts.id));
        });
      },
    );
  workspace
    .command('path')
    .argument('[selector]')
    .option('--id <id>')
    .action(
      async (
        selector: string | undefined,
        opts: { id?: string },
        cmd: Command,
      ) => {
        await withWorkspaceStore(ctx, cmd, async (store, config) => {
          const value = workspaceTarget(store, selector, opts.id).rootPath;
          print(ctx, config.json, { path: value }, value);
        });
      },
    );

  workspace
    .command('status')
    .argument('[selector]')
    .option('--id <id>')
    .description('show workspace filesystem and Git status')
    .action(
      async (
        selector: string | undefined,
        opts: { id?: string },
        cmd: Command,
      ) => {
        await withWorkspaceStore(ctx, cmd, async (store, config) => {
          const selected =
            selector === undefined && opts.id === undefined
              ? [store.fromCwd(config.cwd)]
              : [workspaceTarget(store, selector, opts.id)];
          print(ctx, config.json, await store.status(selected));
        });
      },
    );

  const workspaceRepo = workspace
    .command('repo')
    .description('manage workspace repositories');
  workspaceRepo
    .command('add')
    .argument('<repo...>')
    .option('--workspace <selector>')
    .action(
      async (keys: string[], opts: { workspace?: string }, cmd: Command) => {
        await withWorkspaceStore(ctx, cmd, async (store, config) => {
          const selected = resolveWorkspace(store, opts.workspace, config.cwd);
          print(ctx, config.json, await store.addRepos(selected, keys));
        });
      },
    );
  workspaceRepo
    .command('create')
    .argument('<key>')
    .option('--workspace <selector>')
    .action(async (key: string, opts: { workspace?: string }, cmd: Command) => {
      await withWorkspaceStore(ctx, cmd, async (store, config) => {
        const selected = resolveWorkspace(store, opts.workspace, config.cwd);
        print(ctx, config.json, await store.createRepo(selected, key));
      });
    });
  workspaceRepo
    .command('remove')
    .argument('<repo...>')
    .option('--workspace <selector>')
    .option('--force', 'discard dirty worktree content')
    .action(
      async (
        keys: string[],
        opts: { workspace?: string; force?: boolean },
        cmd: Command,
      ) => {
        await withWorkspaceStore(ctx, cmd, async (store, config) => {
          const selected = resolveWorkspace(store, opts.workspace, config.cwd);
          print(
            ctx,
            config.json,
            await store.removeRepos(selected, keys, opts.force === true),
          );
        });
      },
    );

  workspace
    .command('rename')
    .argument('<selector>')
    .argument('<new-name>')
    .action(
      async (
        selector: string,
        newName: string,
        _opts: unknown,
        cmd: Command,
      ) => {
        await withWorkspaceStore(ctx, cmd, async (store, config) => {
          print(
            ctx,
            config.json,
            await store.rename(openActiveSelector(store, selector), newName),
          );
        });
      },
    );
  workspace
    .command('archive')
    .argument('<selector>')
    .action(async (selector: string, _opts: unknown, cmd: Command) => {
      await withWorkspaceStore(ctx, cmd, async (store, config) => {
        print(
          ctx,
          config.json,
          await store.archive(openActiveSelector(store, selector)),
        );
      });
    });
  workspace
    .command('delete')
    .argument('[selector]')
    .option('--archived', 'delete the archived workspace for this selector')
    .option('--id <id>', 'delete one workspace by id')
    .option('--force', 'discard dirty worktree and workspace content')
    .action(
      async (
        selector: string | undefined,
        opts: { archived?: boolean; id?: string; force?: boolean },
        cmd: Command,
      ) => {
        await withWorkspaceStore(ctx, cmd, async (store, config) => {
          const selected =
            opts.archived === true
              ? archivedTarget(store, selector, opts.id)
              : workspaceTarget(store, selector, opts.id);
          const status = await store.status([selected]);
          const [view] = status;
          if (view === undefined) {
            throw new Error(`Workspace status is missing: ${selected.id}`);
          }
          const preview = {
            rootPath: selected.rootPath,
            repoCount: selected.repos.length,
            tmuxSession: selected.tmuxSession,
            dirty: view.repos.some((repo) => repo.dirty),
          };
          print(ctx, config.json, {
            preview,
            workspace: await store.delete(selected, opts.force === true),
          });
        });
      },
    );

  workspace
    .command('reconcile')
    .argument('[selector]')
    .option('--id <id>')
    .action(
      async (
        selector: string | undefined,
        opts: { id?: string },
        cmd: Command,
      ) => {
        await withWorkspaceStore(ctx, cmd, async (store, config) => {
          const selected =
            selector === undefined && opts.id === undefined
              ? store.listRepairable()
              : [workspaceTarget(store, selector, opts.id)];
          print(ctx, config.json, await store.reconcile(selected));
        });
      },
    );

  workspace
    .command('repair')
    .argument('[selector]')
    .option('--id <id>')
    .description('repair workspace filesystem, Git worktrees, and SQLite paths')
    .action(
      async (
        selector: string | undefined,
        opts: { id?: string },
        cmd: Command,
      ) => {
        await withWorkspaceStore(ctx, cmd, async (store, config) => {
          const selected =
            selector === undefined && opts.id === undefined
              ? store.listRepairable()
              : [workspaceTarget(store, selector, opts.id)];
          print(ctx, config.json, await store.repair(selected));
        });
      },
    );

  const tmux = workspace
    .command('tmux')
    .description('manage workspace-bound tmux lifecycle');
  tmux
    .command('new')
    .argument('<selector>')
    .option('--name <name>')
    .action(async (selector: string, opts: { name?: string }, cmd: Command) => {
      await withWorkspaceStore(ctx, cmd, async (store, config) => {
        const selected = openActiveSelector(store, selector);
        print(
          ctx,
          config.json,
          await store.bindTmux(
            selected,
            opts.name ?? `${selected.kind}-${selected.name}`,
          ),
        );
      });
    });
}

async function withRepoStore(
  ctx: CliCommandContext,
  cmd: Command,
  fn: (
    store: RepoStore,
    config: Awaited<ReturnType<CliCommandContext['resolveConfig']>>,
  ) => Promise<void>,
): Promise<void> {
  const config = await ctx.resolveConfig(cmd.optsWithGlobals());
  const [{ withCodingStorage }, { RepoStore }] = await Promise.all([
    import('../../storage/index.js'),
    import('../../workspace/index.js'),
  ]);
  await withCodingStorage((storage) =>
    fn(new RepoStore(storage.repositories), config),
  );
}

async function withWorkspaceStore(
  ctx: CliCommandContext,
  cmd: Command,
  fn: (
    store: WorkspaceStore,
    config: Awaited<ReturnType<CliCommandContext['resolveConfig']>>,
  ) => Promise<void>,
): Promise<void> {
  const config = await ctx.resolveConfig(cmd.optsWithGlobals());
  const mount = resolveWorkspaceMount(config.workspace.mount);
  const [{ withCodingStorage }, { RepoStore, WorkspaceStore }] =
    await Promise.all([
      import('../../storage/index.js'),
      import('../../workspace/index.js'),
    ]);
  await withCodingStorage((storage) => {
    const repos = new RepoStore(storage.repositories);
    return fn(new WorkspaceStore(storage.workspaces, repos, mount), config);
  });
}

function parseSelector(selector: string): {
  readonly kind: string;
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
  return { kind: selector.slice(0, slash), name: selector.slice(slash + 1) };
}

function openSelector(store: WorkspaceStore, selector: string): Workspace {
  const { kind, name } = parseSelector(selector);
  return store.open(kind, name);
}

function openActiveSelector(
  store: WorkspaceStore,
  selector: string,
): Workspace {
  const { kind, name } = parseSelector(selector);
  return store.openActive(kind, name);
}

function workspaceTarget(
  store: WorkspaceStore,
  selector: string | undefined,
  id: string | undefined,
): Workspace {
  if (id !== undefined) {
    if (selector !== undefined) {
      throw new Error('Specify a workspace selector or --id');
    }
    return store.openById(id);
  }
  if (selector === undefined) {
    throw new Error('Workspace selector or --id is required');
  }
  return openSelector(store, selector);
}

function archivedTarget(
  store: WorkspaceStore,
  selector: string | undefined,
  id: string | undefined,
): Workspace {
  if (id !== undefined) {
    const workspace = workspaceTarget(store, undefined, id);
    if (workspace.status !== 'archived') {
      throw new Error(`Workspace is not archived: ${id}`);
    }
    return workspace;
  }
  if (selector === undefined) {
    throw new Error('Archived workspace selector or --id is required');
  }
  const { kind, name } = parseSelector(selector);
  return store.openArchived(kind, name);
}

function selectorParts(selector: string): readonly [string, string] {
  const { kind, name } = parseSelector(selector);
  return [kind, name];
}

function resolveWorkspace(
  store: WorkspaceStore,
  selector: string | undefined,
  cwd: string,
): Workspace {
  return selector === undefined
    ? store.fromCwd(cwd)
    : openActiveSelector(store, selector);
}

function print(
  ctx: CliCommandContext,
  json: boolean,
  value: unknown,
  text = JSON.stringify(value, null, 2),
): void {
  ctx.io.stdout.write(`${json ? JSON.stringify(value, null, 2) : text}\n`);
}
