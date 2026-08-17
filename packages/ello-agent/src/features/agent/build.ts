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
import type { ModelCompactor } from './engine/index.js';

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
  modelCompactor?: ModelCompactor,
): Promise<BuiltAgent> {
  const definition = await dependencies.resolveDefinition(request);
  const model = await dependencies.resolveModel({ request, definition });
  const context = await dependencies.loadContext({
    request,
    definition,
    model,
  });
  const commands = await dependencies.createCommands({
    request,
    definition,
    context,
  });
  const environment = await dependencies.runtime.environments.attach(
    request.executionLocation,
    dependencies.runtime.environmentGrant,
  );
  let tracing;
  try {
    tracing = dependencies.runtime.createTracing({
      config: definition.config,
      threadId: request.threadId,
    });
  } catch (error) {
    await environment.close();
    throw error;
  }
  let engine: Agent;
  try {
    const compactor = dependencies.createCompactor({
      config: definition.config,
      contextWindow: model.contextWindow,
    });
    engine = createAgent({
      name: `ello-${definition.definition.name}`,
      model: model.model,
      modelCall: model.modelCall,
      modelAdapter: model.modelAdapter,
      modelSettings: model.modelSettings,
      ...(definition.definition.prompt === undefined
        ? {}
        : { instructions: definition.definition.prompt }),
      environment,
      commandRun: commands.commandRun,
      compactor,
      ...(modelCompactor === undefined ? {} : { modelCompactor }),
      ...(tracing.eventRecorder === undefined
        ? {}
        : { eventRecorder: tracing.eventRecorder }),
      modelInputBudget: model.modelInputBudget,
      modelInput: {
        systemSections: context.createSystemSections({
          ...(commands.memoryIndexLoader === undefined
            ? {}
            : { memoryIndexLoader: commands.memoryIndexLoader }),
          goalSystemSection: commands.goalSystemSection,
          ...(commands.taskNotificationSection === undefined
            ? {}
            : { taskNotificationSection: commands.taskNotificationSection }),
        }),
        providerOptions: model.providerOptions,
        prepare: model.prepareModelInput,
      },
      metadata: {
        threadId: request.threadId,
        cwd: request.executionLocation.workingDirectory,
        environmentRef: request.executionLocation.environmentRef,
        environmentGeneration: environment.generation,
      },
    });
  } catch (error) {
    try {
      await Promise.all([tracing.close(), environment.close()]);
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
    maxTurns: request.delegation?.maxTurns ?? definition.definition.maxTurns,
    ...(commands.waitForTaskNotification === undefined
      ? {}
      : { waitForTaskNotification: commands.waitForTaskNotification }),
    ...(commands.acknowledgeTaskNotifications === undefined
      ? {}
      : {
          acknowledgeTaskNotifications: commands.acknowledgeTaskNotifications,
        }),
    ...(commands.releaseTaskNotifications === undefined
      ? {}
      : { releaseTaskNotifications: commands.releaseTaskNotifications }),
    ...(commands.acknowledgeSystemTaskNotifications === undefined
      ? {}
      : {
          acknowledgeSystemTaskNotifications:
            commands.acknowledgeSystemTaskNotifications,
        }),
    ...(commands.releaseSystemTaskNotifications === undefined
      ? {}
      : {
          releaseSystemTaskNotifications:
            commands.releaseSystemTaskNotifications,
        }),
    modelCompactor: () => engine.modelCompactor(),
    setMode: commands.setMode,
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
