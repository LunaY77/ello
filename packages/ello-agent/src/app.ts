/**
 * 本文件负责 App Server 的唯一 composition root。
 *
 * 它创建 feature、数据库与传输资源，并按明确逆序关闭；业务状态仍由各 feature自己拥有。
 * 任一资源创建或释放失败都必须保留错误原因，不能通过空实现或默认容器继续运行。
 */
import { readFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';

import {
  defineDeferredTool,
  defineTool,
  dynamicSystemSection,
  skillIndexContext,
  z,
  type AnyAgentTool,
} from './features/agent/engine/index.js';
import {
  createAgentRegistry,
  createAgentTaskEventPreparer,
  createAgentRoutes,
  createAgentFeature,
  createCodingSystemPromptSection,
  createRequestUserInputTool,
  createSubagentTools,
  AgentTaskService,
  AgentTaskStore,
  AgentTaskRpcFeature,
  PLAN_EXIT_TOOL_NAME,
  type AgentFeature,
  type AgentTask,
  type CreateAgentTools,
  type AgentRuntime,
  type AgentRunRequest,
  type LoadAgentContext,
  type ResolveAgentDefinition,
  type ResolveAgentModel,
} from './features/agent/index.js';
import { createArtifactFeature } from './features/artifact/index.js';
import { ArtifactStore } from './features/artifact/index.js';
import { loadCodingAgentConfig } from './features/config/index.js';
import { createConfigFeature } from './features/config/index.js';
import { createFsFeature } from './features/fs/index.js';
import { McpManager } from './features/mcp/index.js';
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
  createActivateSkillTool,
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
  createMetaToolRuntime,
  createProductionToolRuntime,
  createToolFeature,
  markCoreTool,
  SessionFileStateRegistry,
  TOOL_ROUTING_INSTRUCTIONS,
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
  const mcp = new McpManager();
  const threadStore = createThreadStore({ root, database: database.db });
  const repositories = createRepositoryStore(database.db);
  const workspaceStore = createWorkspaceRecordStore(database.db);
  const artifacts = createArtifactFeature(artifactStore);
  const config = createConfigFeature();
  const models = createModelFeature();
  const tasks = createTaskFeature(taskBoards);
  const skills = createSkillFeature();
  const memory = createMemoryFeature();
  const tools = createToolFeature(taskBoards, {
    loadAdditionalTools: (toolConfig) => mcp.toolsForConfig(toolConfig),
  });
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
    createTools: createAgentTools(taskBoards, mcp, agentTasks),
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
      } satisfies AgentRunRequest;
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
        () => mcp.close(),
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
    cwd: request.cwd,
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
    contextWindow:
      modelInputBudget.maxInputTokens -
      (modelInputBudget.reservedOutputTokens ?? 0),
    providerOptions: () => providerOptionsFromRuntimeModel(model),
    prepareModelInput: (modelInput) =>
      Promise.resolve(
        prepareModelInputForRuntimeModel(model, modelInput, {
          promptProfile: definition.config.context.system_prompt_profile,
          cwdIdentity: definition.config.cwd,
        }),
      ),
  };
};

