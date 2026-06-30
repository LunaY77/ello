import { Command } from 'commander';

import {
  ensureGlobalConfig,
  ensureProjectConfig,
  getConfigValue,
  getProjectConfigPath,
  globalConfigPath,
  loadConfigSources,
  loadCodingAgentConfig,
  normalizeApprovalMode,
  setConfigValue,
  type ConfigSourceName,
  type CodingAgentConfig,
  type WritableConfigSourceName,
} from '../config/index.js';
import { loadCodingMemory, summarizeMemory } from '../memory.js';
import { formatPermissionRules } from '../permissions.js';
import { createCodingSession } from '../runtime/coding-session.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import {
  formatSkill,
  formatSkillList,
  loadCodingSkills,
} from '../skills/index.js';
import {
  createTaskService,
  formatClaimResult,
  formatTask,
  formatTaskList,
} from '../tasks/index.js';
import { describeCodingTools } from '../tools/index.js';
import { launchTui } from '../tui/index.js';
import {
  formatRepoList,
  formatWorkspaceList,
  RepoStore,
  TmuxStore,
  WorkspaceStore,
} from '../workspace/index.js';

import { parseConfigValue, splitConfigSetPrompt } from './config-values.js';
import { renderEvent } from './render.js';

/** CLI 版本号（与 package.json 对齐，构建时手动同步即可）。 */
const VERSION = '0.1.0';

/** 可注入的 IO，便于测试捕获输出。 */
export interface CliIo {
  readonly stdout: Pick<NodeJS.WriteStream, 'write'>;
  readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
  readonly stdin?: NodeJS.ReadableStream;
}

/** 默认 IO：直接绑定进程标准流。 */
const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
};

/** commander 全局选项的形状（`optsWithGlobals()` 的返回）。 */
interface GlobalOpts {
  readonly model?: string;
  readonly cwd?: string;
  readonly allowedPath?: string[];
  readonly approval?: string;
  readonly json?: boolean;
  /** `--no-tui` 在 commander 里表现为 `tui: false`。 */
  readonly tui?: boolean;
}

/**
 * 把 commander 解析出的全局选项装配成运行时配置。
 *
 * 只透传用户显式给的字段，其余交给 {@link loadCodingAgentConfig} 的多层合并。
 */
async function resolveConfig(opts: GlobalOpts): Promise<CodingAgentConfig> {
  return loadCodingAgentConfig({
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.allowedPath !== undefined && opts.allowedPath.length > 0
      ? { allowedPaths: opts.allowedPath }
      : {}),
    ...(opts.approval !== undefined
      ? { approvalMode: normalizeApprovalMode(opts.approval) }
      : {}),
    ...(opts.json !== undefined ? { json: opts.json } : {}),
    ...(opts.tui !== undefined ? { tui: opts.tui } : {}),
  });
}

/**
 * 构造 commander 命令树。
 *
 * CLI 是 {@link createCodingSession} 的薄前端：解析命令 → 装配配置 →
 * 创建/驱动会话 → 渲染事件。命令树覆盖旧 CLI 的全部能力（run/resume/
 * sessions/tools/permissions/memory/config），但改由 commander 表达。
 */
export function buildProgram(io: CliIo = defaultIo): Command {
  const program = new Command();
  program
    .name('ello')
    .description('ello coding agent')
    .version(VERSION)
    .option('--model <id>', 'model id')
    .option('--cwd <path>', 'working directory')
    .option('--allowed-path <path...>', 'extra allowed roots')
    .option('--approval <mode>', 'default | accept-edits | bypass | dont-ask')
    .option('--json', 'machine-readable output')
    .option('--no-tui', 'disable TUI for run/resume');

  // 无子命令：进入交互式 TUI。
  program.action(async (opts: GlobalOpts) => {
    const config = await resolveConfig(opts);
    await launchTui({ config });
  });

  program
    .command('run')
    .description('run a single prompt non-interactively')
    .argument('<prompt...>', 'prompt to run once')
    .action(async (promptParts: string[], _opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      await runOnce(config, promptParts.join(' '), io);
    });

  program
    .command('resume')
    .description('resume an existing session (TUI by default)')
    .argument('[session]', 'session id or jsonl path')
    .action(
      async (session: string | undefined, _opts: unknown, cmd: Command) => {
        const config = await resolveConfig(cmd.optsWithGlobals());
        if (config.tui) {
          await launchTui({
            config: { ...config, sessionId: session ?? null },
          });
        } else {
          await resumeNonInteractive(config, session, io);
        }
      },
    );

  registerInfoCommands(program, io);
  return program;
}

