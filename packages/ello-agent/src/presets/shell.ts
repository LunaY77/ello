import { z } from 'zod';

import { defineTool } from '../public/tool.js';
import type { AgentTool } from '../public/types.js';

/**
 * 创建 shell 工具。
 *
 * Returns:
 *   包含 shell_exec 的 AgentTool[]。shell_exec 默认要求审批。
 */
export function createShellTools(): AgentTool<any, unknown>[] {
  return [
    defineTool({
      name: 'shell_exec',
      description: 'Execute a shell command in the agent environment.',
      input: z.object({
        command: z.string(),
        cwd: z.string().optional(),
        timeout: z.number().int().positive().optional(),
      }),
      approval: () => 'required',
      execute: async ({ command, cwd, timeout }, ctx) =>
        ctx.environment.shell?.run(command, {
          ...(cwd !== undefined ? { cwd } : {}),
          ...(timeout !== undefined ? { timeout } : {}),
        }) ?? {
          exitCode: 1,
          stdout: '',
          stderr: 'shell unavailable',
        },
    }),
  ];
}
