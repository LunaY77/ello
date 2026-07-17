import {
  createAgent,
  defineTool,
  type Agent,
  type AgentEnvironment,
  type AgentModel,
  type AgentRunResult,
  type AnyAgentTool,
  type ModelAdapter,
  type ModelInput,
  z,
} from '@ello/agent';

import type { CodingAgentConfig } from '../config/index.js';
import { renderPromptTemplate } from '../context/prompts.js';
import { createLangfuseEventRecorder } from '../observability/langfuse-recorder.js';
import type { LangfuseTracingRuntime } from '../observability/langfuse-runtime.js';
import type { PermissionRule } from '../permissions.js';
import {
  modelSettingsFromRole,
  prepareModelInputForRuntimeModel,
  providerOptionsForRole,
  type ProviderRegistry,
  type RuntimeRoleModel,
} from '../provider/index.js';
import { createCodingEventRecorder } from '../runtime/event-recorder.js';
import type { JsonlSessionStore } from '../session/jsonl-store.js';
import type { CodingStorage } from '../storage/index.js';
import type { TaskBoardScope } from '../tasks/index.js';
import { createCodingTools } from '../tools/index.js';
import {
  createMetaToolRuntime,
  TOOL_ROUTING_INSTRUCTIONS,
} from '../tools/meta-tools.js';

import type { CodingAgentDefinition } from './schema.js';

/** runner 解析模型与设置需要的依赖。 */
interface RunnerModelDeps {
  readonly config: CodingAgentConfig;
  readonly providerRegistry: ProviderRegistry;
  readonly modelAdapter?: ModelAdapter;
}

/**
 * 由定义解析运行时 role 绑定。
 *
 * 基线是 `resolveRole(active_profile, definition.role)`；当定义显式锁定
 * `modelRef` 时，覆盖 ref/model（设置仍沿用 role 的）。缺 role 直接抛错
 * （沿用 Phase 01 行为，不静默兜底）。
 */
function resolveBinding(
  def: CodingAgentDefinition,
  deps: RunnerModelDeps,
): RuntimeRoleModel {
  const base = deps.providerRegistry.resolveRole(
    deps.config.active_profile,
    def.role,
  );
  if (def.modelRef === undefined) {
    return base;
  }
  return {
    ...base,
    ref: def.modelRef,
    model: deps.providerRegistry.getModel(def.modelRef),
  };
}

/** 把 binding 解析成内核可用的 model（测试注入 adapter 时退化为 ref 字符串）。 */
function resolveAgentModel(
  binding: RuntimeRoleModel,
  deps: RunnerModelDeps,
): AgentModel {
  return deps.modelAdapter !== undefined
    ? binding.ref
    : deps.providerRegistry.resolveLanguageModel(binding.ref, binding.settings);
}

/**
 * 跑一次 internal agent（如 summarizer），返回最终文本。
 *
 * internal agent 只暴露 internal_complete：用定义里的 prompt 作系统指令、
 * 按 role 解析模型，跑一轮 `prompt` 即关闭。它让 coding-session 里压缩用的
 * 临时 `createAgent` 收敛进 registry。
 */
