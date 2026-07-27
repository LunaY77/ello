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
import { requireShell, truncate } from './shared.js';

/**
 * Shell 工具：bash。
 *
 * 执行与 cwd 边界检查委托给 `ctx.environment.shell`；默认审批策略为 `required`
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
Long output is truncated in the middle, keeping the head and the tail, because test runners print their failure summary last. When output is truncated, narrow the command instead of rerunning it unchanged: name a single test file, choose a terser reporter, or pipe through 'tail'.
Use bash for builds, tests, lint, typecheck, code generation, and git inspection. Prefer read, grep, and glob over 'cat', 'grep', and 'find' so results come back structured, and prefer edit or apply_patch over 'sed -i' and shell redirection so file changes are reported.`,
      discovery: {
        aliases: ['shell', 'terminal', 'command'],
        risk: 'external',
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
        const started = Date.now();
        const workingDirectory = cwd ?? config.cwd;
        const result = await requireShell(ctx.agent).run(command, {
          timeout: timeoutMs,
          cwd: workingDirectory,
        });
        const durationMs = Date.now() - started;
        const output = [
          result.stdout.length > 0 ? result.stdout : '',
          result.stderr.length > 0 ? `stderr:\n${result.stderr}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        // 超时进程被终止，输出通常缺少测试 runner 的失败摘要；不给出收窄建议
        // 时调用方倾向原样重跑，再次撞满同一超时。
        const body = result.timedOut
          ? `${timeoutNotice(timeoutMs)}\n${output}`
          : output;
        // 退出码必须进入模型可见文本：metadata 只流向 UI，模型看不到。
        // 截断只作用于命令输出，退出码行始终完整保留在首行。
        return createCodingToolResult({
          title: `bash ${command}`,
          output: `${exitCodeLine(result.exitCode)}\n${truncate(body)}`,
          metadata: {
            kind: 'shell',
            command,
            cwd: workingDirectory,
            exitCode: result.exitCode,
            durationMs,
            stdoutBytes: Buffer.byteLength(result.stdout),
            stderrBytes: Buffer.byteLength(result.stderr),
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
function exitCodeLine(exitCode: number): string {
  return exitCode === -1
    ? 'exit code: killed by signal (no exit code)'
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
