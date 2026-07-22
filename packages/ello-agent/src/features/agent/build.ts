/**
 * 产品 Agent 的单次运行装配顺序。
 *
 * 本文件只按 definition、model、context、tools、tracing、compactor 的显式依赖结果创建通用 engine；
 * 它不读取配置、注册 provider、创建业务工具或访问其他 feature 的实现。
 */
import type {
  AgentRunRequest,
  BuiltAgent,
  CreateAgentFeatureInput,
} from './contracts.js';
import { createAgent, type Agent } from './engine/index.js';
import { createRuntimeEnvironment } from './environment.js';

/**
 * 为一次 Thread turn 装配产品 Agent。
 *
 * Args:
 * - `request`: Thread 已投影并校验的稳定业务输入；history 的所有权仍属于 Thread。
 * - `dependencies`: 解析 definition/model、加载 context、创建 tools/tracing/compactor 的显式函数依赖。
 *
 * Returns:
 * - 返回尚未开始运行的 engine、最大 turn 数、动态模式更新函数和逆序资源释放函数。
 *
 * Throws:
 * - 当任一依赖无法解析完整运行配置、工具集合或模型能力时直接抛错；已创建 tracing 会被关闭。
 */
export async function buildAgent(
  request: AgentRunRequest,
  dependencies: CreateAgentFeatureInput,
): Promise<BuiltAgent> {
  const definition = await dependencies.resolveDefinition(request);
  const model = await dependencies.resolveModel({ request, definition });
  const context = await dependencies.loadContext({
    request,
    definition,
    model,
  });
  const tools = await dependencies.createTools({
    request,
    definition,
    context,
  });
  const tracing = dependencies.createTracing({
    config: definition.config,
    threadId: request.threadId,
  });
  let engine: Agent;
  try {
    const compactor = dependencies.createCompactor({
      config: definition.config,
      profileName: request.selection.profile,
      contextWindow: model.contextWindow,
      agentRegistry: definition.agentRegistry,
    });
    engine = createAgent({
      name: `ello-${definition.definition.name}`,
      model: model.model,
      modelAdapter: model.modelAdapter,
      modelSettings: model.modelSettings,
      ...(definition.definition.prompt === undefined
        ? {}
        : { instructions: definition.definition.prompt }),
      environment: createRuntimeEnvironment(
        definition.config,
        () => request.permission.rules(),
        () => request.permission.externalPaths(),
        context.readRoots,
      ),
      executionTools: tools.executionTools,
      modelTools: tools.modelTools,
      compactor,
      ...(tracing.eventRecorder === undefined
        ? {}
        : { eventRecorder: tracing.eventRecorder }),
      sessionWindow: { maxMessages: 200 },
      modelInputBudget: {
        maxInputTokens: definition.config.context.max_input_tokens,
        reservedOutputTokens: definition.config.context.reserved_output_tokens,
      },
      modelInput: {
        systemSections: context.createSystemSections({
          ...(tools.memoryIndexLoader === undefined
            ? {}
            : { memoryIndexLoader: tools.memoryIndexLoader }),
          goalSystemSection: tools.goalSystemSection,
          ...(tools.routingInstructions === undefined
            ? {}
            : { routingInstructions: tools.routingInstructions }),
        }),
        providerOptions: model.providerOptions,
        prepare: model.prepareModelInput,
      },
      metadata: { threadId: request.threadId, cwd: definition.config.cwd },
    });
  } catch (error) {
    try {
      await tracing.close();
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'Agent build and tracing shutdown both failed.',
        { cause: closeError },
      );
    }
    throw error;
  }
  return {
    engine,
    maxTurns: definition.definition.maxTurns,
    setMode: tools.setMode,
    close: () => closeBuiltAgent(engine, tracing.close),
  };
}

async function closeBuiltAgent(
  engine: Agent,
  closeTracing: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await engine.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await closeTracing();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Agent run resource shutdown failed.');
  }
}
