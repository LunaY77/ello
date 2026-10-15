/**
 * 本文件负责 tool feature 的“shell”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { z } from 'zod';

import { cliInput, commandInput, defineCommand } from '../../command/index.js';
import type { CodingAgentConfig } from '../../config/index.js';
import type { DecideApproval } from '../permissions/policy.js';
import type { PermissionMetadata } from '../permissions/types.js';

import { createCommandResult } from './runtime/command-result.js';
import { processOutputText, requireProcesses } from './shared.js';

/**
 * Shell 工具：bash。
 *
 * 执行与进程树生命周期委托给 `ctx.environment.processes`；默认审批策略为 `required`
 * （命令有任意副作用）。返回结构化结果供 presenter 渲染。
 *
 * Args:
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 * - `decide`: `createShellTools` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createShellTools` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `shell` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createShellCommands(
  config: CodingAgentConfig,
  decide: DecideApproval,
) {
  const bashInput = z
    .object({
      command: z.string().min(1).describe('Shell program to execute'),
      timeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(120_000)
        .default(30_000)
        .describe('Timeout in milliseconds'),
      cwd: z.string().optional().describe('Working directory for the command'),
      reason: z.string().optional().describe('Reason for running this command'),
    })
    .strict();
  return [
    defineCommand({
      name: 'bash',
      summary: 'Run a shell program in the Environment.',
      details: `Returns the exit code, then stdout, then stderr under a 'stderr:' heading. A nonzero exit marks the Command failed and still returns its output. On timeout the process is killed and its output so far is returned.`,
      examples: [
        {
          description: 'Run a shell program',
          frame: { body: 'date' },
        },
      ],
      aliases: ['shell', 'terminal', 'command'],
      risk: 'external',
      effects: ({ command }) => {
        const readOnly = isClearlyReadOnlyCommand(command);
        return {
          concurrencySafe: readOnly,
          readOnly,
          destructive: !readOnly,
          interruptible: true,
          telemetryTag: readOnly ? 'shell.read' : 'shell.command',
        };
      },
      invocation: cliInput(commandInput(bashInput), {
        options: ['timeoutMs', 'cwd', 'reason'],
        body: 'command',
      }),
      approval: async (input, ctx) =>
        decide(
          {
            permission: 'bash',
            patterns: [input.command],
            always: [input.command],
            paths: [input.cwd ?? config.cwd],
            metadata: shellMetadata(input, config),
          },
          ctx,
        ),
      execution: {
        kind: 'immediate',
        run: async ({ command, timeoutMs, cwd }, ctx) => {
          const workingDirectory = cwd ?? config.cwd;
          const result = await requireProcesses(ctx).exec({
            command,
            maxRuntimeMs: timeoutMs,
            cwd: workingDirectory,
            signal: ctx.signal,
          });
          const stdout = processOutputText(result.stdout, 'stdout');
          const stderr = processOutputText(result.stderr, 'stderr');
          const output = [stdout, stderr.length > 0 ? `stderr:\n${stderr}` : '']
            .filter(Boolean)
            .join('\n');
          // 超时进程被终止，输出通常缺少测试 runner 的失败摘要；不给出收窄建议
          // 时调用方倾向原样重跑，再次撞满同一超时。
          const body = result.timedOut
            ? `${timeoutNotice(timeoutMs)}\n${output}`
            : output;
          // 退出码必须进入模型可见文本：metadata 只流向 UI，模型看不到。
          // 长输出由统一 adapter 处理；退出码行始终保留在模型可见首行。
          return createCommandResult({
            title: `bash ${command}`,
            output: `${exitCodeLine(result.exitCode, result.signal)}\n${body}`,
            metadata: {
              kind: 'shell',
              command,
              cwd: workingDirectory,
              exitCode: result.exitCode ?? -1,
              durationMs: result.durationMs,
              stdoutBytes: result.stdout.totalBytes,
              stderrBytes: result.stderr.totalBytes,
            },
          });
        },
      },
    }),
  ];
}

/**
 * 生成超时提示行，附加在被终止命令的输出之前。
 *
 * Args:
 * - `timeoutMs`: 本次调用生效的超时上限；提示中回显该值供调用方判断收窄幅度。
 *
 * Returns:
 * - 返回 `timeoutNotice` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
/**
 * 生成退出码行。`-1` 表示进程被信号终止（超时），没有正常退出码。
 *
 * Args:
 * - `exitCode`: 被执行命令的真实退出码；管道命令遵循 Bash 的默认末项退出码语义。
 *
 * Returns:
 * - 返回置于输出首行的单行退出码描述。
 */
function exitCodeLine(exitCode: number | null, signal: string | null): string {
  return exitCode === null
    ? `exit code: killed by ${signal ?? 'signal'} (no exit code)`
    : `exit code: ${exitCode}`;
}

function timeoutNotice(timeoutMs: number): string {
  return `Note: the command was killed after exceeding its ${timeoutMs} ms timeout, so the output below is incomplete and any test summary is missing. Do not rerun it unchanged: narrow the scope to a single test file or directory, choose a terser reporter such as --reporter=basic, or pipe through 'tail' to keep only the summary.`;
}

function shellMetadata(
  input: {
    readonly command: string;
    readonly cwd?: string | undefined;
    readonly reason?: string | undefined;
  },
  config: CodingAgentConfig,
): Extract<PermissionMetadata, { kind: 'shell' }> {
  return {
    kind: 'shell',
    command: input.command,
    cwd: input.cwd ?? config.cwd,
    risk: analyzeCommandRisk(input.command),
  };
}

function analyzeCommandRisk(command: string): 'normal' | 'dangerous' {
  return /\b(rm\s+-rf|sudo|chmod\s+-R|chown\s+-R|mkfs|dd\s+if=)/u.test(command)
    ? 'dangerous'
    : 'normal';
}

/**
 * 判断一条命令是否可以确定为只读操作。
 *
 * 只有不包含控制运算符和命令替换、且命令本身在只读白名单中的简单调用才会通过。
 * 其他命令一律按可能修改数据处理，并使用独占锁执行。
 */
function isClearlyReadOnlyCommand(command: string): boolean {
  const normalized = command.trim();
  if (
    normalized === '' ||
    /[;&|<>`\n\r]|\$\(/u.test(normalized) ||
    /(?:^|\s)(?:--output|-o|--pre|--exec|-exec|--write|-w)(?:=|\s|$)/u.test(
      normalized,
    )
  ) {
    return false;
  }
  if (normalized === 'pwd') return true;
  if (/^(?:ls|rg|grep|cat|head|tail|wc|stat|file)(?:\s|$)/u.test(normalized)) {
    return true;
  }
  if (/^sed\s+-n(?:\s|$)/u.test(normalized)) return true;
  return /^git\s+(?:status|diff|show|log|rev-parse|ls-files|grep)(?:\s|$)/u.test(
    normalized,
  );
}
