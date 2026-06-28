import { Command } from 'commander';

import {
  getProjectConfigPath,
  loadCodingAgentConfig,
  normalizeApprovalMode,
  setProjectConfigValue,
  type CodingAgentConfig,
} from '../config.js';
import { loadCodingMemory, summarizeMemory } from '../memory.js';
import { formatPermissionRules } from '../permissions.js';
import { createCodingSession } from '../runtime/coding-session.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import { describeCodingTools } from '../tools/index.js';
import { launchTui } from '../tui/index.js';

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
    .action(async (session: string | undefined, _opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      if (config.tui) {
        await launchTui({ config: { ...config, sessionId: session ?? null } });
      } else {
        await resumeNonInteractive(config, session, io);
      }
    });

  registerInfoCommands(program, io);
  return program;
}

/**
 * CLI 入口：解析 argv 并执行对应命令。
 *
 * `from: 'user'` 表示传入的是去掉 node/script 前缀的纯参数数组。
 */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<void> {
  await buildProgram(io).parseAsync(argv, { from: 'user' });
}

/**
 * 非交互运行一次 prompt：消费与 TUI 同一条事件流。
 *
 * 审批在非交互模式下完全由策略决定（bypass/accept-edits/dont-ask）；若策略判
 * required 而无 UI，内核侧会按拒绝处理并把原因喂回模型。CLI 不实现任何业务逻辑。
 */
async function runOnce(config: CodingAgentConfig, prompt: string, io: CliIo): Promise<void> {
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
      const store = new JsonlSessionStore({ sessionDir: config.sessionDir, cwd: config.cwd });
      const sessions = await store.list();
      io.stdout.write(
        `${
          config.json
            ? JSON.stringify(sessions, null, 2)
            : sessions.length === 0
              ? `No sessions in ${config.sessionDir}`
              : sessions
                  .map(
                    (s) => `${s.sessionId}\t${s.entryCount} entries\t${s.updatedAt ?? 'unknown'}`,
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

  const configCmd = program.command('config').description('read/write project config');
  configCmd
    .command('path')
    .description('print project config path')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      io.stdout.write(`${getProjectConfigPath(config.cwd)}\n`);
    });
  configCmd
    .command('get')
    .description('print merged config')
    .action(async (_opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      io.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    });
  configCmd
    .command('set')
    .argument('<key>', 'config key')
    .argument('<value>', 'config value')
    .description('set a project config key')
    .action(async (key: string, value: string, _opts: unknown, cmd: Command) => {
      const config = await resolveConfig(cmd.optsWithGlobals());
      const [parsedKey, rawValue] = splitConfigSetPrompt(`${key} ${value}`);
      const next = await setProjectConfigValue(config.cwd, parsedKey, parseConfigValue(rawValue));
      io.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
    });
}
