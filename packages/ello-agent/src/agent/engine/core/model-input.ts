import type {
  AgentMessage,
  AgentToolSet,
  ModelInput,
  ModelInputDiagnostics,
} from '../api/types.js';

import {
  fingerprintMessagePrefix,
  fingerprintSystem,
  fingerprintToolset,
  hasCompactionBoundary,
} from './fingerprints.js';
import {
  defaultMessageTransforms,
  estimateMessagesTokens,
  estimateTextTokens,
} from './input-transforms.js';
import type { RunSession } from './run-session.js';

/**
 * 构建单轮模型输入 {@link ModelInput}。
 *
 * 把一次回合所需的全部输入装配到一起：
 * - system：拼接内核指令、环境指令与配置注入的 system 段落；
 * - messages：以当前会话历史为基，依次跑完默认与用户自定义的消息变换；
 * - tools / providerOptions：从 run 配置取出；
 * - diagnostics：记录段落数、消息数、估算 token、已应用的变换名等，便于排查。
 * 最后还会给用户一个 `prepare` 钩子，对成型的输入做最终改写。
 */
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
      tools,
      ...(providerOptions !== undefined ? { providerOptions } : {}),
      appliedMessageTransforms: messagesResult.appliedTransforms,
    }),
  };
  // prepare 可能改写 system/messages/tools，指纹必须基于最终输入重算。
  const prepared = await applyPrepareModelInput(input, run);
  if (prepared.diagnostics === undefined) {
    throw new Error('PrepareModelInput must preserve model input diagnostics.');
  }
  return {
    ...prepared,
    diagnostics: createModelInputDiagnostics({
      ...(prepared.system !== undefined ? { system: prepared.system } : {}),
      systemSections: prepared.diagnostics.systemSections,
      messages: prepared.messages,
      tools: prepared.tools,
      ...(prepared.providerOptions !== undefined
        ? { providerOptions: prepared.providerOptions }
        : {}),
      appliedMessageTransforms: prepared.diagnostics.appliedMessageTransforms,
    }),
  };
}

/**
 * 拼接 system 提示。
 *
 * 段落顺序为：内核指令 → 环境指令 → 配置注入的动态段落。
 * 环境指令通过统一的 `getInstructions(ctx)` 获取。所有非空段落以空行分隔
 * 拼接，并回报段落计数。
 */
async function buildSystem(
  run: RunSession,
): Promise<{ readonly system?: string; readonly sectionCount: number }> {
  const sections: string[] = [];
  if (run.config.instructions) {
    sections.push(run.config.instructions);
  }
  const environmentInstructions = await run.environment.getInstructions?.(
    run.ctx,
  );
  if (environmentInstructions) {
    sections.push(environmentInstructions);
  }
  // 配置注入的动态段落：逐个求值，跳过空串。
  for (const section of run.config.modelInput?.systemSections ?? []) {
    const text = await section(run.ctx);
    if (text) {
      sections.push(text);
    }
  }
  if (run.options.ephemeralInstructions) {
    sections.push(run.options.ephemeralInstructions);
  }
  return {
    ...(sections.length > 0 ? { system: sections.join('\n\n') } : {}),
    sectionCount: sections.length,
  };
}

/**
 * 跑完消息变换流水线，得到最终发给模型的消息序列。
 *
 * 以当前会话历史为初值，先依次应用默认变换（窗口裁剪、token 预算、
 * 工具对配对修复等），再应用用户在 `modelInput.messageTransforms`
 * 中注册的变换。同时记录每个变换的名字，供诊断回溯。
 */
async function buildFinalMessages(run: RunSession): Promise<{
  readonly messages: AgentMessage[];
  readonly appliedTransforms: readonly string[];
}> {
  let messages: readonly AgentMessage[] = [...run.state.messages];
  const appliedTransforms: string[] = [];
  // 默认变换：内核根据配置自动装配。
  for (const transform of defaultMessageTransforms(run)) {
    messages = await transform(messages, run.ctx);
    appliedTransforms.push(transform.name || 'default-message-transform');
  }
  // 用户自定义变换：在默认变换之后串行执行。
  for (const transform of run.config.modelInput?.messageTransforms ?? []) {
    messages = await transform(messages, run.ctx);
    appliedTransforms.push(transform.name || 'modelInput.messageTransform');
  }
  return { messages: [...messages], appliedTransforms };
}

/** 取本次回合可用的工具集。 */
function buildTools(run: RunSession): AgentToolSet {
  return run.tools;
}

/** 求值用户提供的 provider 透传选项（缺省或空值归一为 `undefined`）。 */
async function buildProviderOptions(
  run: RunSession,
): Promise<Record<string, unknown> | undefined> {
  const options = await run.config.modelInput?.providerOptions?.(run.ctx);
  return options ?? undefined;
}

/** 调用用户 `prepare` 钩子对成型输入做最终改写，未注册则原样返回。 */
async function applyPrepareModelInput(
  input: ModelInput,
  run: RunSession,
): Promise<ModelInput> {
  return (await run.config.modelInput?.prepare?.(input, run.ctx)) ?? input;
}

/**
 * 汇总本次输入的诊断信息。
 *
 * 估算 token 为消息正文与 system 文本之和（按字符数粗估）；
 * 同时记录段落数、消息数、是否带 providerOptions 与已应用的变换名。
 */
function createModelInputDiagnostics(options: {
  readonly system?: string;
  readonly systemSections: number;
  readonly messages: readonly AgentMessage[];
  readonly tools: AgentToolSet;
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
    systemFingerprint: fingerprintSystem(options.system, options.messages),
    toolsetFingerprint: fingerprintToolset(options.tools),
    messagePrefixFingerprint: fingerprintMessagePrefix(options.messages),
    compactionBoundary: hasCompactionBoundary(options.messages),
  };
}
