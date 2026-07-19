import type { CodingAgentConfig } from '../../config/index.js';
import type { SessionModeState } from '../../domain/thread/session-mode.js';
import type { CodingStorage } from '../../storage/database/index.js';
import type { TaskBoardScope } from '../../storage/tasks/index.js';
import type { AnyAgentTool } from '../engine/index.js';
import { MemoryIndexLoader } from '../memory/index-loader.js';
import {
  MemoryRepository,
  createMemoryTools,
  memoryRoots,
} from '../memory/index.js';
import {
  genericApprovalFor,
  makeApprovalPolicy,
  type DecideApproval,
} from '../permissions/policy.js';
import type { PermissionRule } from '../permissions/types.js';

import { createCodingTools } from './index.js';

export interface ProductionToolRuntime {
  readonly tools: readonly AnyAgentTool[];
  readonly memoryIndexLoader?: MemoryIndexLoader;
  initialize(): Promise<void>;
}

export interface CreateProductionToolRuntimeOptions {
  readonly config: CodingAgentConfig;
  readonly storage: CodingStorage;
  readonly taskBoardScope: TaskBoardScope;
  readonly rules?: () => readonly PermissionRule[];
  readonly mode: () => SessionModeState;
  readonly readRoots?: () => readonly string[];
}

/**
 * 组装生产 Turn 实际可用的工具，而不是仅供领域测试使用的孤立工具。
 * Memory 工具和上下文索引共享同一仓储；成功写入后立即失效索引缓存。
 */
export function createProductionToolRuntime(
  options: CreateProductionToolRuntimeOptions,
): ProductionToolRuntime {
  const decide = createDecisionPolicy(options);
  const codingTools = createCodingTools({
    config: options.config,
    storage: options.storage,
    taskBoardScope: options.taskBoardScope,
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    mode: options.mode,
    ...(options.readRoots === undefined
      ? {}
      : { readRoots: options.readRoots }),
    decide,
  }).map(markCoreTool);
  if (!options.config.context.memory.enabled) {
    return {
      tools: codingTools,
      initialize: () => Promise.resolve(),
    };
  }

  const repository = new MemoryRepository(memoryRoots(options.config));
  const memoryIndexLoader = new MemoryIndexLoader(repository);
  let mutationQueue: Promise<void> = Promise.resolve();
  const memoryTools = createMemoryTools({
    approval: genericApprovalFor(decide),
    port: {
      repository,
      mutate<T>(operation: () => Promise<T>): Promise<T> {
        const result = mutationQueue.then(operation);
        mutationQueue = result.then(
          () => undefined,
          () => undefined,
        );
        return result.then((value) => {
          memoryIndexLoader.invalidate();
          return value;
        });
      },
    },
  })
    .filter((tool) => !options.config.tools.disabled.includes(tool.name))
    .map(markCoreTool);

  return {
    tools: [...codingTools, ...memoryTools],
    memoryIndexLoader,
    initialize: () => repository.initialize(),
  };
}

export function markCoreTool(tool: AnyAgentTool): AnyAgentTool {
  return {
    ...tool,
    discovery: { ...tool.discovery, core: true },
  };
}

function createDecisionPolicy(
  options: CreateProductionToolRuntimeOptions,
): DecideApproval {
  return makeApprovalPolicy(
    options.config,
    options.rules ?? (() => []),
    options.mode,
    options.readRoots ?? (() => []),
  );
}
