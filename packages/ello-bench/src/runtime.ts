/**
 * benchmark 将 job 的 workspace、Docker shell 和 JSONL recorder 组合为 AgentRuntime。
 *
 * 每个 runtime 仅服务一个 job，工作目录或 event capture 路径不匹配时直接失败。
 */
import path from 'node:path';

import { createLocalEnvironment, type AgentRuntime } from '@ello/agent/runtime';

import type { ContainerShellMode } from './container-shell.js';
import { createDockerShell, type DockerShellEvent } from './docker-shell.js';
import { createEventCaptureRecorder } from './event-capture.js';

export interface BenchmarkAgentRuntimeOptions {
  readonly workspace: string;
  readonly containerName: string;
  readonly containerWorkspace: string;
  readonly rawRoot: string;
  readonly shellMode: ContainerShellMode;
  readonly recordShell?: (event: DockerShellEvent) => Promise<void>;
}

export function createBenchmarkAgentRuntime(
  options: BenchmarkAgentRuntimeOptions,
): AgentRuntime {
  const workspace = path.resolve(options.workspace);
  const captures = new Map<
    string,
    ReturnType<typeof createEventCaptureRecorder>
  >();
  return {
    createEnvironment: ({ config }) => {
      if (path.resolve(config.cwd) !== workspace) {
        throw new Error(
          `Agent cwd does not match benchmark workspace: ${config.cwd}`,
        );
      }
      return createLocalEnvironment({
        cwd: workspace,
        allowedPaths: [workspace],
        shell: createDockerShell({
          containerName: options.containerName,
          hostWorkspace: workspace,
          containerWorkspace: options.containerWorkspace,
          shellMode: options.shellMode,
          ...(options.recordShell === undefined
            ? {}
            : { record: options.recordShell }),
        }),
      });
    },
    createTracing: ({ threadId }) => {
      if (captures.has(threadId)) {
        throw new Error(`Benchmark event capture already exists: ${threadId}`);
      }
      const capture = createEventCaptureRecorder(
        path.join(options.rawRoot, `engine-events-${threadId}.jsonl`),
      );
      captures.set(threadId, capture);
      return {
        eventRecorder: capture.recorder,
        close: () => capture.close(),
      };
    },
  };
}
