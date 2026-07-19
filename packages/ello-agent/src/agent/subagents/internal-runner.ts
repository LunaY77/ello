import type { CodingAgentConfig } from '../../config/index.js';
import {
  createAgent,
  defineTool,
  type AgentModel,
  type ModelAdapter,
  type ModelInput,
  z,
} from '../engine/index.js';
import {
  modelSettingsFromRole,
  prepareModelInputForRuntimeModel,
  providerOptionsForRole,
  type ProviderRegistry,
  type RuntimeRoleModel,
} from '../providers/catalog/index.js';

import type { CodingAgentDefinition } from './schema.js';

export async function runInternalAgent(input: {
  readonly definition: CodingAgentDefinition;
  readonly prompt: string;
  readonly profileName: string;
  readonly config: CodingAgentConfig;
  readonly providerRegistry: ProviderRegistry;
  readonly modelAdapter?: ModelAdapter;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const binding = resolveBinding(input.definition, input);
  const complete = defineTool({
    name: 'internal_complete',
    description: 'Return a completed internal-agent response payload.',
    discovery: { aliases: ['complete response'], risk: 'readonly' },
    input: z.object({ output: z.string() }).strict(),
    execute: ({ output }) => output,
  });
  const agent = createAgent({
    name: `ello-${input.definition.name}`,
    model: resolveAgentModel(binding, input),
    modelSettings: modelSettingsFromRole(binding),
    executionTools: [complete],
    modelTools: [complete],
    ...(input.definition.prompt === undefined
      ? {}
      : { instructions: input.definition.prompt }),
    ...(input.modelAdapter === undefined
      ? {
          modelInput: {
            providerOptions: () => providerOptionsForRole(binding),
            prepare: (modelInput: ModelInput) =>
              prepareModelInputForRuntimeModel(binding.model, modelInput, {
                promptProfile: `internal:${input.definition.name}`,
                cwdIdentity: input.config.cwd,
              }),
          },
        }
      : { modelAdapter: input.modelAdapter }),
    metadata: { internal: true, agentName: input.definition.name },
  });
  try {
    const result = await agent.run(input.prompt, {
      maxTurns: input.definition.maxTurns ?? 4,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return result.output || result.text || '';
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

function resolveAgentModel(
  binding: RuntimeRoleModel,
  input: {
    readonly providerRegistry: ProviderRegistry;
    readonly modelAdapter?: ModelAdapter;
  },
): AgentModel {
  return input.modelAdapter === undefined
    ? input.providerRegistry.resolveLanguageModel(binding.ref, binding.settings)
    : binding.ref;
}
