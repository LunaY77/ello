/**
 * 本文件负责 agent feature 的“model-input”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { createHash } from 'node:crypto';

import type {
  AgentMessage,
  AgentProviderOptions,
  AgentToolSet,
  MessageTransform,
  ModelInput,
  ModelInputDiagnostics,
  SystemSection,
} from './model.js';
import type { RunState } from './run-state.js';
import type { AgentSkill } from './tools.js';

const DYNAMIC_OPEN = '<cache-dynamic>';
const DYNAMIC_CLOSE = '</cache-dynamic>';
const DYNAMIC_BLOCK = /<cache-dynamic>\n([\s\S]*?)\n<\/cache-dynamic>/gu;

export interface SystemCacheSegments {
  readonly stable: string;
  readonly dynamic: string;
}

/**
 * 把高变化 system section 标记为稳定前缀之后的动态后缀。
 *
 * Args:
 * - `section`: 运行时生成 system 文本的 section；其 `null` 语义保持不变。
 *
 * Returns:
 * - 返回包装后的 section；非空内容会带上唯一的动态 cache 标签。
 */
export function dynamicSystemSection(section: SystemSection): SystemSection {
  return async (run) => {
    const content = await section(run);
    return content === null || content === undefined || content === ''
      ? null
      : wrapDynamicSystemContent(content);
  };
}

/**
 * 将非空动态 system 文本包装为模型 provider 可识别的 cache 后缀。
 *
 * Args:
 * - `content`: 尚未包含 cache 保留标签的动态文本。
 *
 * Returns:
 * - 返回去除首尾空白并包裹动态标签的文本。
 *
 * Throws:
 * - 当内容为空或包含保留标签时抛错。
 */
export function wrapDynamicSystemContent(content: string): string {
  const normalized = content.trim();
  if (normalized === '') {
    throw new Error('Dynamic system content must not be empty.');
  }
  if (normalized.includes(DYNAMIC_OPEN) || normalized.includes(DYNAMIC_CLOSE)) {
    throw new Error('Dynamic system content contains a reserved cache tag.');
  }
  return `${DYNAMIC_OPEN}\n${normalized}\n${DYNAMIC_CLOSE}`;
}

/**
 * 解析稳定 system 前缀和连续动态 cache 块。
 *
 * Args:
 * - `system`: 完整 system 文本；动态块必须全部位于稳定文本之后。
 *
 * Returns:
 * - 返回稳定前缀与已去除标签的动态内容。
 *
 * Throws:
 * - 当动态块缺少捕获内容、稳定前缀为空或动态块之后出现稳定文本时抛错。
 */
export function splitSystemCacheSegments(system: string): SystemCacheSegments {
  const matches = [...system.matchAll(DYNAMIC_BLOCK)];
  const first = matches[0];
  if (first === undefined) {
    return { stable: system.trim(), dynamic: '' };
  }
  const firstIndex = first.index;
  if (firstIndex === undefined) {
    throw new Error('Dynamic system block is missing its source index.');
  }
  const stable = system.slice(0, firstIndex).trim();
  if (stable === '') {
    throw new Error('Stable system prefix must precede dynamic context.');
  }
  const dynamic: string[] = [];
  let cursor = firstIndex;
  for (const match of matches) {
    const index = match.index;
    const content = match[1];
    if (index === undefined || content === undefined) {
      throw new Error('Dynamic system block is incomplete.');
    }
    if (system.slice(cursor, index).trim() !== '') {
      throw new Error('Stable system content must not follow dynamic context.');
    }
    dynamic.push(content.trim());
    cursor = index + match[0].length;
  }
  if (system.slice(cursor).trim() !== '') {
    throw new Error('Stable system content must not follow dynamic context.');
  }
  return { stable, dynamic: dynamic.join('\n\n') };
}

/**
 * 合并已经解析的稳定前缀和动态后缀，不重新引入 cache 标签。
 *
 * Args:
 * - `segments`: provider transform 已验证的稳定与动态 system 分段。
 *
 * Returns:
 * - 返回稳定前缀，或以空行连接稳定前缀和非空动态后缀。
 */
export function joinSystemCacheSegments(segments: SystemCacheSegments): string {
  return segments.dynamic === ''
    ? segments.stable
    : `${segments.stable}\n\n${segments.dynamic}`;
}

/**
 * 生成稳定的 Skill 索引 system section。
 *
 * Args:
 * - `options.skills`: 当前运行可激活的 Skill 快照。
 * - `options.contextWindow`: 当前模型上下文窗口，单位为 token。
 *
 * Returns:
 * - 返回按上下文预算生成 Skill 索引的 system section。
 */
