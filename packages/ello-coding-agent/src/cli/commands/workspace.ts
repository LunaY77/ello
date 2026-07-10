import type { Command } from 'commander';

import type { WorkspaceStore } from '../../workspace/index.js';
import type { CliCommandContext, CliCommandModule } from '../types.js';

export const workspaceCommands: CliCommandModule = {
  register(program, ctx) {
    registerRepoCommands(program, ctx);
    registerWorkspaceCommands(program, ctx);
    registerTmuxCommands(program, ctx);
  },
};

function registerRepoCommands(program: Command, ctx: CliCommandContext): void {
  const repoCmd = program.command('repo').description('manage repo mirrors');
  repoCmd
    .command('add')
    .argument('<key>', 'repo key')
    .argument('<url>', 'repo URL')
    .description('add repo mirror')
    .action(async (key: string, url: string, _opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { RepoStore, formatRepoList } =
        await import('../../workspace/index.js');
      const repo = await new RepoStore().add(key, url);
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(repo, null, 2) : formatRepoList([repo])}\n`,
      );
    });
  repoCmd
    .command('sync')
    .argument('[key...]', 'repo keys')
    .option('--all', 'sync all registered repos')
    .description('sync repo mirrors')
    .action(async (keys: string[], _opts: { all?: boolean }, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { RepoStore, formatRepoList } =
        await import('../../workspace/index.js');
      const repos = await new RepoStore().sync(keys);
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(repos, null, 2) : formatRepoList(repos)}\n`,
      );
    });
  repoCmd
    .command('ls')
    .description('list repos')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { RepoStore, formatRepoList } =
        await import('../../workspace/index.js');
      const repos = await new RepoStore().list();
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(repos, null, 2) : formatRepoList(repos)}\n`,
      );
    });
  repoCmd
    .command('remove')
    .argument('<key>', 'repo key')
    .description('remove repo mirror')
    .action(async (key: string, _opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { RepoStore } = await import('../../workspace/index.js');
      const removed = await new RepoStore().remove(key);
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify({ key, removed }) : `removed\t${key}\t${removed}`}\n`,
      );
    });
  repoCmd
    .command('rename')
    .argument('<key>', 'repo key')
    .argument('<newKey>', 'new repo key')
    .description('rename repo')
    .action(
      async (key: string, newKey: string, _opts: unknown, cmd: Command) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const { RepoStore, formatRepoList } =
          await import('../../workspace/index.js');
        const repo = await new RepoStore().rename(key, newKey);
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(repo, null, 2) : formatRepoList([repo])}\n`,
        );
      },
    );
  repoCmd
    .command('set-url')
    .argument('<key>', 'repo key')
    .argument('<url>', 'repo URL')
    .description('set repo origin URL')
    .action(async (key: string, url: string, _opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { RepoStore, formatRepoList } =
        await import('../../workspace/index.js');
      const repo = await new RepoStore().setUrl(key, url);
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(repo, null, 2) : formatRepoList([repo])}\n`,
      );
    });
  repoCmd
    .command('show')
    .argument('<key>', 'repo key')
    .description('show repo')
    .action(async (key: string, _opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { RepoStore, formatRepoList } =
        await import('../../workspace/index.js');
      const repo = await new RepoStore().show(key);
      if (repo === null) {
        throw new Error(`Unknown repo: ${key}`);
      }
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(repo, null, 2) : formatRepoList([repo])}\n`,
      );
    });
}

function registerWorkspaceCommands(
  program: Command,
  ctx: CliCommandContext,
): void {
  const workspaceCmd = program
    .command('workspace')
    .description('manage workspaces');
  workspaceCmd
    .command('create')
    .argument('<kind>', 'feature | fix | explore')
    .argument('<name>', 'workspace name')
    .argument('<repo...>', 'repo keys')
    .option('--tmux', 'create a tmux session after workspace creation')
    .option('--session <name>', 'tmux session name')
    .description('create workspace')
    .action(
      async (
        kind: string,
        name: string,
        repos: string[],
        opts: { tmux?: boolean; session?: string },
        cmd: Command,
      ) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const { TmuxStore, formatWorkspaceList } =
          await import('../../workspace/index.js');
        const session =
          opts.session ?? (opts.tmux === true ? `${kind}-${name}` : undefined);
        const workspace = await withWorkspaceStore((store) =>
          store.create(kind, name, repos, {
            ...(session !== undefined ? { tmuxSession: session } : {}),
          }),
        );
        if (session !== undefined) {
          await new TmuxStore().newSession(session, workspace.rootPath);
        }
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(workspace, null, 2) : formatWorkspaceList([workspace])}\n`,
        );
      },
    );
  workspaceCmd
    .command('add-repo')
    .argument('<kind>', 'workspace kind')
    .argument('<name>', 'workspace name')
    .argument('<repo...>', 'repo keys')
    .description('add repos to workspace')
    .action(
      async (
        kind: string,
        name: string,
        repos: string[],
        _opts: unknown,
        cmd: Command,
      ) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const { formatWorkspaceList } =
          await import('../../workspace/index.js');
        const workspace = await withWorkspaceStore((store) =>
          store.addRepos(kind, name, repos),
        );
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(workspace, null, 2) : formatWorkspaceList([workspace])}\n`,
        );
      },
    );
  workspaceCmd
    .command('remove-repo')
    .argument('<kind>', 'workspace kind')
    .argument('<name>', 'workspace name')
    .argument('<repo...>', 'repo keys')
    .option('--force', 'force remove dirty worktrees')
    .description('remove repos from workspace')
    .action(
      async (
        kind: string,
        name: string,
        repos: string[],
        opts: { force?: boolean },
        cmd: Command,
      ) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const { formatWorkspaceList } =
          await import('../../workspace/index.js');
        const workspace = await withWorkspaceStore((store) =>
          store.removeRepos(kind, name, repos, opts.force ?? false),
        );
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(workspace, null, 2) : formatWorkspaceList([workspace])}\n`,
        );
      },
    );
  workspaceCmd
    .command('rename')
    .argument('<kind>', 'workspace kind')
    .argument('<name>', 'workspace name')
    .argument('<newName>', 'new workspace name')
    .description('rename workspace')
    .action(
      async (
        kind: string,
        name: string,
        newName: string,
        _opts: unknown,
        cmd: Command,
      ) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const { formatWorkspaceList } =
          await import('../../workspace/index.js');
        const workspace = await withWorkspaceStore((store) =>
          store.rename(kind, name, newName),
        );
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(workspace, null, 2) : formatWorkspaceList([workspace])}\n`,
        );
      },
    );
  workspaceCmd
    .command('remove')
    .argument('<kind>', 'workspace kind')
    .argument('<name>', 'workspace name')
    .option('--force', 'force remove dirty worktrees')
    .description('remove workspace')
    .action(
      async (
        kind: string,
        name: string,
        opts: { force?: boolean },
        cmd: Command,
      ) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const removed = await withWorkspaceStore((store) =>
          store.remove(kind, name, opts.force ?? false),
        );
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify({ kind, name, removed }) : `removed\t${kind}/${name}\t${removed}`}\n`,
        );
      },
    );
  workspaceCmd
    .command('list')
    .argument('[kind]', 'workspace kind')
    .description('list workspaces')
    .action(async (kind: string | undefined, _opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { formatWorkspaceList } = await import('../../workspace/index.js');
      const workspaces = await withWorkspaceStore((store) => store.list(kind));
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(workspaces, null, 2) : formatWorkspaceList(workspaces)}\n`,
      );
    });
  workspaceCmd
    .command('open')
    .argument('<kind>', 'workspace kind')
    .argument('<name>', 'workspace name')
    .option('--print-cd', 'print cd command')
    .description('open workspace')
    .action(
      async (
        kind: string,
        name: string,
        opts: { printCd?: boolean },
        cmd: Command,
      ) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const { formatWorkspaceList } =
          await import('../../workspace/index.js');
        const workspace = await withWorkspaceStore((store) =>
          store.open(kind, name),
        );
        const text = opts.printCd
          ? `cd ${workspace.rootPath}`
          : formatWorkspaceList([workspace]);
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(workspace, null, 2) : text}\n`,
        );
      },
    );
  workspaceCmd
    .command('archive')
    .argument('<kind>', 'workspace kind')
    .argument('<name>', 'workspace name')
    .description('archive workspace')
    .action(
      async (kind: string, name: string, _opts: unknown, cmd: Command) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const { formatWorkspaceList } =
          await import('../../workspace/index.js');
        const workspace = await withWorkspaceStore((store) =>
          store.archive(kind, name),
        );
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(workspace, null, 2) : formatWorkspaceList([workspace])}\n`,
        );
      },
    );
  workspaceCmd
    .command('status')
    .description('show workspace status')
    .action(async (_opts: unknown, cmd: Command) => {
      await ctx.resolveConfig(cmd.optsWithGlobals());
      const status = await withWorkspaceStore((store) => store.status());
      ctx.io.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    });
  workspaceCmd
    .command('sync')
    .option('--fix-missing', 'mark missing roots/checkouts in the global DB')
    .option('--prune', 'mark removed checkouts in the global DB')
    .description('sync workspace DB state with filesystem/git observations')
    .action(
      async (opts: { fixMissing?: boolean; prune?: boolean }, cmd: Command) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const result = await withWorkspaceStore((store) =>
          store.sync({
            fixMissing: opts.fixMissing ?? false,
            prune: opts.prune ?? false,
          }),
        );
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(result, null, 2) : `workspace-sync\t${result.status}\tchecked=${result.checkedCount}\tfixed=${result.fixedCount}`}\n`,
        );
      },
    );
}

