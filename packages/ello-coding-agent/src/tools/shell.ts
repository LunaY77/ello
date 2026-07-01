import { z } from 'zod';

import type { CodingAgentConfig } from '../config/index.js';
import type { DecideApproval } from '../permission/policy.js';
import type { PermissionMetadata } from '../permission/types.js';

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
      input: z.object({
        command: z.string(),
        timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
        cwd: z.string().optional(),
        reason: z.string().optional(),
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
