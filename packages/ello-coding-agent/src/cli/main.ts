import { Command } from 'commander';

import {
  loadCodingAgentConfig,
  type CodingAgentConfig,
} from '../config/index.js';
import { SessionModeSchema } from '../runtime/session-mode.js';
import { createBootProfile } from '../utils/boot-profile.js';

import { registerCommands } from './commands/index.js';
import type { CliIo, GlobalOpts } from './types.js';

export type { CliIo } from './types.js';

/** CLI 版本号（与 package.json 对齐，构建时手动同步即可）。 */
const VERSION = '0.1.0';

/** 默认 IO：直接绑定进程标准流。 */
const defaultIo: CliIo = {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
};

/**
 * 把 commander 解析出的全局选项装配成运行时配置。
 *
 * 只透传用户显式给的字段，其余交给 {@link loadCodingAgentConfig} 的多层合并。
 */
export async function resolveConfig(
  opts: GlobalOpts,
): Promise<CodingAgentConfig> {
  return loadCodingAgentConfig({
    ...(opts.profile !== undefined ? { active_profile: opts.profile } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.allowedPath !== undefined && opts.allowedPath.length > 0
      ? { allowedPaths: opts.allowedPath }
      : {}),
    ...(opts.mode !== undefined
      ? { initialMode: SessionModeSchema.parse(opts.mode) }
      : {}),
    ...(opts.json !== undefined ? { json: opts.json } : {}),
    ...(opts.tui !== undefined ? { tui: opts.tui } : {}),
  });
}

/**
 * 构造 commander 命令树。
 *
 * CLI 是 {@link createCodingSession} 的薄前端：解析命令 → 装配配置 →
 * 创建/驱动会话 → 渲染事件。命令树覆盖 run/resume/sessions/tools/
 * permissions/memory/goal/config，由 commander 表达。
 */
export function buildProgram(io: CliIo = defaultIo): Command {
  const program = new Command();
  program
    .name('ello')
    .description('ello coding agent')
    .version(VERSION)
    .option('--profile <name>', 'profile suite name')
    .option('--cwd <path>', 'working directory')
    .option('--allowed-path <path...>', 'extra allowed roots')
    .option('--mode <mode>', 'plan | default | accept-edits | bypass')
    .option('--json', 'machine-readable output')
    .option('--no-tui', 'disable TUI for run/resume');

  // 无子命令：进入交互式 TUI。
  program.action(async (opts: GlobalOpts) => {
    const profile = createBootProfile('cli');
    const config = await profile.measure('config', () => resolveConfig(opts));
    const { launchTui } = await profile.measure(
      'tui.import',
      () => import('../tui/index.js'),
    );
    profile.mark('launch');
    await launchTui({ config, profile });
    profile.flush();
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
          const { launchTui } = await import('../tui/index.js');
          await launchTui({
            config: { ...config, sessionId: session ?? null },
          });
        } else {
          await resumeNonInteractive(config, session, io);
        }
      },
    );

  registerCommands(program, { io, resolveConfig });
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
 * 审批在非交互模式下完全由会话模式和规则决定；若策略判
 * required 而无 UI，内核侧会按拒绝处理并把原因喂回模型。CLI 不实现任何业务逻辑。
 */
async function runOnce(
  config: CodingAgentConfig,
  prompt: string,
  io: CliIo,
): Promise<void> {
  const [{ createCodingSession }, { renderEvent }] = await Promise.all([
    import('../runtime/coding-session.js'),
    import('./render.js'),
  ]);
  const session = await createCodingSession({
    config,
    clientCapabilities: { requestUserInput: false },
  });
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
  const { createCodingSession } = await import('../runtime/coding-session.js');
  const coding = await createCodingSession({
    config,
    clientCapabilities: { requestUserInput: false },
  });
  try {
    if (session !== undefined && session.trim() !== '') {
      await coding.resumeSession(session.trim());
    }
    const pending = coding.pendingUserInput();
    io.stdout.write(
      pending === null
        ? `Resumed session ${coding.sessionId}. Use \`ello run <prompt>\` to continue.\n`
        : `Session ${coding.sessionId} is awaiting user input for ${pending.toolCallId}. Resume in the interactive TUI to answer.\n`,
    );
  } finally {
    await coding.close();
  }
}
