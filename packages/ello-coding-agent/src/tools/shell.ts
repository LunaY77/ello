import { defineTool, type AnyAgentTool } from '@ello/agent';
import { z } from 'zod';

import type { CodingAgentConfig } from '../config.js';

import { requireShell, truncate, type ApprovalFor } from './shared.js';

/**
 * Shell 工具：bash。
 *
 * 执行与 cwd 边界检查委托给 `ctx.environment.shell`；默认审批策略为 `required`
 * （命令有任意副作用）。返回结构化结果供 presenter 渲染。
 */
export function createShellTools(
  config: CodingAgentConfig,
  approval: ApprovalFor,
): AnyAgentTool[] {
  return [
    defineTool({
      name: 'bash',
      description:
        'Run a shell command in the workspace with timeout and captured stdout/stderr.',
      input: z.object({
        command: z.string(),
        timeoutMs: z.number().int().min(1000).max(120_000).default(30_000),
        cwd: z.string().optional(),
        reason: z.string().optional(),
      }),
      approval: approval('bash'),
      execute: async ({ command, timeoutMs, cwd }, ctx) => {
        const started = Date.now();
        const result = await requireShell(ctx).run(command, {
          timeout: timeoutMs,
          ...(cwd !== undefined ? { cwd } : { cwd: config.cwd }),
        });
        return {
          exitCode: result.exitCode,
          durationMs: Date.now() - started,
          stdout: truncate(result.stdout),
          stderr: truncate(result.stderr),
        };
      },
    }),
  ];
}
