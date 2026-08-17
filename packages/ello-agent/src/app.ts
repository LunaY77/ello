/**
 * 本文件负责 App Server 的唯一 composition root。
 *
 * 它创建 feature、数据库与传输资源，并按明确逆序关闭；业务状态仍由各 feature自己拥有。
 * 任一资源创建或释放失败都必须保留错误原因，不能通过空实现或默认容器继续运行。
 */
import { readFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';

import { z } from 'zod';

import {
  dynamicSystemSection,
  skillIndexContext,
} from './features/agent/engine/index.js';
import {
  createAgentRegistry,
  createAgentTaskEventPreparer,
  createAgentRoutes,
  createAgentFeature,
  createCodingSystemPromptSection,
  createRequestUserInputCommand,
  createSubagentCommands,
  renderTaskPacket,
  AgentTaskService,
  AgentTaskStore,
  AgentTaskRpcFeature,
  PLAN_EXIT_COMMAND_NAME,
  type AgentFeature,
  type AgentTask,
  type CreateAgentCommands,
  type AgentRuntime,
  type AgentRunRequest,
  type LoadAgentContext,
  type ResolveAgentDefinition,
  type ResolveAgentModel,
} from './features/agent/index.js';
import { createArtifactFeature } from './features/artifact/index.js';
import { ArtifactStore } from './features/artifact/index.js';
import {
  cliInput,
  commandInput,
  createCommandRegistrySnapshot,
  createCommandRunRuntime,
  deferred,
  defineCommand,
  defineCommandModule,
  type CommandDefinition,
  type CommandModule,
} from './features/command/index.js';
import { loadCodingAgentConfig } from './features/config/index.js';
import { createConfigFeature } from './features/config/index.js';
import { createFsFeature } from './features/fs/index.js';
import {
  createMemoryFeature,
  createMemoryRunRuntime,
  memoryRoots,
} from './features/memory/index.js';
import {
  createAiSdkModelAdapter,
  createModelRegistry,
  modelInputBudgetFromRuntimeModel,
  modelSettingsFromRuntimeModel,
  providerOptionsFromRuntimeModel,
  prepareModelInputForRuntimeModel,
} from './features/model/index.js';
import { createModelFeature } from './features/model/index.js';
import {
  createActivateSkillCommand,
  createSkillFeature,
  SkillActivationService,
  SkillCatalog,
} from './features/skill/index.js';
import {
  createTaskBoardStore,
  createTaskFeature,
  type TaskBoardStore,
} from './features/task/index.js';
import {
  createExportRoutes,
  compactionView,
  createProductionThreadCompactor,
  createThreadFeature,
  createThreadCompactor,
  createThreadGoalRuntime,
  createThreadRoutes,
  createThreadStore,
  createThreadTitleGenerator,
  type ThreadFeature,
  writePlanArtifact,
} from './features/thread/index.js';
import {
  createProductionCommandRuntime,
  createToolFeature,
  SessionFileStateRegistry,
  type SessionModeState,
} from './features/tool/index.js';
import {
  createRepositoryStore,
  createWorkspaceFeature,
  createWorkspaceRecordStore,
} from './features/workspace/index.js';
import { openDatabase } from './infra/database/index.js';
import { artifactsDir, elloHomeDir, stateDatabasePath } from './infra/paths.js';
import {
  AppServerError,
  type ParsedClientParams,
  type ThreadSnapshot,
} from './protocol/v1/index.js';
import type { RpcApplicationRouteTable } from './server/rpc/route.js';
import { AgentServer } from './server/server.js';

export interface CreateAppOptions {
  readonly root?: string;
  readonly stderr?: Writable;
  readonly transports: readonly ('stdio' | 'websocket' | 'unix')[];
  readonly agentRuntime: AgentRuntime;
}

/**
 * 构造 `app` 模块 中的 `createApp` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `options`: 仅作用于 `createApp` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - Promise 在 `app` 模块 的异步读取或状态变更完成后兑现为声明结果。
 *
 * Throws:
 * - 当 `app` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export async function createApp(
  options: CreateAppOptions,
): Promise<AgentServer> {
  const root = options.root ?? elloHomeDir();
  const database = openDatabase({ databasePath: stateDatabasePath(root) });
  const artifactStore = new ArtifactStore(database.db, artifactsDir(root));
  const taskBoards = createTaskBoardStore(database.db);
  const threadStore = createThreadStore({ root, database: database.db });
  const repositories = createRepositoryStore(database.db);
  const workspaceStore = createWorkspaceRecordStore(database.db);
  const artifacts = createArtifactFeature(artifactStore);
  const config = createConfigFeature();
  const models = createModelFeature();
  const tasks = createTaskFeature(taskBoards);
  const skills = createSkillFeature();
  const memory = createMemoryFeature();
  const tools = createToolFeature(taskBoards);
  const fs = createFsFeature(artifactStore);
  const workspaces = createWorkspaceFeature({
    repositories,
    workspaces: workspaceStore,
  });
  const agentHolder: { current?: AgentFeature } = {};
  const threadHolder: { current?: ThreadFeature } = {};
  const agentTasks = new AgentTaskService(
    new AgentTaskStore(database.db),
    (task) =>
      requireAgentFeature(agentHolder.current).startRun(
        agentTaskRunRequest(task, () =>
          requireThreadFeature(threadHolder.current).currentMode(
            task.rootThreadId,
          ),
        ),
      ),
    createAgentTaskEventPreparer(artifactStore),
  );
  const agent = createAgentFeature({
    resolveDefinition: resolveAgentDefinition,
    resolveModel: resolveAgentModel,
    loadContext: loadAgentContext,
    createCommands: createAgentCommands(taskBoards, agentTasks),
    createCompactor: (compactorOptions) =>
      createThreadCompactor(compactorOptions),
    runtime: options.agentRuntime,
  });
  agentHolder.current = agent;
  agentTasks.setNotifier((threadId, notificationId, message) =>
    requireAgentFeature(agentHolder.current).notify(
      threadId,
      notificationId,
      message,
    ),
  );
  const agentTaskRpc = new AgentTaskRpcFeature(agentTasks);
  const threads = createThreadFeature({
    store: threadStore,
    startAgentRun: agent.startRun,
    unloadGraceMs: 30_000,
    titleGenerator: createThreadTitleGenerator({
      modelAdapter: createAiSdkModelAdapter(),
      attachEnvironment: (workingDirectory) =>
        options.agentRuntime.environments.attach(
          {
            environmentRef: options.agentRuntime.defaultEnvironmentRef,
            workingDirectory,
          },
          options.agentRuntime.environmentGrant,
        ),
    }),
    beforeInterrupt: async (threadId, reason) => {
      requireAgentFeature(agentHolder.current).interrupt(threadId, reason);
      await agentTasks.stopRoot(threadId, reason);
      await requireThreadFeature(threadHolder.current).cancelAgentInteractions(
        threadId,
        undefined,
        reason,
      );
    },
    resolveInitialSettings,
    resolveSettingsUpdate,
  });
  threadHolder.current = threads;
  agentTasks.setInteractionHandler((task, interaction, run) =>
    threads.registerAgentInteraction(
      task.rootThreadId,
      task.id,
      task.startedAt ?? task.createdAt,
      interaction,
      run,
      {
        taskId: task.id,
        name: task.name ?? task.definitionName,
        definitionName: task.definitionName,
        description: task.description,
        cwd: task.cwd,
      },
    ),
  );
  agentTasks.setInteractionCanceller((threadId, taskIds, reason) =>
    threads.cancelAgentInteractions(threadId, taskIds, reason),
  );
  const compactionControllers = new Map<string, AbortController>();
  const compact = async (threadId: string) => {
    if (compactionControllers.has(threadId)) {
      throw new AppServerError({
        type: 'threadBusy',
        message: `Thread ${threadId} is already compacting.`,
      });
    }
    const controller = new AbortController();
    compactionControllers.set(threadId, controller);
    try {
      const snapshot = await threads.read({
        threadId,
        includeTurns: true,
        includeItems: true,
      });
      if (snapshot.thread.status === 'running') {
        throw new AppServerError({
          type: 'threadBusy',
          message: `Thread ${threadId} is running; interrupt it before compacting.`,
        });
      }
      const history = compactionView(
        await threadStore.read(threadId),
      ).projectedMessages;
      const lastTurnId = snapshot.turns.at(-1)?.id;
      const request = {
        threadId,
        turnId: lastTurnId ?? threadId,
        cwd: snapshot.thread.cwd,
        selection: snapshot.settings,
        history,
        input: '',
        goal:
          snapshot.goal === null
            ? null
            : {
                id: snapshot.goal.id,
                objective: snapshot.goal.objective,
                status: snapshot.goal.status,
                tokensUsed: snapshot.goal.tokensUsed,
                createdAt: snapshot.goal.createdAt,
                updatedAt: snapshot.goal.updatedAt,
                ...(snapshot.goal.tokenBudget === undefined
                  ? {}
                  : { tokenBudget: snapshot.goal.tokenBudget }),
              },
        permission: {
          rules: () => [],
          externalPaths: () => [],
        },
      } satisfies import('./features/agent/index.js').AgentRunInput;
      const compactor = await createProductionThreadCompactor({
        store: threadStore,
        snapshot,
        compact: (input) => agent.compact({ request, ...input }),
      });
      return await compactor.compactNow(threadId, {
        force: true,
        signal: controller.signal,
        ...(lastTurnId === undefined ? {} : { turnId: lastTurnId }),
      });
    } finally {
      if (compactionControllers.get(threadId) === controller) {
        compactionControllers.delete(threadId);
      }
    }
  };
  const routes = {
    ...config.routes,
    ...models.routes,
    ...createAgentRoutes(),
    ...agentTaskRpc.routes,
    ...tools.routes,
    ...skills.routes,
    ...memory.routes,
    ...tasks.routes,
    ...artifacts.routes,
    ...fs.routes,
    ...workspaces.routes,
    ...createThreadRoutes({
      artifacts: artifactStore,
      compact,
      interruptCompact: (threadId) => {
        compactionControllers
          .get(threadId)
          ?.abort('user interrupted context compaction');
      },
      threads,
    }),
    ...createExportRoutes({
      artifacts: artifactStore,
      store: threadStore,
      threads,
    }),
  } satisfies RpcApplicationRouteTable;

  return new AgentServer({
    version: await packageVersion(),
    transports: options.transports,
    routes,
    initialize: async () => {
      await artifacts.initialize();
      await threads.initialize();
      agentTasks.initialize();
    },
    releaseConnection: async (connectionId) => {
      await threads.releaseConnection(connectionId);
      fs.releaseConnection(connectionId);
      agentTaskRpc.releaseConnection(connectionId);
    },
    closeResources: () =>
      closeAppResources([
        () => threads.close(),
        () => {
          agentTaskRpc.close();
          return Promise.resolve();
        },
        () => agentTasks.close(),
        () => agent.close(),
        () => options.agentRuntime.environments.close(),
        () => fs.close(),
        () => artifacts.close(),
        () => {
          database.close();
          return Promise.resolve();
        },
      ]),
    ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
  });
}

const resolveAgentDefinition: ResolveAgentDefinition = async (request) => {
  const config = await loadCodingAgentConfig({
    cwd: request.executionLocation.workingDirectory,
    initial_mode: request.selection.mode,
  });
  const agentRegistry = await createAgentRegistry(config);
  const agentName =
    request.selection.agent === 'primary'
      ? config.default_agent
      : request.selection.agent;
  const definition = agentRegistry.get(agentName);
  if (request.delegation === undefined) {
    if (
      (definition.mode !== 'primary' && definition.mode !== 'all') ||
      definition.hidden === true
    ) {
      throw new Error(`Agent is not selectable as primary: ${agentName}`);
    }
  } else if (
    !agentRegistry
      .delegatable()
      .some((candidate) => candidate.name === definition.name)
  ) {
    throw new Error(`Agent is not delegatable: ${agentName}`);
  }
  return { config, definition, agentRegistry };
};

const resolveAgentModel: ResolveAgentModel = async ({
  request,
  definition,
}) => {
  const registry = createModelRegistry(definition.config);
  const selector =
    request.delegation?.modelSelector ?? definition.definition.model;
  const model = registry.resolveSelector(selector);
  const modelInputBudget = modelInputBudgetFromRuntimeModel(
    model,
    definition.config.context,
  );
  return {
    modelCall: {
      agentName: definition.definition.name,
      modelSelector: selector,
      configuredModel: model.name,
      protocol: model.protocol,
      apiModel: model.apiModel,
    },
    model: registry.resolveLanguageModel(model.name),
    modelAdapter: createAiSdkModelAdapter(),
    modelSettings: modelSettingsFromRuntimeModel(model),
    modelInputBudget,
    contextWindow: model.contextWindow,
    providerOptions: () => providerOptionsFromRuntimeModel(model),
    prepareModelInput: (modelInput) =>
      Promise.resolve(
        prepareModelInputForRuntimeModel(model, modelInput, {
          promptProfile: definition.config.context.prompt_mode,
          cwdIdentity: definition.config.cwd,
        }),
      ),
  };
};

const loadAgentContext: LoadAgentContext = async ({
  request,
  definition,
  model,
}) => {
  const catalog = new SkillCatalog(definition.config);
  const skills = await catalog.initialize();
  const activation = new SkillActivationService(catalog);
  const resolvedMemoryRoots = memoryRoots(definition.config);
  return {
    skills,
    activationCommand: createActivateSkillCommand({ service: activation }),
    readRoots: () => skills.flatMap((skill) => [skill.baseDir, skill.realPath]),
    createSystemSections: ({
      memoryIndexLoader,
      goalSystemSection,
      taskNotificationSection,
    }) => [
      skillIndexContext({ skills, contextWindow: model.contextWindow }),
      createCodingSystemPromptSection(definition.config, {
        model: model.modelCall.configuredModel,
        ...(definition.definition.mode === 'subagent' ||
        (definition.definition.mode === 'all' &&
          request.delegation !== undefined)
          ? { profile: 'subagent' }
          : {}),
        ...(memoryIndexLoader === undefined
          ? {}
          : {
              memory: {
                loader: memoryIndexLoader,
                roots: resolvedMemoryRoots,
              },
            }),
      }),
      dynamicSystemSection(goalSystemSection),
      ...(taskNotificationSection === undefined
        ? []
        : [dynamicSystemSection(taskNotificationSection)]),
    ],
  };
};

/** 创建生产 run 使用的 Command factory；CLI 诊断入口复用它读取模型可见定义。 */
export function createAgentCommands(
  taskBoards: TaskBoardStore,
  agentTasks: AgentTaskService,
): CreateAgentCommands {
  const fileStates = new SessionFileStateRegistry();
  return async ({ request, definition, context }) => {
    const isSubagent = request.delegation !== undefined;
    let modeState: SessionModeState = {
      mode: request.selection.mode,
      previousMode: null,
      source: 'resume',
      changedAt: new Date().toISOString(),
    };
    const currentMode = () => request.modeSource?.() ?? modeState.mode;
    const productionCommands = createProductionCommandRuntime({
      config: definition.config,
      taskBoards,
      taskBoardScope: {
        type: 'session',
        sessionId: request.threadId,
      },
      rules: () => request.permission.rules(),
      mode: () => ({ ...modeState, mode: currentMode() }),
      readRoots: context.readRoots,
      fileState: fileStates.forSession(request.threadId),
    });
    const memory = createMemoryRunRuntime(
      definition.config,
      productionCommands.approval,
    );
    if (memory.enabled) {
      await memory.initialize();
    }
    const availableModules = [
      productionCommands.module,
      ...(memory.enabled ? [memory.module] : []),
    ];
    const goalRuntime = createThreadGoalRuntime(
      isSubagent ? null : request.goal,
    );
    const baseModules: CommandModule[] = [
      defineCommandModule({
        id: 'skill',
        commands: [context.activationCommand],
      }),
      ...(isSubagent
        ? []
        : [
            defineCommandModule({
              id: 'user-input',
              commands: [createRequestUserInputCommand()],
            }),
            goalRuntime.module,
          ]),
    ];
    if (!isSubagent && request.selection.mode === 'plan') {
      baseModules.push(createPlanCommandModule(request));
    }
    const definitionWhitelist = definition.definition.commands;
    const selected = selectCommandModules(
      availableModules,
      definitionWhitelist,
    );
    const subagentModule = defineCommandModule({
      id: 'subagent',
      commands: createSubagentCommands({
        request,
        definition,
        service: agentTasks,
        approval: productionCommands.approval,
      }),
    });
    const commandRun = createCommandRunRuntime(
      createCommandRegistrySnapshot({
        modules: [...selected, ...baseModules, subagentModule],
        search: {
          resultLimit: definition.config.commands.search.result_limit,
          maxResultBytes: definition.config.commands.search.max_result_bytes,
        },
      }),
    );
    let systemNotification:
      | import('./features/agent/subagents/index.js').AgentTaskNotificationDelivery
      | undefined;
    const takeSystemNotification = () => {
      systemNotification ??= agentTasks.takeNotifications(request.threadId);
      return systemNotification?.text ?? '';
    };
    const acknowledgeSystemNotification = () => {
      if (systemNotification === undefined) return;
      agentTasks.acknowledgeNotifications(systemNotification.notificationIds);
      systemNotification = undefined;
    };
    const releaseSystemNotification = () => {
      if (systemNotification === undefined) return;
      agentTasks.releaseNotifications(systemNotification.notificationIds);
      systemNotification = undefined;
    };
    return {
      commandRun,
      ...(memory.enabled ? { memoryIndexLoader: memory.indexLoader } : {}),
      goalSystemSection: goalRuntime.systemSection,
      ...(isSubagent
        ? {}
        : { taskNotificationSection: takeSystemNotification }),
      ...(!isSubagent
        ? {
            waitForTaskNotification: (signal: AbortSignal) =>
              agentTasks.waitForNotification(request.threadId, signal),
            acknowledgeTaskNotifications: (ids: readonly string[]) =>
              agentTasks.acknowledgeNotifications(ids),
            releaseTaskNotifications: (ids: readonly string[]) =>
              agentTasks.releaseNotifications(ids),
            acknowledgeSystemTaskNotifications: acknowledgeSystemNotification,
            releaseSystemTaskNotifications: releaseSystemNotification,
          }
        : {}),
      mode: currentMode,
      setMode(mode) {
        modeState = {
          mode,
          previousMode: modeState.mode,
          source: 'plan-accept',
          changedAt: new Date().toISOString(),
        };
      },
    };
  };
}

function filterExactCommandModules(
  modules: readonly CommandModule[],
  exactCommandNames: readonly string[],
): CommandModule[] {
  const selected = new Set(exactCommandNames);
  return modules
    .map((module) =>
      defineCommandModule({
        id: module.id,
        commands: module.commands.filter((command) =>
          selected.has(command.name),
        ),
      }),
    )
    .filter((module) => module.commands.length > 0);
}

function createPlanCommandModule(
  request: Parameters<CreateAgentCommands>[0]['request'],
): CommandModule {
  const writePlanInput = z
    .object({
      content: z.string().min(1).describe('Complete Markdown plan content'),
    })
    .strict();
  const exitPlanInput = z.object({}).strict();
  return defineCommandModule({
    id: 'plan',
    commands: [
      defineCommand({
        name: 'write_plan',
        summary: 'Persist the complete Markdown plan for this thread.',
        aliases: ['save plan'],
        risk: 'workspace-write',
        invocation: cliInput(commandInput(writePlanInput), { body: 'content' }),
        execution: {
          kind: 'immediate',
          run: async ({ content }) => {
            const artifact = await writePlanArtifact({
              cwd: request.executionLocation.workingDirectory,
              sessionId: request.threadId,
              content,
            });
            return {
              kind: 'thread-plan-written' as const,
              plan: {
                threadId: request.threadId,
                status: 'draft' as const,
                contentHash: artifact.contentHash,
                content: artifact.content,
                path: artifact.path,
                updatedAt: new Date().toISOString(),
              },
            };
          },
        },
      }),
      defineCommand({
        name: PLAN_EXIT_COMMAND_NAME,
        summary: 'Request approval for the current persisted plan.',
        aliases: ['approve plan'],
        risk: 'workspace-write',
        invocation: cliInput(commandInput(exitPlanInput)),
        execution: deferred(),
      }),
    ],
  });
}

function selectCommandModules(
  modules: readonly CommandModule[],
  whitelist: ReadonlyArray<string> | undefined,
): readonly CommandModule[] {
  if (whitelist === undefined) return modules;
  const commands = commandDefinitions(modules);
  const available = new Set(commands.map((command) => command.name));
  const missing = whitelist.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Unknown Command in agent definition: ${missing.join(', ')}`,
    );
  }
  return filterExactCommandModules(modules, whitelist);
}

function commandDefinitions(
  modules: readonly CommandModule[],
): CommandDefinition[] {
  return modules.flatMap((module) => [...module.commands]);
}

function agentTaskRunRequest(
  task: AgentTask,
  modeSource: () => AgentRunRequest['selection']['mode'],
): import('./features/agent/index.js').AgentRunInput {
  const mode = modeSource();
  return {
    threadId: task.id,
    turnId: task.id,
    cwd: task.cwd,
    selection: {
      mode,
      agent: task.definitionName,
    },
    modeSource,
    history: [],
    input: renderTaskPacket(task.taskPacket),
    goal: null,
    permission: {
      rules: () => task.permissionRules,
      externalPaths: () => task.externalPaths,
    },
    delegation: {
      taskId: task.id,
      agentId: task.agentId,
      rootThreadId: task.rootThreadId,
      maxTurns: task.maxTurns,
      ...(task.modelSelector === undefined
        ? {}
        : { modelSelector: task.modelSelector }),
    },
  };
}

function requireThreadFeature(
  threads: ThreadFeature | undefined,
): ThreadFeature {
  if (threads === undefined) {
    throw new Error('Thread feature is not ready for subagent execution.');
  }
  return threads;
}

function requireAgentFeature(agent: AgentFeature | undefined): AgentFeature {
  if (agent === undefined) {
    throw new Error('Agent feature is not ready for subagent execution.');
  }
  return agent;
}

async function resolveInitialSettings(
  params: ParsedClientParams<'thread/start'>,
) {
  const config = await loadCodingAgentConfig({ cwd: params.cwd });
  const mode = params.mode ?? config.initial_mode;
  if (mode === 'bypass' && !config.bypass_enabled) {
    throw new AppServerError({
      type: 'permissionDenied',
      message: 'Bypass mode requires bypass_enabled: true.',
    });
  }
  return {
    mode,
    agent: params.agent ?? config.default_agent,
  };
}

async function resolveSettingsUpdate(
  snapshot: ThreadSnapshot,
  params: Omit<ParsedClientParams<'thread/settings/update'>, 'threadId'>,
) {
  const config = await loadCodingAgentConfig({ cwd: snapshot.thread.cwd });
  if (params.mode === 'bypass' && !config.bypass_enabled) {
    throw new AppServerError({
      type: 'permissionDenied',
      message: 'Bypass mode requires bypass_enabled: true.',
    });
  }
  return {
    ...(params.mode === undefined ? {} : { mode: params.mode }),
    ...(params.agent === undefined ? {} : { agent: params.agent }),
  };
}

async function closeAppResources(
  close: ReadonlyArray<() => Promise<void>>,
): Promise<void> {
  const failures: unknown[] = [];
  for (const closeResource of close) {
    try {
      await closeResource();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, 'App resource shutdown failed.');
  }
}

async function packageVersion(): Promise<string> {
  const packageJson: unknown = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (
    typeof packageJson !== 'object' ||
    packageJson === null ||
    !('version' in packageJson) ||
    typeof packageJson.version !== 'string' ||
    packageJson.version === ''
  ) {
    throw new Error('@ello/agent package.json has no version.');
  }
  return packageJson.version;
}
