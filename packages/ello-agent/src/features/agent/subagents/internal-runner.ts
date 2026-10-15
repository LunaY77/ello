/**
 * 本文件负责 agent feature 的“internal-runner”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { z } from 'zod';

import {
  cliInput,
  commandInput,
  createCommandRegistrySnapshot,
  createCommandRunRuntime,
  defineCommand,
  defineCommandModule,
} from '../../command/index.js';
import type { CodingAgentConfig } from '../../config/index.js';
import type { EnvironmentHandle } from '../../environment/index.js';
import {
  modelInputBudgetFromRuntimeModel,
  modelSettingsFromRuntimeModel,
  providerOptionsFromRuntimeModel,
  prepareModelInputForRuntimeModel,
  type ModelRegistry,
} from '../../model/index.js';
import {
  createAgent,
  type ModelAdapter,
  type ModelInput,
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
  readonly config: CodingAgentConfig;
  readonly modelRegistry: ModelRegistry;
  readonly modelAdapter: ModelAdapter;
  readonly environment: EnvironmentHandle;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const model = input.modelRegistry.resolveSelector(input.definition.model);
  const modelInputBudget = modelInputBudgetFromRuntimeModel(
    model,
    input.config.context,
  );
  const completeInput = z
    .object({ output: z.string().describe('Completed response payload') })
    .strict();
  const complete = defineCommand({
    name: 'internal_complete',
    summary: 'Return a completed internal-agent response payload.',
    aliases: ['complete response'],
    risk: 'readonly',
    invocation: cliInput(commandInput(completeInput), { body: 'output' }),
    execution: {
      kind: 'immediate',
      run: ({ output }) => output,
    },
  });
  let agent: ReturnType<typeof createAgent> | undefined;
  try {
    agent = createAgent({
      name: `ello-${input.definition.name}`,
      model: input.modelRegistry.resolveLanguageModel(model.name),
      modelCall: {
        agentName: input.definition.name,
        modelSelector: input.definition.model,
        configuredModel: model.name,
        protocol: model.protocol,
        apiModel: model.apiModel,
      },
      modelAdapter: input.modelAdapter,
      environment: input.environment,
      modelSettings: modelSettingsFromRuntimeModel(model),
      modelInputBudget,
      commandRun: createCommandRunRuntime(
        createCommandRegistrySnapshot({
          modules: [
            defineCommandModule({
              id: 'internal',
              commands: [complete],
            }),
          ],
          search: { resultLimit: 6, maxResultBytes: 24_000 },
        }),
      ),
      ...(input.definition.prompt === undefined
        ? {}
        : { instructions: input.definition.prompt }),
      modelInput: {
        providerOptions: () => providerOptionsFromRuntimeModel(model),
        prepare: (modelInput: ModelInput) =>
          prepareModelInputForRuntimeModel(model, modelInput, {
            promptProfile: `internal:${input.definition.name}`,
            cwdIdentity: input.config.cwd,
          }),
      },
      metadata: { internal: true, agentName: input.definition.name },
    });
    const result = await agent.run(input.prompt, {
      ...(input.definition.maxTurns === undefined
        ? {}
        : { maxTurns: input.definition.maxTurns }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (result.output.trim() === '') {
      throw new Error(
        `Internal agent '${input.definition.name}' returned empty output.`,
      );
    }
    return result.output;
  } finally {
    if (agent === undefined) await input.environment.close();
    else await agent.close();
  }
}
