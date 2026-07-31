/**
 * 本文件负责 tool feature 的“shell”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { z } from 'zod';

import type { CodingAgentConfig } from '../../config/index.js';
import type { DecideApproval } from '../permissions/policy.js';
import type { PermissionMetadata } from '../permissions/types.js';

import {
  createCodingToolResult,
  defineCodingTool,
} from './runtime/coding-tool.js';
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
export function createShellTools(
  config: CodingAgentConfig,
  decide: DecideApproval,
) {
  return [
    defineCodingTool({
      name: 'bash',
      description: `Run one shell command in the workspace and return its stdout followed by its stderr under a 'stderr:' heading.
'timeoutMs' defaults to 30000 and cannot exceed 120000; on timeout the process is killed and whatever it had already written is still returned, so a killed test run is reported as a timeout rather than as a failure. A nonzero exit is a normal result, not a tool error: read the output to decide what to do.
Long output is centrally reduced to a bounded head/tail preview while the complete result is retained as an artifact, because test runners print their failure summary last. When output is reduced, narrow the command instead of rerunning it unchanged: name a single test file, choose a terser reporter, or pipe through 'tail'.
Use bash for builds, tests, lint, typecheck, code generation, and git inspection. Prefer read, grep, and glob over 'cat', 'grep', and 'find' so results come back structured, and prefer edit or apply_patch over 'sed -i' and shell redirection so file changes are reported.`,
      discovery: {
        aliases: ['shell', 'terminal', 'command'],
        risk: 'external',
      },
      capabilities: ({ command }) => {
        const readOnly = isClearlyReadOnlyCommand(command);
        return {
          concurrencySafe: readOnly,
          readOnly,
          destructive: !readOnly,
          interruptible: true,
          telemetryTag: readOnly ? 'shell.read' : 'shell.command',
        };
      },
      input: z
        .object({
          command: z.string().min(1).describe('Shell command to execute'),
          timeoutMs: z
            .number()
            .int()
            .min(1000)
            .max(120_000)
            .default(30_000)
            .describe('Timeout in milliseconds'),
          cwd: z
            .string()
            .optional()
            .describe('Working directory for the command'),
          reason: z
            .string()
            .optional()
            .describe('Reason for running this command'),
        })
        .strict(),
      approval: async (input, ctx) =>
        decide(
          {
            permission: 'bash',
            patterns: [input.command],
            always: [input.command],
            paths: [input.cwd ?? config.cwd],
            metadata: shellMetadata(input, config),
          },
          ctx.agent,
        ),
      execute: async ({ command, timeoutMs, cwd }, ctx) => {
        const workingDirectory = cwd ?? config.cwd;
        const result = await requireProcesses(ctx.agent).exec({
          command,
          maxRuntimeMs: timeoutMs,
          cwd: workingDirectory,
          ...(ctx.abortSignal === undefined ? {} : { signal: ctx.abortSignal }),
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
        return createCodingToolResult({
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
    }),
    defineCodingTool({
      name: 'test',
      description:
        'Run one verification command with an explicit phase and return a structured result. Use preflight before relying on an environment, baseline before edits when practical, targeted during implementation, new for newly added tests, and final for the broad acceptance check.',
      discovery: {
        aliases: ['verify', 'check tests'],
        risk: 'external',
      },
      capabilities: () => ({
        concurrencySafe: false,
        readOnly: false,
        destructive: false,
        interruptible: true,
        telemetryTag: 'test.command',
      }),
      input: z
        .object({
          phase: z.enum(['preflight', 'baseline', 'targeted', 'new', 'final']),
          command: z.string().min(1),
          timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
          cwd: z.string().optional(),
        })
        .strict(),
      approval: (input, ctx) =>
        decide(
          {
            permission: 'bash',
            patterns: [input.command],
            always: [input.command],
            paths: [input.cwd ?? config.cwd],
            metadata: {
              kind: 'shell',
              command: input.command,
              cwd: input.cwd ?? config.cwd,
              risk: 'normal',
            },
          },
          ctx.agent,
        ),
      execute: async ({ phase, command, timeoutMs, cwd }, ctx) => {
        const workingDirectory = cwd ?? config.cwd;
        const result = await requireProcesses(ctx.agent).exec({
          command,
          maxRuntimeMs: timeoutMs,
          cwd: workingDirectory,
          ...(ctx.abortSignal === undefined ? {} : { signal: ctx.abortSignal }),
        });
        const stdout = processOutputText(result.stdout, 'stdout');
        const stderr = processOutputText(result.stderr, 'stderr');
        const output = [
          JSON.stringify({
            phase,
            command,
            cwd: workingDirectory,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            signal: result.signal,
            durationMs: result.durationMs,
          }),
          stdout,
          stderr === '' ? '' : `stderr:\n${stderr}`,
        ]
          .filter(Boolean)
          .join('\n');
        return createCodingToolResult({
          title: `${phase} verification`,
          output,
          metadata: {
            kind: 'shell',
            command,
            cwd: workingDirectory,
            phase,
            exitCode: result.exitCode ?? -1,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            stdoutBytes: result.stdout.totalBytes,
            stderrBytes: result.stderr.totalBytes,
          },
        });
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
 * - `exitCode`: 被执行命令的真实退出码，已由 shell 层的 `pipefail` 保证不被管道吞掉。
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