function registerTmuxCommands(program: Command, ctx: CliCommandContext): void {
  const tmuxCmd = program
    .command('tmux')
    .description('optional tmux integration');
  tmuxCmd
    .command('new')
    .argument('<kind>', 'workspace kind')
    .argument('<name>', 'workspace name')
    .argument('[session]', 'tmux session name')
    .description('create tmux session for workspace')
    .action(
      async (
        kind: string,
        name: string,
        session: string | undefined,
        _opts: unknown,
        cmd: Command,
      ) => {
        const config = await ctx.resolveConfig(cmd.optsWithGlobals());
        const { TmuxStore } = await import('../../workspace/index.js');
        const workspace = await withWorkspaceStore((store) =>
          store.open(kind, name),
        );
        const result = await new TmuxStore().newSession(
          session ?? `${kind}-${name}`,
          workspace.rootPath,
        );
        ctx.io.stdout.write(
          `${config.json ? JSON.stringify(result, null, 2) : `tmux\t${result.session}\t${result.cwd}`}\n`,
        );
      },
    );
  tmuxCmd
    .command('ls')
    .description('list tmux sessions')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await ctx.resolveConfig(cmd.optsWithGlobals());
      const { TmuxStore } = await import('../../workspace/index.js');
      const sessions = await new TmuxStore().list();
      ctx.io.stdout.write(
        `${config.json ? JSON.stringify(sessions, null, 2) : sessions.join('\n')}\n`,
      );
    });
}

async function withWorkspaceStore<T>(
  fn: (store: WorkspaceStore) => Promise<T>,
): Promise<T> {
  const [{ withCodingStorage }, { WorkspaceStore }] = await Promise.all([
    import('../../storage/index.js'),
    import('../../workspace/index.js'),
  ]);
  return withCodingStorage((storage) =>
    fn(new WorkspaceStore(storage.workspaces)),
  );
}
