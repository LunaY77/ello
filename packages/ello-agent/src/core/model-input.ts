import type {
  AgentMessage,
  AgentToolSet,
  ModelInput,
  ModelInputDiagnostics,
} from '../public/types.js';

import {
  defaultMessageTransforms,
  estimateMessagesTokens,
  estimateTextTokens,
} from './input-transforms.js';
import { retrieveMemoryForModelInput } from './memory-runtime.js';
import type { RunSession } from './run-session.js';

export async function buildModelInput(run: RunSession): Promise<ModelInput> {
  const systemResult = await buildSystem(run);
  const messagesResult = await buildFinalMessages(run);
  const tools = buildTools(run);
  const providerOptions = await buildProviderOptions(run);
  const input: ModelInput = {
    ...(systemResult.system !== undefined
      ? { system: systemResult.system }
      : {}),
    messages: messagesResult.messages,
    tools,
    ...(providerOptions !== undefined ? { providerOptions } : {}),
    diagnostics: createModelInputDiagnostics({
      ...(systemResult.system !== undefined
        ? { system: systemResult.system }
        : {}),
      systemSections: systemResult.sectionCount,
      messages: messagesResult.messages,
      ...(providerOptions !== undefined ? { providerOptions } : {}),
      appliedMessageTransforms: messagesResult.appliedTransforms,
    }),
  };
  return applyPrepareModelInput(input, run);
}

async function buildSystem(
  run: RunSession,
): Promise<{ readonly system?: string; readonly sectionCount: number }> {
  const sections: string[] = [];
  if (run.config.instructions) {
    sections.push(run.config.instructions);
  }
  const environmentInstructions =
    (await run.environment.getContextInstructions?.(run.ctx)) ??
    (await run.environment.getInstructions?.());
  if (environmentInstructions) {
    sections.push(environmentInstructions);
  }
  for (const section of run.config.modelInput?.systemSections ?? []) {
    const text = await section(run.ctx);
    if (text) {
      sections.push(text);
    }
  }
  const memoryText = await buildMemorySystemSection(run);
  if (memoryText) {
    sections.push(memoryText);
  }
  return {
    ...(sections.length > 0 ? { system: sections.join('\n\n') } : {}),
    sectionCount: sections.length,
  };
}

async function buildFinalMessages(run: RunSession): Promise<{
  readonly messages: AgentMessage[];
  readonly appliedTransforms: readonly string[];
}> {
  let messages: readonly AgentMessage[] = [...run.state.messages];
  const appliedTransforms: string[] = [];
  for (const transform of defaultMessageTransforms(run)) {
    messages = await transform(messages, run.ctx);
    appliedTransforms.push(transform.name || 'default-message-transform');
  }
  for (const transform of run.config.modelInput?.messageTransforms ?? []) {
    messages = await transform(messages, run.ctx);
    appliedTransforms.push(transform.name || 'modelInput.messageTransform');
  }
  return { messages: [...messages], appliedTransforms };
}

function buildTools(run: RunSession): AgentToolSet {
  return run.tools;
}

async function buildProviderOptions(
  run: RunSession,
): Promise<Record<string, unknown> | undefined> {
  const options = await run.config.modelInput?.providerOptions?.(run.ctx);
  return options ?? undefined;
}

async function applyPrepareModelInput(
  input: ModelInput,
  run: RunSession,
): Promise<ModelInput> {
  return (await run.config.modelInput?.prepare?.(input, run.ctx)) ?? input;
}

async function buildMemorySystemSection(
  run: RunSession,
): Promise<string | null> {
  const memories = await retrieveMemoryForModelInput(run);
  if (memories.length === 0) {
    return null;
  }
  return ['Relevant memory:', ...memories.map((item) => `- ${item.text}`)].join(
    '\n',
  );
}

function createModelInputDiagnostics(options: {
  readonly system?: string;
  readonly systemSections: number;
  readonly messages: readonly AgentMessage[];
  readonly providerOptions?: Record<string, unknown>;
  readonly appliedMessageTransforms: readonly string[];
}): ModelInputDiagnostics {
  return {
    systemSections: options.systemSections,
    messageCount: options.messages.length,
    estimatedInputTokens:
      estimateMessagesTokens(options.messages) +
      estimateTextTokens(options.system ?? ''),
    hasProviderOptions: options.providerOptions !== undefined,
    appliedMessageTransforms: options.appliedMessageTransforms,
  };
}