export async function runInternalAgent(input: {
  readonly definition: CodingAgentDefinition;
  readonly prompt: string;
  readonly config: CodingAgentConfig;
  readonly providerRegistry: ProviderRegistry;
  readonly modelAdapter?: ModelAdapter;
}): Promise<string> {
  const deps: RunnerModelDeps = {
    config: input.config,
    providerRegistry: input.providerRegistry,
    ...(input.modelAdapter !== undefined
      ? { modelAdapter: input.modelAdapter }
      : {}),
  };
  const binding = resolveBinding(input.definition, deps);
  assertToolCallSupport(binding);
  const internalTarget = defineTool({
    name: 'internal_complete',
    description: 'Return a completed internal-agent response payload.',
    discovery: { aliases: ['complete response'], risk: 'readonly' },
    input: z.object({ output: z.string() }).strict(),
    execute: ({ output }) => output,
  });
  const toolRuntime = createMetaToolRuntime(
    [internalTarget as AnyAgentTool],
    [],
    input.config.tools,
  );
  const agent = createAgent({
    name: `ello-${input.definition.name}`,
    model: resolveAgentModel(binding, deps),
    modelSettings: modelSettingsFromRole(binding),
    executionTools: toolRuntime.executionTools,
    modelTools: toolRuntime.modelTools,
    ...(input.definition.prompt !== undefined
      ? { instructions: input.definition.prompt }
      : {}),
    ...(input.modelAdapter !== undefined
      ? { modelAdapter: input.modelAdapter }
      : {
          modelInput: {
            providerOptions: () => providerOptionsForRole(binding),
            prepare: (modelInput: ModelInput) =>
              prepareModelInputForRuntimeModel(binding.model, modelInput, {
                promptProfile: `internal:${input.definition.name}`,
                cwdIdentity: input.config.cwd,
              }),
          },
        }),
  });
  try {
    const result = await agent.run(input.prompt);
    return result.output || result.text || '';
  } finally {
    await agent.close();
  }
}

/** 运行带严格工具白名单的 hidden internal agent。 */
export async function runInternalToolAgent(input: {
  readonly definition: CodingAgentDefinition;
  readonly instructions: string;
  readonly prompt: string;
  readonly tools: readonly AnyAgentTool[];
  readonly maxTurns: number;
  readonly config: CodingAgentConfig;
  readonly providerRegistry: ProviderRegistry;
  readonly modelAdapter?: ModelAdapter;
}): Promise<AgentRunResult> {
  const deps: RunnerModelDeps = {
    config: input.config,
    providerRegistry: input.providerRegistry,
    ...(input.modelAdapter !== undefined
      ? { modelAdapter: input.modelAdapter }
      : {}),
  };
  const binding = resolveBinding(input.definition, deps);
  assertToolCallSupport(binding);
  const toolRuntime = createMetaToolRuntime(
    input.tools,
    [],
    input.config.tools,
  );
  const agent = createAgent({
    name: `ello-${input.definition.name}`,
    model: resolveAgentModel(binding, deps),
    modelSettings: modelSettingsFromRole(binding),
    instructions: withToolRoutingInstructions(
      input.instructions,
      toolRuntime.usesToolRouting,
    ),
    executionTools: toolRuntime.executionTools,
    modelTools: toolRuntime.modelTools,
    ...(input.modelAdapter !== undefined
      ? { modelAdapter: input.modelAdapter }
      : {
          modelInput: {
            providerOptions: () => providerOptionsForRole(binding),
            prepare: (modelInput: ModelInput) =>
              prepareModelInputForRuntimeModel(binding.model, modelInput, {
                promptProfile: `internal:${input.definition.name}`,
                cwdIdentity: input.config.cwd,
              }),
          },
        }),
    metadata: { internal: true, agentName: input.definition.name },
  });
  try {
    return await agent.run(input.prompt, { maxTurns: input.maxTurns });
  } finally {
    await agent.close();
  }
}

/** 构建 subagent child Agent 需要的依赖。 */
export interface SubagentAgentDeps {
  readonly config: CodingAgentConfig;
  readonly providerRegistry: ProviderRegistry;
  /** child 复用父运行时的 JSONL 会话存储（child 落自己的文件）。 */
  readonly session: JsonlSessionStore;
  readonly storage: CodingStorage;
  readonly taskBoardScope: TaskBoardScope;
  /** child 复用父运行的环境（文件系统、shell）。 */
  readonly environment: AgentEnvironment;
  /** 已派生好的 child 权限规则（见 deriveSubagentPermission）。 */
  readonly permissionRules: readonly PermissionRule[];
  readonly tracing?: LangfuseTracingRuntime;
  readonly modelAdapter?: ModelAdapter;
}

