/**
 * 本文件把 Environment 的受管进程能力暴露为一个 action 联合工具。
 *
 * `bash` 负责单次前台执行；本工具只负责需要跨工具调用观察和控制的 background 进程，
 * Process Reference 始终保持不透明，不向模型暴露宿主 PID。
 */
import { z } from 'zod';

import type { CodingAgentConfig } from '../../config/index.js';
import type { DecideApproval } from '../permissions/policy.js';

import {
  createCodingToolResult,
  defineCodingTool,
} from './runtime/coding-tool.js';
import { processOutputText, requireProcesses } from './shared.js';

const processInput = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('spawn'),
      command: z.string().min(1),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      maxRuntimeMs: z.number().int().min(1_000).max(86_400_000),
    })
    .strict(),
  z
    .object({
      action: z.literal('inspect'),
      processRef: z.string().min(1),
      stdoutCursor: z.number().int().min(0).default(0),
      stderrCursor: z.number().int().min(0).default(0),
      maxBytes: z.number().int().min(1).max(1_048_576).default(65_536),
    })
    .strict(),
  z
    .object({
      action: z.literal('write'),
      processRef: z.string().min(1),
      data: z.string(),
    })
    .strict(),
  z
    .object({
      action: z.literal('close_stdin'),
      processRef: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('wait'),
      processRef: z.string().min(1),
      timeoutMs: z.number().int().min(1).max(120_000).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('signal'),
      processRef: z.string().min(1),
      signal: z.enum(['SIGINT', 'SIGTERM', 'SIGKILL']),
    })
    .strict(),
]);

/**
 * 创建单个受管后台进程工具。
 *
 * Args:
 * - `config`: 当前 run 的稳定工作目录和工具配置。
 * - `decide`: spawn、stdin 写入和 signal 使用的统一 Tool Policy 判定器。
 *
 * Returns:
 * - 返回只含 `process` 的工具集合，供默认 coding 工具装配直接展开。
 */
export function createProcessTools(
  config: CodingAgentConfig,
  decide: DecideApproval,
) {
  return [
    defineCodingTool({
      name: 'process',
      description: `Manage a bounded background process in the current Environment.
Use action=spawn only for work that must continue across tool calls, such as a dev server or an interactive program; ordinary commands, builds, and tests belong in bash. spawn requires maxRuntimeMs and returns an opaque processRef. Use inspect with independent stdoutCursor and stderrCursor values, then continue from each returned nextCursor. Output is bounded; truncatedBytes reports evidence discarded before the retained window. Use write and close_stdin for input, wait for a terminal status without killing the process, and signal to stop the complete process tree. Background processes may survive the current Agent run until maxRuntimeMs, but never survive their Environment generation.`,
      discovery: {
        aliases: ['background process', 'server process', 'process control'],
        risk: 'external',
      },
      input: processInput,
      capabilities: (input) => {
        const readOnly = input.action === 'inspect' || input.action === 'wait';
        return {
          concurrencySafe: readOnly,
          readOnly,
          destructive: input.action === 'signal',
          interruptible: input.action === 'wait',
          telemetryTag: `process.${input.action}`,
        };
      },
      approval: (input, ctx) => {
        if (input.action === 'inspect' || input.action === 'wait') {
          return 'auto';
        }
        const pattern =
          input.action === 'spawn'
            ? input.command
            : `${input.action}:${input.processRef}`;
        return decide(
          {
            permission: 'bash',
            patterns: [pattern],
            always: [pattern],
            ...(input.action === 'spawn'
              ? { paths: [input.cwd ?? config.cwd] }
              : {}),
            metadata:
              input.action === 'spawn'
                ? {
                    kind: 'shell',
                    command: input.command,
                    cwd: input.cwd ?? config.cwd,
                    risk: 'normal',
                  }
                : {
                    kind: 'generic',
                    inputPreview: pattern,
                  },
          },
          ctx.agent,
        );
      },
      execute: async (input, ctx) => {
        const processes = requireProcesses(ctx.agent);
        switch (input.action) {
          case 'spawn': {
            const processRef = await processes.spawn({
              command: input.command,
              cwd: input.cwd ?? config.cwd,
              ...(input.env === undefined ? {} : { env: input.env }),
              lifecycle: 'background',
              maxRuntimeMs: input.maxRuntimeMs,
            });
            return processResult('Background process started', {
              action: input.action,
              processRef,
              maxRuntimeMs: input.maxRuntimeMs,
            });
          }
          case 'inspect': {
            const observation = await processes.inspect(input.processRef, {
              stdoutCursor: input.stdoutCursor,
              stderrCursor: input.stderrCursor,
              maxBytes: input.maxBytes,
            });
            return processResult('Process observation', {
              action: input.action,
              processRef: input.processRef,
              status: observation.status,
              stdout: outputView(observation.stdout, 'stdout'),
              stderr: outputView(observation.stderr, 'stderr'),
              ...(observation.exit === undefined
                ? {}
                : { exit: observation.exit }),
            });
          }
          case 'write':
            await processes.write(
              input.processRef,
              Buffer.from(input.data, 'utf8'),
            );
            return processResult('Process input written', {
              action: input.action,
              processRef: input.processRef,
              bytes: Buffer.byteLength(input.data),
            });
          case 'close_stdin':
            await processes.closeStdin(input.processRef);
            return processResult('Process stdin closed', {
              action: input.action,
              processRef: input.processRef,
            });
          case 'wait': {
            const exit = await processes.wait(input.processRef, {
              ...(input.timeoutMs === undefined
                ? {}
                : { timeoutMs: input.timeoutMs }),
              ...(ctx.abortSignal === undefined
                ? {}
                : { signal: ctx.abortSignal }),
            });
            return processResult('Process exited', {
              action: input.action,
              processRef: input.processRef,
              exit,
            });
          }
          case 'signal':
            await processes.signal(input.processRef, input.signal);
            return processResult('Process signal sent', {
              action: input.action,
              processRef: input.processRef,
              signal: input.signal,
            });
          default:
            input satisfies never;
            throw new Error('Unsupported process action.');
        }
      },
    }),
  ];
}

function outputView(
  output: Parameters<typeof processOutputText>[0] & {
    readonly cursor: number;
    readonly nextCursor: number;
    readonly complete: boolean;
  },
  label: 'stdout' | 'stderr',
) {
  return {
    text: processOutputText(output, label),
    cursor: output.cursor,
    nextCursor: output.nextCursor,
    totalBytes: output.totalBytes,
    truncatedBytes: output.truncatedBytes,
    complete: output.complete,
  };
}

function processResult(title: string, output: Record<string, unknown>) {
  return createCodingToolResult({
    title,
    output: JSON.stringify(output, null, 2),
    metadata: {
      kind: 'process',
      action: output.action,
      processRef: output.processRef,
    },
  });
}
