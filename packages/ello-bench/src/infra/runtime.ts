/**
 * benchmark 将 job 的 workspace、执行 shell 和 JSONL recorder 组合为 AgentRuntime。
 *
 * 每个 runtime 仅服务一个 job，工作目录或 event capture 路径不匹配时直接失败。
 */
import path from 'node:path';

import type { AgentRuntime } from '@ello/agent/runtime';

import type { ContainerHandle } from '../ports/container.js';

import { createContainerEnvironment } from './agent/ello/container-environment.js';
import { createEventCaptureRecorder } from './event-capture.js';

export interface BenchmarkAgentRuntimeOptions {
  readonly workspace: string;
  readonly rawRoot: string;
  readonly container: ContainerHandle;
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
      if (path.posix.resolve(config.cwd) !== options.container.workspace) {
        throw new Error(
          `Agent cwd does not match benchmark workspace: ${config.cwd}`,
        );
      }
      void workspace;
      return createContainerEnvironment({ container: options.container });
    },
    createTracing: ({ threadId }) => {
      const existing = captures.get(threadId);
      if (existing !== undefined) {
        return {
          eventRecorder: existing.recorder,
          close: () => existing.close(),
        };
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
