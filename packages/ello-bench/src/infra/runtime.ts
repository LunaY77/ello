/**
 * benchmark 将 job 的 Container Environment 与 JSONL recorder 组合为 AgentRuntime。
 *
 * 每个 runtime 仅服务一个 job；Environment Reference 直接使用唯一容器名。
 */
import path from 'node:path';

import type { AgentRuntime } from '@ello/agent/runtime';
import {
  createLocalEnvironments,
  LOCAL_HOST_ENVIRONMENT_REFERENCE,
} from '@ello/agent/runtime';

import type { ContainerHandle } from '../ports/container.js';

import { createContainerEnvironments } from './agent/ello/container-environment.js';
import { createEventCaptureRecorder } from './event-capture.js';

export interface BenchmarkAgentRuntimeOptions {
  readonly rawRoot: string;
  readonly container: ContainerHandle;
}

export function createBenchmarkAgentRuntime(
  options: BenchmarkAgentRuntimeOptions,
): AgentRuntime {
  const captures = new Map<
    string,
    ReturnType<typeof createEventCaptureRecorder>
  >();
  return {
    environments: createContainerEnvironments({
      container: options.container,
    }),
    defaultEnvironmentRef: options.container.name,
    environmentGrant: { isolation: 'none' },
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

export function createContainerLocalAgentRuntime(options: {
  readonly rawRoot: string;
}): AgentRuntime {
  const captures = new Map<
    string,
    ReturnType<typeof createEventCaptureRecorder>
  >();
  return {
    environments: createLocalEnvironments({
      environmentRef: LOCAL_HOST_ENVIRONMENT_REFERENCE,
    }),
    defaultEnvironmentRef: LOCAL_HOST_ENVIRONMENT_REFERENCE,
    environmentGrant: { isolation: 'none' },
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
