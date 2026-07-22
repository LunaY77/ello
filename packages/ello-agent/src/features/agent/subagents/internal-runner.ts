/**
 * 本文件负责 agent feature 的“internal-runner”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import type { CodingAgentConfig } from '../../config/index.js';
import {
  modelSettingsFromRole,
  prepareModelInputForRuntimeModel,
  providerOptionsForRole,
  type ProviderRegistry,
  type RuntimeRoleModel,
} from '../../model/index.js';
import {
  createAgent,
  defineTool,
  type ModelAdapter,
  type ModelInput,
  z,
} from '../engine/index.js';

import type { CodingAgentDefinition } from './schema.js';

/**
 * 在 产品 Agent `internal-runner` 模块 中执行 `runInternalAgent` 完整流程，并在返回前完成其必要副作用。
 *
 * Args:
 * - `input`: `runInternalAgent` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - Promise 在 产品 Agent `internal-runner` 模块 的异步读取或状态变更完成后兑现为声明结果。
 *
 * Throws:
 * - 当 产品 Agent `internal-runner` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function runInternalAgent(input: {
  readonly definition: CodingAgentDefinition;
  readonly prompt: string;
  readonly profileName: string;
  readonly config: CodingAgentConfig;
  readonly providerRegistry: ProviderRegistry;
  readonly modelAdapter: ModelAdapter;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const binding = resolveBinding(input.definition, input);
  const complete = defineTool({
    name: 'internal_complete',
    description: 'Return a completed internal-agent response payload.',
    discovery: { aliases: ['complete response'], risk: 'readonly' },
    input: z
      .object({ output: z.string().describe('Completed response payload') })
      .strict(),
    execute: ({ output }) => output,
  });
  const agent = createAgent({
    name: `ello-${input.definition.name}`,
    model: input.providerRegistry.resolveLanguageModel(binding.ref),
    modelAdapter: input.modelAdapter,
    environment: {},
    modelSettings: modelSettingsFromRole(binding),
    executionTools: [complete],
    modelTools: [complete],
    ...(input.definition.prompt === undefined
      ? {}
      : { instructions: input.definition.prompt }),
    modelInput: {
      providerOptions: () => providerOptionsForRole(binding),
      prepare: (modelInput: ModelInput) =>
        prepareModelInputForRuntimeModel(binding.model, modelInput, {
          promptProfile: `internal:${input.definition.name}`,
          cwdIdentity: input.config.cwd,
        }),
    },
    metadata: { internal: true, agentName: input.definition.name },
  });
  try {
    const result = await agent.run(input.prompt, {
      maxTurns: input.definition.maxTurns,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.output.trim() === '') {
      throw new Error(
        `Internal agent '${input.definition.name}' returned empty output.`,
      );
    }
    return result.output;
  } finally {
    await agent.close();
  }
}

function resolveBinding(
  definition: CodingAgentDefinition,
  input: {
    readonly profileName: string;
    readonly providerRegistry: ProviderRegistry;
  },
): RuntimeRoleModel {
  const base = input.providerRegistry.resolveRole(
    input.profileName,
    definition.role,
  );
  if (definition.modelRef === undefined) return base;
  return {
    ...base,
    ref: definition.modelRef,
    model: input.providerRegistry.getModel(definition.modelRef),
  };
}
