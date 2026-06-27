import type { ModelMessage } from 'ai';

import type {
  AgentRuntimeGenerateInput,
  AgentRuntimeRunInput,
} from '../agents.js';
import type { AgentContext } from '../context.js';
import type { Environment } from '../environment/index.js';
import {
  coldStartTrim,
  createEnvironmentInstructionsFilter,
  injectRuntimeInstructions,
} from '../filters/index.js';

export interface RuntimeInputParts {
  promptText: string | null;
  promptMessages: ModelMessage[] | null;
  messages: ModelMessage[] | null;
  sdkOptions: Omit<AgentRuntimeGenerateInput, 'prompt' | 'messages'>;
}

export function splitRuntimeInput(
  input: AgentRuntimeGenerateInput,
): RuntimeInputParts {
  const inputWithRuntimeFields = input as AgentRuntimeGenerateInput & {
    model?: unknown;
    tools?: unknown;
    prompt?: unknown;
    messages?: unknown;
  };
  const {
    model: _model,
    tools: _tools,
    prompt,
    messages,
    ...options
  } = inputWithRuntimeFields;
  return {
    promptText: typeof prompt === 'string' ? prompt : null,
    promptMessages: Array.isArray(prompt) ? (prompt as ModelMessage[]) : null,
    messages: Array.isArray(messages) ? (messages as ModelMessage[]) : null,
    sdkOptions: options as Omit<
      AgentRuntimeGenerateInput,
      'prompt' | 'messages'
    >,
  };
}

export function assertRunInput(
  input: unknown,
): asserts input is AgentRuntimeRunInput {
  if (
    typeof input === 'string' ||
    (typeof input === 'object' && input !== null && !Array.isArray(input))
  ) {
    return;
  }
  throw new TypeError(
    'AgentRuntime.run() input must be a prompt string or an AI SDK generateText options object.',
  );
}

export function resolveInitialMessages(
  runtimeInput: string | null,
  promptMessages: ModelMessage[] | null,
  messages: ModelMessage[] | null,
  sessionHistory: ModelMessage[] | null,
): ModelMessage[] {
  const baseMessages = [
    ...(messages ?? promptMessages ?? sessionHistory ?? []),
  ];
  if (runtimeInput !== null && messages === null && promptMessages === null) {
    return [...baseMessages, { role: 'user', content: runtimeInput }];
  }
  return baseMessages;
}

export function normalizeRunMessages(
  input: AgentRuntimeRunInput,
): ModelMessage[] {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }];
  }
  if (input.messages !== undefined) {
    return [...input.messages];
  }
  if (Array.isArray(input.prompt)) {
    return [...input.prompt];
  }
  if (typeof input.prompt === 'string') {
    return [{ role: 'user', content: input.prompt }];
  }
  return [];
}

export function normalizeInitialMessages(
  input: AgentRuntimeRunInput,
): ModelMessage[] {
  return normalizeRunMessages(input);
}

export async function applyHistoryFilters(
  messageHistory: ModelMessage[],
  ctx: AgentContext,
  env: Environment,
): Promise<ModelMessage[]> {
  let history = coldStartTrim({ deps: ctx }, messageHistory);
  history = await createEnvironmentInstructionsFilter(env)(
    { deps: ctx },
    history,
  );
  history = await injectRuntimeInstructions({ deps: ctx }, history);
  return history;
}