/**
 * CLI 入口：解析 argv 并执行对应命令。
 *
 * `from: 'user'` 表示传入的是去掉 node/script 前缀的纯参数数组。
 */
export async function runCli(
  argv: string[],
  io: CliIo = defaultIo,
): Promise<void> {
  await buildProgram(io).parseAsync(argv, { from: 'user' });
}

/**
 * 非交互运行一次 prompt：消费与 TUI 同一条事件流。
 *
 * 审批在非交互模式下完全由策略决定（bypass/accept-edits/dont-ask）；若策略判
 * required 而无 UI，内核侧会按拒绝处理并把原因喂回模型。CLI 不实现任何业务逻辑。
 */
async function runOnce(
  config: CodingAgentConfig,
  prompt: string,
  io: CliIo,
): Promise<void> {
  const session = await createCodingSession({ config });
  const unsubscribe = session.subscribe((event) => {
    io.stdout.write(renderEvent(event, config.json));
  });
  try {
    await session.submit(prompt);
  } finally {
    unsubscribe();
    await session.close();
  }
}

/**
 * 非交互恢复会话：先恢复历史，再要求一个新 prompt。
 *
 * `--no-tui` 下 resume 没有交互输入入口，因此这里仅打印会话已恢复的提示；要继续
 * 对话请配合 `ello run` 或交互式 TUI。
 */
async function resumeNonInteractive(
  config: CodingAgentConfig,
  session: string | undefined,
  io: CliIo,
): Promise<void> {
  const coding = await createCodingSession({ config });
  try {
    if (session !== undefined && session.trim() !== '') {
      await coding.resumeSession(session.trim());
    }
    io.stdout.write(
      `Resumed session ${coding.sessionId}. Use \`ello run <prompt>\` to continue.\n`,
    );
  } finally {
    await coding.close();
  }
}

/**
 * 注册只读 info 命令：这些命令不起会话，直接读对应模块。
 */