const loadAgentContext: LoadAgentContext = async ({ definition, model }) => {
  const catalog = new SkillCatalog(definition.config);
  const skills = await catalog.initialize();
  const activation = new SkillActivationService(catalog);
  const resolvedMemoryRoots = memoryRoots(definition.config);
  return {
    skills,
    activationTool: createActivateSkillTool({ service: activation }),
    readRoots: () => skills.flatMap((skill) => [skill.baseDir, skill.realPath]),
    createSystemSections: ({
      memoryIndexLoader,
      goalSystemSection,
      routingInstructions,
      taskNotificationSection,
    }) => [
      skillIndexContext({ skills, contextWindow: model.contextWindow }),
      createCodingSystemPromptSection(definition.config, {
        model: model.modelCall.configuredModel,
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
      ...(routingInstructions === undefined
        ? []
        : [dynamicSystemSection(() => routingInstructions)]),
      ...(taskNotificationSection === undefined
        ? []
        : [dynamicSystemSection(taskNotificationSection)]),
    ],
  };
};

function createAgentTools(
  taskBoards: TaskBoardStore,
  mcp: McpManager,
  agentTasks: AgentTaskService,
): CreateAgentTools {
  const fileStates = new SessionFileStateRegistry();
  return async ({ request, definition, context }) => {
    let modeState: SessionModeState = {
      mode: request.selection.mode,
      previousMode: null,
      source: 'resume',
      changedAt: new Date().toISOString(),
    };
    const currentMode = () => request.modeSource?.() ?? modeState.mode;
    const mcpTools = await mcp.toolsForConfig(definition.config);
    const productionTools = createProductionToolRuntime({
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
      ...(mcpTools.length === 0 ? {} : { additionalTools: mcpTools }),
    });
    const memory = createMemoryRunRuntime(
      definition.config,
      productionTools.approval,
    );
    if (memory.enabled) {
      await memory.initialize();
    }
    const availableTools = memory.enabled
      ? [...productionTools.tools, ...memory.tools]
      : productionTools.tools;
    const goalRuntime = createThreadGoalRuntime(request.goal);
    const baseDirectTools: AnyAgentTool[] = [
      context.activationTool,
      createRequestUserInputTool(),
      ...goalRuntime.tools,
    ].map(markCoreTool);
    if (request.selection.mode === 'plan') {
      baseDirectTools.push(...createPlanAgentTools(request));
    }
    const definitionWhitelist = definition.definition.tools;
    const initiallySelected = selectAgentTools(
      availableTools,
      request.delegation?.contextMode === 'fork'
        ? undefined
        : definitionWhitelist,
    );
    const parentToolNames = [
      ...initiallySelected.map((tool) => tool.name),
      ...baseDirectTools.map((tool) => tool.name),
      'delegate_to_subagent',
      'task_output',
      'task_stop',
    ];
    const subagentTools = createSubagentTools({
      request,
      definition,
      parentToolNames,
      service: agentTasks,
      approval: productionTools.approval,
    }).map(markCoreTool);
    const exactToolNames = request.delegation?.exactToolNames;
    const selected =
      exactToolNames === undefined
        ? initiallySelected
        : filterExactTools(availableTools, exactToolNames);
    const directTools =
      exactToolNames === undefined
        ? [...baseDirectTools, ...subagentTools]
        : filterExactTools(
            [...baseDirectTools, ...subagentTools],
            exactToolNames,
          );
    if (exactToolNames !== undefined) {
      assertExactTools(
        [...selected, ...directTools],
        exactToolNames,
        request.delegation?.taskId ?? request.threadId,
      );
    }
    const runtime = createMetaToolRuntime(
      selected,
      directTools,
      definition.config.tools,
    );
    return {
      executionTools: runtime.executionTools,
      modelTools: runtime.modelTools,
      ...(memory.enabled ? { memoryIndexLoader: memory.indexLoader } : {}),
      goalSystemSection: goalRuntime.systemSection,
      ...(runtime.usesToolRouting
        ? { routingInstructions: TOOL_ROUTING_INSTRUCTIONS }
        : {}),
      taskNotificationSection: () =>
        [
          productionTools.workflowInstructions(),
          agentTasks.takeNotifications(request.threadId),
        ]
          .filter(Boolean)
          .join('\n\n'),
      ...(request.delegation === undefined
        ? {
            waitForTaskNotification: (signal: AbortSignal) =>
              agentTasks.waitForNotification(request.threadId, signal),
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

function filterExactTools(
  tools: readonly AnyAgentTool[],
  exactToolNames: readonly string[],
): AnyAgentTool[] {
  const selected = new Set(exactToolNames);
  return tools.filter((tool) => selected.has(tool.name));
}

function assertExactTools(
  tools: readonly AnyAgentTool[],
  exactToolNames: readonly string[],
  taskId: string,
): void {
  const available = new Set(tools.map((tool) => tool.name));
  const missing = exactToolNames.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Fork task ${taskId} cannot restore exact tools: ${missing.join(', ')}`,
    );
  }
}

function createPlanAgentTools(
  request: Parameters<CreateAgentTools>[0]['request'],
): ReadonlyArray<AnyAgentTool> {
  return [
    markCoreTool(
      defineTool({
        name: 'write_plan',
        description: 'Persist the complete Markdown plan for this thread.',
        discovery: { aliases: ['save plan'], risk: 'workspace-write' },
        input: z
          .object({
            content: z.string().min(1).describe('Markdown plan content'),
          })
          .strict(),
        execute: async ({ content }) => {
          const artifact = await writePlanArtifact({
            cwd: request.cwd,
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
      }),
    ),
    markCoreTool(
      defineDeferredTool({
        name: PLAN_EXIT_TOOL_NAME,
        description: 'Request approval for the current persisted plan.',
        discovery: { aliases: ['approve plan'], risk: 'workspace-write' },
        input: z.object({}).strict(),
      }),
    ),
  ];
}

function selectAgentTools(
  tools: ReadonlyArray<AnyAgentTool>,
  whitelist: ReadonlyArray<string> | undefined,
): ReadonlyArray<AnyAgentTool> {
  if (whitelist === undefined) return tools;
  const available = new Set(tools.map((tool) => tool.name));
  const missing = whitelist.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Unknown tool in agent definition: ${missing.join(', ')}`);
  }
  const selected = new Set(whitelist);
  return tools.filter((tool) => selected.has(tool.name));
}

function agentTaskRunRequest(
  task: AgentTask,
  modeSource: () => AgentRunRequest['selection']['mode'],
): AgentRunRequest {
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
    history: task.sidechain,
    input: task.prompt,
    goal: null,
    permission: {
      rules: () => task.permissionRules,
      externalPaths: () => task.externalPaths,
    },
    delegation: {
      taskId: task.id,
      agentId: task.agentId,
      rootThreadId: task.rootThreadId,
      ...(task.parentTaskId === undefined
        ? {}
        : { parentTaskId: task.parentTaskId }),
      depth: task.depth,
      contextMode: task.contextMode,
      executionMode: task.executionMode,
      maxTurns: task.maxTurns,
      ...(task.modelSelector === undefined
        ? {}
        : { modelSelector: task.modelSelector }),
      ...(task.contextMode === 'fork'
        ? { exactToolNames: task.toolNames }
        : {}),
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
