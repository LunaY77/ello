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
      description:
        'Run a shell command in the workspace with timeout and captured stdout/stderr.',
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
        return createCodingToolResult({
          title: `bash ${command}`,
          output: truncate(output),
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