/**
 * 由 subagent 定义构建一个 child `Agent`。
 *
 * - 模型经 `definition.role` 解析（可被 `modelRef` 覆盖）。
 * - 工具集从全量 coding tools 按 `definition.tools` 白名单裁剪；缺省=全量。
 *   coding tools 不含 `delegate_to_subagent`，所以 child 天然无法递归委派。
 * - 工具审批走会话模式派生规则与 child 权限规则。
 * - 系统指令 = 基础 coding system prompt 追加该 agent 的 prompt。
 */
export function createSubagentAgent(input: {
  readonly definition: CodingAgentDefinition;
  readonly deps: SubagentAgentDeps;
}): Agent {
  const { definition, deps } = input;
  const childConfig = deps.config;
  const binding = resolveBinding(definition, deps);
  assertToolCallSupport(binding);
  const tools = selectTools(
    createCodingTools({
      config: childConfig,
      storage: deps.storage,
      taskBoardScope: deps.taskBoardScope,
      rules: () => deps.permissionRules,
      mode: () => ({
        mode: childConfig.initialMode,
        previousMode: null,
        source: 'resume',
        changedAt: new Date(0).toISOString(),
      }),
    }),
    definition.tools,
  );
  const instructions =
    definition.prompt !== undefined
      ? `${renderPromptTemplate('subagent', { model: binding.ref })}\n\n${definition.prompt}`
      : renderPromptTemplate('subagent', { model: binding.ref });
  const toolRuntime = createMetaToolRuntime(tools, [], childConfig.tools);

  return createAgent({
    name: `ello-${definition.name}`,
    model: resolveAgentModel(binding, deps),
    modelSettings: modelSettingsFromRole(binding),
    instructions: withToolRoutingInstructions(
      instructions,
      toolRuntime.usesToolRouting,
    ),
    environment: sharedEnvironment(deps.environment),
    executionTools: toolRuntime.executionTools,
    modelTools: toolRuntime.modelTools,
    transcript: deps.session,
    eventRecorder: createCodingEventRecorder(
      deps.session.repository,
      deps.tracing === undefined
        ? undefined
        : createLangfuseEventRecorder({
            runtime: deps.tracing,
            agentKind: 'subagent',
          }),
    ),
    sessionWindow: { maxMessages: 200 },
    modelInputBudget: { maxInputTokens: 160_000, reservedOutputTokens: 8_000 },
    ...(deps.modelAdapter === undefined
      ? {
          modelInput: {
            providerOptions: () => providerOptionsForRole(binding),
            prepare: (input: ModelInput) =>
              prepareModelInputForRuntimeModel(binding.model, input, {
                promptProfile: 'subagent',
                cwdIdentity: deps.config.cwd,
              }),
          },
        }
      : { modelAdapter: deps.modelAdapter }),
    metadata: { agentName: definition.name },
  });
}

function assertToolCallSupport(binding: RuntimeRoleModel): void {
  if (!binding.model.capabilities.toolCall) {
    throw new Error(
      `Agent model '${binding.ref}' does not support tool calls.`,
    );
  }
}

function withToolRoutingInstructions(
  instructions: string,
  usesToolRouting: boolean,
): string {
  return usesToolRouting
    ? `${instructions}\n\n${TOOL_ROUTING_INSTRUCTIONS}`
    : instructions;
}

function sharedEnvironment(environment: AgentEnvironment): AgentEnvironment {
  return {
    ...environment,
    close: async () => {},
  };
}

/** 按名字白名单裁剪工具；缺省（undefined）= 全量。空数组 = 无工具。 */
function selectTools<T extends { readonly name: string }>(
  tools: readonly T[],
  whitelist: readonly string[] | undefined,
): T[] {
  if (whitelist === undefined) {
    return [...tools];
  }
  const wanted = new Set(whitelist);
  const selected = tools.filter((tool) => wanted.has(tool.name));
  const available = new Set(tools.map((tool) => tool.name));
  const missing = whitelist.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Unknown tool in agent definition: ${missing.join(', ')}`);
  }
  return selected;
}