export function skillIndexContext(options: {
  readonly skills: ReadonlyArray<AgentSkill>;
  readonly contextWindow: number;
}): SystemSection {
  return () => {
    if (options.skills.length === 0) return null;
    const budget = Math.max(400, Math.floor(options.contextWindow * 4 * 0.01));
    const lines = ['<skills-context>'];
    for (const skill of options.skills) {
      const line = `- ${skill.name}: ${skill.description}`;
      lines.push(
        [...lines, line].join('\n').length > budget ? `- ${skill.name}` : line,
      );
    }
    lines.push(
      '</skills-context>',
      'Use activate_skill before responding when one of these skills applies.',
      'When the user starts a message with $<skill-name>, treat it as an explicit request to call activate_skill with that exact name and pass the remaining text as arguments.',
      'Do not read SKILL.md directly as a substitute for activation.',
      'Do not call a skill again when an activated_skill result for the same name already appears after the latest user message.',
    );
    return lines.join('\n');
  };
}

export interface TrimMessagesOptions {
  readonly maxMessages: number;
}

/**
 * 创建按消息数量裁剪并修复工具调用配对的 transform。
 *
 * Args:
 * - `options.maxMessages`: 最多保留的尾部消息数量。
 *
 * Returns:
 * - 返回不修改输入数组的消息 transform。
 */
export function trimMessages(options: TrimMessagesOptions): MessageTransform {
  if (!Number.isSafeInteger(options.maxMessages) || options.maxMessages < 1) {
    throw new Error('maxMessages must be a positive safe integer.');
  }
  return async (messages) =>
    preserveToolCallPairs(messages.slice(-options.maxMessages));
}

export interface CompactMessagesOptions {
  readonly maxInputTokens: number;
  readonly reservedOutputTokens?: number;
}

/**
 * 创建按 token 预算从头裁剪消息的 transform。
 *
 * Args:
 * - `options.maxInputTokens`: 模型输入上限，单位为 token。
 * - `options.reservedOutputTokens`: 为输出预留的 token 数。
 *
 * Returns:
 * - 返回保持工具调用/结果配对的消息 transform。
 */
export function compactMessages(
  options: CompactMessagesOptions,
): MessageTransform {
  if (
    !Number.isSafeInteger(options.maxInputTokens) ||
    options.maxInputTokens < 1
  ) {
    throw new Error('maxInputTokens must be a positive safe integer.');
  }
  const reserved = options.reservedOutputTokens ?? 0;
  if (
    !Number.isSafeInteger(reserved) ||
    reserved < 0 ||
    reserved >= options.maxInputTokens
  ) {
    throw new Error(
      'reservedOutputTokens must be a non-negative safe integer below maxInputTokens.',
    );
  }
  return async (messages) => applyTokenBudget(messages, options);
}

/**
 * 执行 产品 Agent Agent engine 模型输入 模块 定义的 `defaultMessageTransforms` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `run`: `defaultMessageTransforms` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 */
export function defaultMessageTransforms(run: RunState): MessageTransform[] {
  const transforms: MessageTransform[] = [];
  if (run.config.sessionWindow !== undefined) {
    transforms.push(trimMessages(run.config.sessionWindow));
  }
  if (run.config.modelInputBudget !== undefined) {
    transforms.push(compactMessages(run.config.modelInputBudget));
  }
  transforms.push(async (messages) => preserveToolCallPairs(messages));
  return transforms;
}

/**
 * 执行 产品 Agent Agent engine 模型输入 模块 定义的 `estimateMessagesTokens` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `estimateMessagesTokens` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function estimateMessagesTokens(
  messages: ReadonlyArray<AgentMessage>,
): number {
  return messages.reduce(
    (sum, message) => sum + estimateTextTokens(messageText(message)),
    0,
  );
}

/**
 * 执行 产品 Agent Agent engine 模型输入 模块 定义的 `estimateTextTokens` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `text`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
 *
 * Returns:
 * - 返回 `estimateTextTokens` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * 执行 产品 Agent Agent engine 模型输入 模块 定义的 `preserveToolCallPairs` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 */
export function preserveToolCallPairs(
  messages: ReadonlyArray<AgentMessage>,
): AgentMessage[] {
  const toolCallIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const id of readPartIds(message, 'tool-call')) toolCallIds.add(id);
    }
    if (message.role === 'tool') {
      for (const id of readPartIds(message, 'tool-result'))
        toolResultIds.add(id);
    }
  }
  return messages.filter((message) => {
    if (message.role === 'assistant') {
      const ids = readPartIds(message, 'tool-call');
      return ids.length === 0 || ids.some((id) => toolResultIds.has(id));
    }
    if (message.role === 'tool') {
      const ids = readPartIds(message, 'tool-result');
      return ids.length === 0 || ids.some((id) => toolCallIds.has(id));
    }
    return true;
  });
}