function registerInfoCommands(program: Command, io: CliIo): void {
  program
    .command('sessions')
    .description('list sessions')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const store = new JsonlSessionStore({
        sessionDir: config.sessionDir,
        cwd: config.cwd,
      });
      const sessions = await store.list();
      io.stdout.write(
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

  program
    .command('tools')
    .description('list available tools')
    .action(() => {
      io.stdout.write(`${describeCodingTools()}\n`);
    });

  program
    .command('permissions')
    .description('show approval mode and rules')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      io.stdout.write(
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

  program
    .command('memory')
    .description('show memory file summary')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const memory = await loadCodingMemory(config.cwd);
      io.stdout.write(
        `${config.json ? JSON.stringify(memory, null, 2) : summarizeMemory(memory, config.cwd)}\n`,
      );
    });

  const configCmd = program
    .command('config')
    .description('read/write project config');
  configCmd
    .command('path')
    .option('--global', 'print global config path')
    .option('--project', 'print project config path')
    .description('print project config path')
    .action(async (opts: { global?: boolean }, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const target = opts.global
        ? globalConfigPath()
        : getProjectConfigPath(config.cwd);
      io.stdout.write(`${target}\n`);
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
        const config = await resolveConfig(cmd.optsWithGlobals());
        if (opts.global === true) {
          await ensureGlobalConfig({ force: opts.force ?? false });
          io.stdout.write(`initialized\t${globalConfigPath()}\n`);
          return;
        }
        await ensureProjectConfig(config.cwd, { force: opts.force ?? false });
        io.stdout.write(`initialized\t${getProjectConfigPath(config.cwd)}\n`);
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
        const config = await resolveConfig(cmd.optsWithGlobals());
        const value = await getConfigValue(
          config.cwd,
          key,
          normalizeConfigSource(opts.source),
        );
        io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
        const config = await resolveConfig(cmd.optsWithGlobals());
        const [parsedKey, rawValue] = splitConfigSetPrompt(`${key} ${value}`);
        const next = await setConfigValue(
          config.cwd,
          writableConfigSource(opts),
          parsedKey,
          parseConfigValue(rawValue),
        );
        io.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
      },
    );
  configCmd
    .command('sources')
    .description('print config source order')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const sources = await loadConfigSources(config.cwd);
      io.stdout.write(
        `${config.json ? JSON.stringify(sources, null, 2) : sources.map((source) => `${source.name}\t${source.path ?? '<runtime>'}`).join('\n')}\n`,
      );
    });
  configCmd
    .command('edit')
    .option('--global', 'edit global config')
    .option('--project', 'edit project config')
    .description('print editor command for config target')
    .action(async (opts: { global?: boolean }, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const filePath =
        writableConfigSource(opts) === 'global'
          ? globalConfigPath()
          : getProjectConfigPath(config.cwd);
      io.stdout.write(`${process.env.EDITOR ?? 'vi'} ${filePath}\n`);
    });

  const taskCmd = program.command('task').description('manage persisted tasks');
  taskCmd
    .command('list')
    .description('list tasks')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const tasks = await createTaskService().list();
      io.stdout.write(
        `${config.json ? JSON.stringify(tasks, null, 2) : formatTaskList(tasks)}\n`,
      );
    });
  taskCmd
    .command('get')
    .argument('<id>', 'task id')
    .description('show one task')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const task = await createTaskService().get(id);
      if (task === null) {
        throw new Error(`Unknown task: ${id}`);
      }
      io.stdout.write(
        `${config.json ? JSON.stringify(task, null, 2) : formatTask(task)}\n`,
      );
    });
  taskCmd
    .command('create')
    .requiredOption('--subject <subject>', 'task subject')
    .option('--description <description>', 'task description')
    .option('--owner <owner>', 'task owner')
    .description('create a task')
    .action(
      async (
        opts: { subject: string; description?: string; owner?: string },
        cmd: Command,
      ) => {
        const config = await resolveConfig(cmd.optsWithGlobals());
        const task = await createTaskService().create({
          subject: opts.subject,
          ...(opts.description !== undefined
            ? { description: opts.description }
            : {}),
          ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
        });
        io.stdout.write(
          `${config.json ? JSON.stringify(task, null, 2) : formatTask(task)}\n`,
        );
      },
    );
  taskCmd
    .command('update')
    .argument('<id>', 'task id')
    .option('--subject <subject>', 'task subject')
    .option('--description <description>', 'task description')
    .option(
      '--status <status>',
      'pending | in_progress | completed | cancelled',
    )
    .option('--owner <owner>', 'task owner')
    .description('update a task')
    .action(
      async (
        id: string,
        opts: {
          subject?: string;
          description?: string;
          status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
          owner?: string;
        },
        cmd: Command,
      ) => {
        const config = await resolveConfig(cmd.optsWithGlobals());
        const task = await createTaskService().update(id, {
          ...(opts.subject !== undefined ? { subject: opts.subject } : {}),
          ...(opts.description !== undefined
            ? { description: opts.description }
            : {}),
          ...(opts.status !== undefined ? { status: opts.status } : {}),
          ...(opts.owner !== undefined ? { owner: opts.owner } : {}),
        });
        io.stdout.write(
          `${config.json ? JSON.stringify(task, null, 2) : formatTask(task)}\n`,
        );
      },
    );
  taskCmd
    .command('delete')
    .argument('<id>', 'task id')
    .description('delete a task')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const deleted = await createTaskService().delete(id);
      io.stdout.write(
        `${config.json ? JSON.stringify({ id, deleted }) : `deleted\t${id}\t${deleted}`}\n`,
      );
    });
  taskCmd
    .command('claim')
    .argument('<id>', 'task id')
    .requiredOption('--owner <owner>', 'task owner')
    .description('claim a task')
    .action(async (id: string, opts: { owner: string }, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const result = await createTaskService().claim(id, opts.owner);
      io.stdout.write(
        `${config.json ? JSON.stringify(result, null, 2) : formatClaimResult(result)}\n`,
      );
    });
  taskCmd
    .command('reset')
    .description('reset current task list')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      await createTaskService().reset();
      io.stdout.write(
        `${config.json ? JSON.stringify({ reset: true }) : 'reset\ttrue'}\n`,
      );
    });

  const skillsCmd = program.command('skills').description('inspect skills');
  skillsCmd
    .command('list')
    .description('list skills')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const skills = await loadCodingSkills(config);
      io.stdout.write(
        `${config.json ? JSON.stringify(skills, null, 2) : formatSkillList(skills)}\n`,
      );
    });
  skillsCmd
    .command('get')
    .argument('<name>', 'skill name')
    .description('show one skill')
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const skill = (await loadCodingSkills(config)).find(
        (item) => item.name === name,
      );
      if (skill === undefined) {
        throw new Error(`Unknown skill: ${name}`);
      }
      io.stdout.write(
        `${config.json ? JSON.stringify(skill, null, 2) : formatSkill(skill)}\n`,
      );
    });
  skillsCmd
    .command('search')
    .argument('<query...>', 'search query')
    .description('search skills')
    .action(async (queryParts: string[], _opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const query = queryParts.join(' ').toLowerCase();
      const skills = (await loadCodingSkills(config)).filter((skill) =>
        [skill.name, skill.description, skill.whenToUse ?? '']
          .join('\n')
          .toLowerCase()
          .includes(query),
      );
      io.stdout.write(
        `${config.json ? JSON.stringify(skills, null, 2) : formatSkillList(skills)}\n`,
      );
    });

  const repoCmd = program.command('repo').description('manage repo mirrors');
  repoCmd
    .command('add')
    .argument('<key>', 'repo key')
    .argument('<url>', 'repo URL')
    .description('add repo mirror')
    .action(async (key: string, url: string, _opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const repo = await new RepoStore().add(key, url);
      io.stdout.write(
        `${config.json ? JSON.stringify(repo, null, 2) : formatRepoList([repo])}\n`,
      );
    });
  repoCmd
    .command('sync')
    .argument('[key...]', 'repo keys')
    .option('--all', 'sync all registered repos')
    .description('sync repo mirrors')
    .action(async (keys: string[], _opts: { all?: boolean }, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const repos = await new RepoStore().sync(keys);
      io.stdout.write(
        `${config.json ? JSON.stringify(repos, null, 2) : formatRepoList(repos)}\n`,
      );
    });
  repoCmd
    .command('ls')
    .description('list repos')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const repos = await new RepoStore().list();
      io.stdout.write(
        `${config.json ? JSON.stringify(repos, null, 2) : formatRepoList(repos)}\n`,
      );
    });
  repoCmd
    .command('remove')
    .argument('<key>', 'repo key')
    .description('remove repo mirror')
    .action(async (key: string, _opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const removed = await new RepoStore().remove(key);
      io.stdout.write(
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
        const config = await resolveConfig(cmd.optsWithGlobals());
        const repo = await new RepoStore().rename(key, newKey);
        io.stdout.write(
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
      const config = await resolveConfig(cmd.optsWithGlobals());
      const repo = await new RepoStore().setUrl(key, url);
      io.stdout.write(
        `${config.json ? JSON.stringify(repo, null, 2) : formatRepoList([repo])}\n`,
      );
    });
  repoCmd
    .command('show')
    .argument('<key>', 'repo key')
    .description('show repo')
    .action(async (key: string, _opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const repo = await new RepoStore().show(key);
      if (repo === null) {
        throw new Error(`Unknown repo: ${key}`);
      }
      io.stdout.write(
        `${config.json ? JSON.stringify(repo, null, 2) : formatRepoList([repo])}\n`,
      );
    });

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
        const config = await resolveConfig(cmd.optsWithGlobals());
        const session =
          opts.session ?? (opts.tmux === true ? `${kind}-${name}` : undefined);
        const workspace = await new WorkspaceStore().create(kind, name, repos, {
          ...(session !== undefined ? { tmuxSession: session } : {}),
        });
        if (session !== undefined) {
          await new TmuxStore().newSession(session, workspace.rootPath);
        }
        io.stdout.write(
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
        const config = await resolveConfig(cmd.optsWithGlobals());
        const workspace = await new WorkspaceStore().addRepos(
          kind,
          name,
          repos,
        );
        io.stdout.write(
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
        const config = await resolveConfig(cmd.optsWithGlobals());
        const workspace = await new WorkspaceStore().removeRepos(
          kind,
          name,
          repos,
          opts.force ?? false,
        );
        io.stdout.write(
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
        const config = await resolveConfig(cmd.optsWithGlobals());
        const workspace = await new WorkspaceStore().rename(
          kind,
          name,
          newName,
        );
        io.stdout.write(
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
        const config = await resolveConfig(cmd.optsWithGlobals());
        const removed = await new WorkspaceStore().remove(
          kind,
          name,
          opts.force ?? false,
        );
        io.stdout.write(
          `${config.json ? JSON.stringify({ kind, name, removed }) : `removed\t${kind}/${name}\t${removed}`}\n`,
        );
      },
    );
  workspaceCmd
    .command('list')
    .argument('[kind]', 'workspace kind')
    .description('list workspaces')
    .action(async (kind: string | undefined, _opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const workspaces = await new WorkspaceStore().list(kind);
      io.stdout.write(
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
        const config = await resolveConfig(cmd.optsWithGlobals());
        const workspace = await new WorkspaceStore().open(kind, name);
        const text = opts.printCd
          ? `cd ${workspace.rootPath}`
          : formatWorkspaceList([workspace]);
        io.stdout.write(
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
        const config = await resolveConfig(cmd.optsWithGlobals());
        const workspace = await new WorkspaceStore().archive(kind, name);
        io.stdout.write(
          `${config.json ? JSON.stringify(workspace, null, 2) : formatWorkspaceList([workspace])}\n`,
        );
      },
    );
  workspaceCmd
    .command('status')
    .description('show workspace status')
    .action(async (_opts: unknown, cmd: Command) => {
      await resolveConfig(cmd.optsWithGlobals());
      const status = await new WorkspaceStore().status();
      io.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    });
  workspaceCmd
    .command('sync')
    .option('--fix-missing', 'mark missing roots/checkouts in the global DB')
    .option('--prune', 'mark removed checkouts in the global DB')
    .description('sync workspace DB state with filesystem/git observations')
    .action(
      async (
        opts: { fixMissing?: boolean; prune?: boolean },
        cmd: Command,
      ) => {
        const config = await resolveConfig(cmd.optsWithGlobals());
        const result = await new WorkspaceStore().sync({
          fixMissing: opts.fixMissing ?? false,
          prune: opts.prune ?? false,
        });
        io.stdout.write(
          `${config.json ? JSON.stringify(result, null, 2) : `workspace-sync\t${result.status}\tchecked=${result.checkedCount}\tfixed=${result.fixedCount}`}\n`,
        );
      },
    );

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
        const config = await resolveConfig(cmd.optsWithGlobals());
        const workspace = await new WorkspaceStore().open(kind, name);
        const result = await new TmuxStore().newSession(
          session ?? `${kind}-${name}`,
          workspace.rootPath,
        );
        io.stdout.write(
          `${config.json ? JSON.stringify(result, null, 2) : `tmux\t${result.session}\t${result.cwd}`}\n`,
        );
      },
    );
  tmuxCmd
    .command('ls')
    .description('list tmux sessions')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const sessions = await new TmuxStore().list();
      io.stdout.write(
        `${config.json ? JSON.stringify(sessions, null, 2) : sessions.join('\n')}\n`,
      );
    });
}

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