/**
 * 执行 产品 Agent Agent engine 模型输入 模块 定义的 `fingerprintSystem` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `system`: `fingerprintSystem` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `fingerprintSystem` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function fingerprintSystem(
  system: string | undefined,
  messages: ReadonlyArray<AgentMessage> = [],
): string {
  const leadingSystemMessages: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'system') break;
    leadingSystemMessages.push(message);
  }
  return sha256(stableJson({ system, leadingSystemMessages }));
}

/**
 * 执行 产品 Agent Agent engine 模型输入 模块 定义的 `fingerprintToolset` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `tools`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `fingerprintToolset` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function fingerprintToolset(tools: AgentToolSet): string {
  const definitions = Object.entries(tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: schemaJson(tool.inputSchema),
      providerOptions: tool.providerOptions,
    }));
  return sha256(stableJson(definitions));
}

/**
 * 执行 产品 Agent Agent engine 模型输入 模块 定义的 `fingerprintMessagePrefix` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回 `fingerprintMessagePrefix` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function fingerprintMessagePrefix(
  messages: ReadonlyArray<AgentMessage>,
): string {
  return sha256(stableJson(messages.slice(0, -1)));
}

/**
 * 执行 产品 Agent Agent engine 模型输入 模块 定义的 `hasCompactionBoundary` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
 */
export function hasCompactionBoundary(
  messages: ReadonlyArray<AgentMessage>,
): boolean {
  return messages.some((message) =>
    stableJson(message).includes('<compact-checkpoint>'),
  );
}

/**
 * 构建单轮模型输入 {@link ModelInput}。
 *
 * 把一次回合所需的全部输入装配到一起：
 * - system：拼接内核指令、环境指令与配置注入的 system 段落；
 * - messages：以当前会话历史为基，依次跑完默认与用户自定义的消息变换；
 * - tools / providerOptions：从 run 配置取出；
 * - diagnostics：记录段落数、消息数、估算 token、已应用的变换名等，便于排查。
 * 最后还会给用户一个 `prepare` 钩子，对成型的输入做最终改写。
 *
 * Args:
 * - `run`: `buildModelInput` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - Promise 在 产品 Agent Agent engine 模型输入 模块 的异步读取或状态变更完成后兑现为声明结果。
 *
 * Throws:
 * - 当 产品 Agent Agent engine 模型输入 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function buildModelInput(run: RunState): Promise<ModelInput> {
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
  run: RunState,
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
async function buildFinalMessages(run: RunState): Promise<{
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
function buildTools(run: RunState): AgentToolSet {
  return run.tools;
}

/** 求值 provider options resolver；未配置或显式返回空值时不附加 provider options。 */
async function buildProviderOptions(
  run: RunState,
): Promise<AgentProviderOptions | undefined> {
  const options = await run.config.modelInput?.providerOptions?.(run.ctx);
  return options === null ? undefined : options;
}

/** 调用用户 `prepare` 钩子对成型输入做最终改写，未注册则原样返回。 */
async function applyPrepareModelInput(
  input: ModelInput,
  run: RunState,
): Promise<ModelInput> {
  const prepare = run.config.modelInput?.prepare;
  if (prepare === undefined) {
    return input;
  }
  const prepared = await prepare(input, run.ctx);
  if (prepared === undefined || prepared === null) {
    throw new Error('PrepareModelInput must return a ModelInput object.');
  }
  return prepared;
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

function applyTokenBudget(
  messages: ReadonlyArray<AgentMessage>,
  options: CompactMessagesOptions,
): ReadonlyArray<AgentMessage> {
  const available = Math.max(
    0,
    options.maxInputTokens - (options.reservedOutputTokens ?? 0),
  );
  const kept = [...messages];
  while (kept.length > 0 && estimateMessagesTokens(kept) > available) {
    kept.shift();
  }
  return preserveToolCallPairs(kept);
}

function readPartIds(message: AgentMessage, type: string): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part) => {
    if (typeof part !== 'object' || part === null) return [];
    const toolCallId = Reflect.get(part, 'toolCallId');
    const toolInvocationId = Reflect.get(part, 'toolInvocationId');
    return Reflect.get(part, 'type') === type
      ? typeof toolCallId === 'string'
        ? [toolCallId]
        : typeof toolInvocationId === 'string'
          ? [toolInvocationId]
          : []
      : [];
  });
}

function messageText(message: AgentMessage): string {
  if (typeof message.content === 'string') return message.content;
  const serialized = JSON.stringify(message.content);
  if (serialized === undefined) {
    throw new Error(
      `Message content for role '${message.role}' is not serializable.`,
    );
  }
  return serialized;
}

function schemaJson(schema: unknown): unknown {
  if (
    typeof schema === 'object' &&
    schema !== null &&
    'toJSONSchema' in schema &&
    typeof schema.toJSONSchema === 'function'
  ) {
    return schema.toJSONSchema();
  }
  if (typeof schema === 'object' && schema !== null && 'jsonSchema' in schema) {
    return schema.jsonSchema;
  }
  throw new Error('Tool input schema does not expose JSON Schema.');
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(sortValue(value));
  if (serialized === undefined) {
    throw new Error('Model input fingerprint value is not JSON serializable.');
  }
  return serialized;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
