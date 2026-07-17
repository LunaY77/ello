import { exec } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  createAgent,
  createLocalShellEnvironment,
  createSkillTools,
  activeSkillsContext,
  skillIndexContext,
  type Agent,
  type AgentEnvironment,
  type AgentFileSystem,
  type AgentMessage,
  type AgentInput,
  type AgentModel,
  type AgentObserver,
  type AgentRunResult,
  type AgentShell,
  type AgentSkill,
  type AgentStream,
  type AgentStreamEvent,
  type AnyAgentTool,
  type DeferredApprovalItem,
  type DeferredToolCallItem,
  type ModelAdapter,
  type CompactionPort,
} from '@ello/agent';

import {
  BackgroundJobStore,
  createAgentRegistry,
  createDelegateTool,
  renderSubagentEnvelope,
  runInternalAgent,
  type AgentRegistry,
  type BackgroundJob,
  type CodingAgentDefinition,
} from '../agents/index.js';
import { CheckpointStore } from '../change/checkpoint.js';
import type { CodingAgentConfig, ProfileSuiteConfig } from '../config/index.js';
import { dynamicSystemSection } from '../context/cache-layout.js';
import {
  createCompactionPort,
  renderCompactConversation,
  serializeForCompact,
} from '../context/compactor.js';
import { createCodingSystemPromptSection } from '../context/prompts.js';
import {
  createToolResultBudget,
  type ToolResultBudget,
} from '../context/tool-result-budget.js';
import {
  createGoalSessionPort,
  createGoalSystemSection,
  createGoalTools,
  GoalService,
  type GoalState,
  type GoalStatusView,
} from '../goal/index.js';
import {
  MemoryJobCoordinator,
  createMemoryTools,
  type MemoryJob,
  type MemoryStatus,
} from '../memory/index.js';
import { createLangfuseEventRecorder } from '../observability/langfuse-recorder.js';
import {
  createLangfuseTracingRuntime,
  type LangfuseTracingRuntime,
} from '../observability/langfuse-runtime.js';
import { createCodingObserver } from '../observability/observer.js';
import { isPathInside, resolveAbsolute } from '../permission/engine.js';
import {
  genericApprovalFor,
  makeApprovalPolicy,
} from '../permission/policy.js';
import { RulesStore } from '../permission/rules-store.js';
import {
  createPlanTools,
  readPlanArtifact,
  writePlanArtifact,
  type PlanCommandResult,
  type PlanPreview,
  type PlanRecord,
  type PlanSlashCommand,
} from '../plan/index.js';
import {
  createProviderRegistry,
  modelSettingsFromRole,
  prepareModelInputForRuntimeModel,
  providerOptionsForRole,
  type ProviderRegistry,
  type RuntimeRoleModel,
} from '../provider/index.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import type {
  JsonlSessionSummary,
  SessionTreeView,
} from '../session/repository.js';
import { loadCodingSkills } from '../skills/index.js';
import { createCodingStorage, type CodingStorage } from '../storage/index.js';
import { createTaskService, type Task } from '../tasks/index.js';
import {
  projectApprovalItem,
  projectToolEvent,
} from '../tools/event-projection.js';
import { createCodingTools } from '../tools/index.js';
import {
  createMetaToolRuntime,
  TOOL_ROUTING_INSTRUCTIONS,
} from '../tools/meta-tools.js';
import {
  createRequestUserInputTool,
  recoverPendingUserInput,
  REQUEST_USER_INPUT_TOOL_NAME,
  UserInputRequestSchema,
  validateUserInputResolution,
  type PendingUserInput,
  type UserInputResolution,
} from '../user-input/index.js';
import { createBootProfile } from '../utils/boot-profile.js';

import {
  combineEventRecorders,
  createCodingEventRecorder,
} from './event-recorder.js';
import type {
  ApprovalDecision,
  CodingEventListener,
  CodingSessionEvent,
} from './intents.js';
import {
  cycleSessionMode,
  PlanModeError,
  type SessionMode,
  type SessionModeSource,
  type SessionModeState,
} from './session-mode.js';

/** 模型上下文窗口默认值，用于压缩触发判定。 */
const DEFAULT_CONTEXT_WINDOW = 160_000;
const execAsync = promisify(exec);

type PolicyFileSystem = AgentFileSystem & {
  resolvePath(targetPath: string): string;
  stat(targetPath: string): ReturnType<typeof stat>;
};

/**
 * 模型工具运行时环境。
 *
 * 文件系统和 shell 不使用静态 allowedPaths，而是在每次调用时读取 RulesStore 与
 * 本次 approve_once 产生的 sessionExternalPaths，确保 external_directory 审批
 * 与真实执行边界一致。
 */
function createRuntimeEnvironment(
  config: CodingAgentConfig,
  rules: () => readonly {
    permission: string;
    pattern: string;
    action: string;
  }[],
  sessionExternalPaths: () => readonly string[],
): AgentEnvironment {
  const environment = createLocalShellEnvironment({
    cwd: config.cwd,
    allowedPaths: [config.cwd],
  });
  const resolveAllowedPaths = () =>
    runtimeAllowedPaths(config.cwd, rules(), sessionExternalPaths());
  const fileSystem = createPolicyFileSystem(config.cwd, resolveAllowedPaths);
  const shell = createPolicyShell(config.cwd, resolveAllowedPaths);
  const resources = environment.resources;
  const wrapped: AgentEnvironment = {
    ...environment,
    ...(fileSystem !== undefined ? { fileSystem } : {}),
    ...(shell !== undefined ? { shell } : {}),
    ...(resources !== undefined ? { resources } : {}),
    getInstructions: () => null,
  };
  environment.resources?.bind?.(wrapped);
  return wrapped;
}

/** 当前 run 可访问的路径根：workspace + 本 session 临时授权 + 持久化 external_directory。 */
function runtimeAllowedPaths(
  cwd: string,
  rules: readonly { permission: string; pattern: string; action: string }[],
  sessionExternalPaths: readonly string[],
): readonly string[] {
  const roots = [cwd, ...sessionExternalPaths];
  for (const rule of rules) {
    if (rule.permission === 'external_directory' && rule.action === 'allow') {
      roots.push(resolveAbsolute(cwd, rule.pattern));
    }
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

/** 文件系统边界由 resolveAllowedTarget 统一校验，读写列目录共享同一判断。 */
function createPolicyFileSystem(
  cwd: string,
  allowedPaths: () => readonly string[],
): PolicyFileSystem {
  return {
    resolvePath(targetPath): string {
      return resolveAllowedTarget(cwd, targetPath, allowedPaths());
    },
    readText(targetPath): Promise<string> {
      return readFile(
        resolveAllowedTarget(cwd, targetPath, allowedPaths()),
        'utf8',
      );
    },
    async writeText(targetPath, content): Promise<void> {
      const resolved = resolveAllowedTarget(cwd, targetPath, allowedPaths());
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeFile(resolved, content, 'utf8');
    },
    async listDir(targetPath): Promise<string[]> {
      return (
        await readdir(resolveAllowedTarget(cwd, targetPath, allowedPaths()))
      ).sort();
    },
    async stat(targetPath) {
      return stat(resolveAllowedTarget(cwd, targetPath, allowedPaths()));
    },
  };
}

/** shell 只允许在已授权 cwd 内执行，命令文本本身由 bash permission 判定。 */
function createPolicyShell(
  cwd: string,
  allowedPaths: () => readonly string[],
): AgentShell {
  return {
    async run(command, options = {}) {
      const resolvedCwd = resolveAllowedTarget(
        cwd,
        options.cwd ?? cwd,
        allowedPaths(),
      );
      try {
        const result = await execAsync(command, {
          cwd: resolvedCwd,
          timeout: options.timeout,
          env:
            options.env === undefined
              ? process.env
              : { ...process.env, ...options.env },
        });
        return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
      } catch (error) {
        const err = error as NodeJS.ErrnoException & {
          readonly stdout?: string;
          readonly stderr?: string;
          readonly code?: number | string;
          readonly killed?: boolean;
        };
        return {
          exitCode: err.killed
            ? -1
            : typeof err.code === 'number'
              ? err.code
              : 1,
          stdout: err.stdout ?? '',
          stderr: err.killed ? 'timeout' : (err.stderr ?? err.message),
        };
      }
    },
  };
}

/** 相对路径基于 workspace cwd 解析；越界直接抛错，交给工具结果回灌模型。 */
function resolveAllowedTarget(
  cwd: string,
  target: string,
  allowedPaths: readonly string[],
): string {
  const resolved = resolveAbsolute(cwd, target);
  if (
    !allowedPaths.some((allowedPath) => isPathInside(allowedPath, resolved))
  ) {
    throw new Error(`Path not allowed: ${resolved}`);
  }
  return resolved;
}

/** TUI `!cmd` 是用户直接操作，仍使用显式配置的 allowedPaths。 */
function createSlashRuntimeEnvironment(
  config: CodingAgentConfig,
): AgentEnvironment {
  const environment = createLocalShellEnvironment({
    cwd: config.cwd,
    allowedPaths: config.allowedPaths,
  });
  return {
    ...environment,
    getInstructions: () => null,
  };
}

function isMissingSessionError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function cloneProfileConfig(profile: ProfileSuiteConfig): ProfileSuiteConfig {
  return structuredClone(profile) as ProfileSuiteConfig;
}

/** {@link createCodingSession} 的入参。 */
export interface CreateCodingSessionOptions {
  readonly config: CodingAgentConfig;
  readonly clientCapabilities: {
    readonly requestUserInput: boolean;
  };
  /** 测试可注入模型适配器，绕过真实 provider。 */
  readonly modelAdapter?: ModelAdapter;
}

/**
 * 两个前端共享的唯一会话运行时。
 *
 * 这是 coding-agent 里唯一调用 `@ello/agent` 的 `createAgent` 的地方：向上对前端
 * 暴露一组「意图」方法（submit/steer/approve/abort/会话切换），向下把
 * `AgentStreamEvent` 原样转发出去。不再有任何平行的事件存储/映射层——内核事件
 * 就是对外契约，产品事件只是其联合类型的扩展。
 */
export interface CodingSession {
  readonly sessionId: string;
  readonly cwd: string;
  /** 本会话的检查点存储，供 CLI/TUI 做 /undo 与改动视图。 */
  readonly checkpoints: CheckpointStore;

  subscribe(listener: CodingEventListener): () => void;
  submit(
    prompt: string,
    meta?: Record<string, unknown>,
  ): Promise<AgentRunResult>;
  steer(prompt: string): void;
  mode(): SessionModeState;
  cycleMode(direction: 'next' | 'previous'): Promise<SessionModeState>;
  setMode(
    mode: SessionMode,
    source: SessionModeSource,
  ): Promise<SessionModeState>;
  handlePlanCommand(command: PlanSlashCommand): Promise<PlanCommandResult>;
  previewPlan(): Promise<PlanPreview>;
  requestPlanExit(): Promise<void>;
  acceptPlan(
    requestId: string,
    contentHash: string,
  ): Promise<{ executionSessionId: string }>;
  chatAboutPlan(requestId: string, prompt: string): Promise<void>;
  denyPlan(requestId: string, reason: string | null): Promise<void>;
  clear(): Promise<void>;
  approve(requestId: string, decision: ApprovalDecision): Promise<void>;
  resolveUserInput(
    toolCallId: string,
    resolution: UserInputResolution,
  ): Promise<void>;
  pendingUserInput(): PendingUserInput | null;
  abort(reason?: string): void;
  createGoal(objective: string, tokenBudget?: number): Promise<GoalState>;
  pauseGoal(): Promise<GoalState>;
  resumeGoal(): Promise<GoalState>;
  clearGoal(): Promise<string>;
  goalStatus(): GoalStatusView | null;
  waitForGoalContinuation(): Promise<void>;
  notify(text: string): void;
  setProfile(profileName: string): Promise<string>;
  createProfile(profileName: string, sourceProfileName: string): Promise<void>;
  deleteProfile(profileName: string): Promise<void>;
  setPrimaryModel(modelReference: string): Promise<string>;
  setProfileRoleModel(
    profileName: string,
    role: RuntimeRoleModel['role'],
    modelReference: string,
  ): Promise<string>;
  runShell(command: string): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  setAgent(agentName: string): Promise<void>;
  listAgents(): readonly CodingAgentDefinition[];
  listSubagents(): readonly CodingAgentDefinition[];
  listBackgroundJobs(): readonly BackgroundJob[];
  listTasks(): readonly Task[];
  cancelBackgroundJob(id: string): void;
  sessionTree(): Promise<SessionTreeView>;
  listSessions(): Promise<readonly JsonlSessionSummary[]>;
  loadHistory(): Promise<void>;
  checkout(entryId: string | null): Promise<void>;
  rewind(entryId: string): Promise<string>;
  fork(reason?: string, targetEntryId?: string): Promise<string>;
  summarize(): Promise<string>;
  memoryStatus(): Promise<CodingMemoryStatus>;
  reloadMemory(): Promise<void>;
  dream(): Promise<MemoryJob>;
  exportSession(format?: 'jsonl' | 'html'): Promise<string>;
  newSession(): Promise<string>;
  resumeSession(idOrPath: string): Promise<void>;
  close(): Promise<void>;
}

export type CodingMemoryStatus =
  | MemoryStatus
  | {
      readonly enabled: false;
      readonly privateRoot: string;
      readonly teamRoot: string;
    };

/** 装配完成后注入 {@link CodingSessionImpl} 的依赖。 */
interface SessionDeps {
  readonly storage: CodingStorage;
  readonly sessionStore: JsonlSessionStore;
  readonly rulesStore: RulesStore;
  readonly registry: AgentRegistry;
  readonly backgroundJobs: BackgroundJobStore;
  readonly tracing?: LangfuseTracingRuntime;
  readonly memory?: MemoryJobCoordinator;
  readonly modelAdapter?: ModelAdapter;
  readonly clientCapabilities: CreateCodingSessionOptions['clientCapabilities'];
}

interface AgentRuntimeDeps {
  readonly agent: Agent;
  readonly compaction: CompactionPort;
  readonly skills: readonly AgentSkill[];
}

/**
 * 创建并初始化一个 {@link CodingSession}。
 *
 * 负责一次性把各模块产物（权限规则、上下文/记忆/压缩、会话存储、
 * 检查点、技能/子代理、可观测日志）装配进 `createAgent`。
 */
export async function createCodingSession(
  options: CreateCodingSessionOptions,
): Promise<CodingSession> {
  const { config } = options;
  const profile = createBootProfile('session');
  const sessionId = config.sessionId ?? randomUUID();
  const langfuse = config.observability?.langfuse;
  const tracing =
    langfuse?.enabled === true
      ? createLangfuseTracingRuntime({ sessionId, config: langfuse })
      : undefined;

  profile.mark('start');
  const storage = createCodingStorage();
  const sessionStore = new JsonlSessionStore({
    sessionDir: config.sessionDir,
    cwd: config.cwd,
    artifacts: storage.artifacts,
  });
  const rulesStore = new RulesStore(config.cwd);
  let session: CodingSessionImpl;
  try {
    await profile.measure('rules.load', () => rulesStore.load());
    const registry = await profile.measure('agents.registry', () =>
      createAgentRegistry(config),
    );
    const memory = config.context.memory.enabled
      ? new MemoryJobCoordinator({
          config,
          storage,
          sessionRepository: sessionStore.repository,
          registry,
          ...(options.modelAdapter !== undefined
            ? { modelAdapter: options.modelAdapter }
            : {}),
          emit: (event) => session.emit(event),
        })
      : undefined;
    session = new CodingSessionImpl(sessionId, config, {
      storage,
      sessionStore,
      rulesStore,
      registry,
      backgroundJobs: new BackgroundJobStore(),
      ...(tracing !== undefined ? { tracing } : {}),
      ...(memory !== undefined ? { memory } : {}),
      ...(options.modelAdapter !== undefined
        ? { modelAdapter: options.modelAdapter }
        : {}),
      clientCapabilities: options.clientCapabilities,
    });
    if (memory !== undefined) {
      await memory.start();
    }
  } catch (error) {
    await tracing?.shutdown();
    storage.close();
    throw error;
  }
  profile.mark('ready');
  await session.initialize();
  profile.flush();
  session.emit({ type: 'session.opened', sessionId, cwd: config.cwd });
  return session;
}

/** CodingSession 的具体实现。 */
class CodingSessionImpl implements CodingSession {
  readonly checkpoints: CheckpointStore;

  private runtime: AgentRuntimeDeps | undefined;
  private runtimeTask: Promise<AgentRuntimeDeps> | undefined;
  /** 当前激活技能名集合，被 skill 工具与 section 共享。 */
  private readonly activeSkills = new Set<string>();
  private readonly listeners = new Set<CodingEventListener>();
  private readonly approvalItems = new Map<string, DeferredApprovalItem>();
  private readonly approvalDecisions = new Map<string, ApprovalDecision>();
  private pendingUserInputItem: PendingUserInput | null = null;
  private userInputResolutionTask:
    | { readonly toolCallId: string; readonly task: Promise<void> }
    | undefined;
  private readonly sessionExternalPaths = new Set<string>();
  private readonly steerQueue: string[] = [];
  private readonly planAcceptances = new Map<
    string,
    Promise<{ readonly executionSessionId: string }>
  >();
  private pendingPlanApprovalEvent:
    | {
        readonly plan: Extract<PlanRecord, { status: 'awaiting-approval' }>;
        readonly preview: PlanPreview;
      }
    | undefined;
  private currentStream: AgentStream | undefined;
  private pendingRunMetadata: Record<string, unknown> | undefined;
  private continuationTask: Promise<void> | undefined;
  /** goal active 状态变化后延迟重建，避免当前工具调用关闭自己的 runtime。 */
  private runtimeInvalidated = false;
  private closing = false;
  private readonly goalService: GoalService;
  private config: CodingAgentConfig;
  private providerRegistry: ProviderRegistry;
  private primaryRole: RuntimeRoleModel;
  private readonly toolResultBudget: ToolResultBudget;
  private activeAgentName: string;
  private modeState: SessionModeState;

  constructor(
    public sessionId: string,
    config: CodingAgentConfig,
    private readonly deps: SessionDeps,
  ) {
    this.config = config;
    this.activeAgentName = config.default_agent;
    this.modeState = {
      mode: config.initialMode,
      previousMode: null,
      source: 'config',
      changedAt: new Date().toISOString(),
    };
    this.providerRegistry = createProviderRegistry(config);
    this.checkpoints = new CheckpointStore(this.deps.storage.checkpoints);
    this.primaryRole = this.resolveRuntimeRole('primary');
    this.toolResultBudget = createToolResultBudget({
      sessionStore: this.deps.sessionStore,
      artifacts: this.deps.storage.artifacts,
      sessionId: () => this.sessionId,
      config: config.context.tool_result_budget,
    });
    this.goalService = new GoalService({
      port: createGoalSessionPort({
        repository: this.deps.sessionStore.repository,
        sessionId: () => this.sessionId,
      }),
      maxContinuations: config.goal.max_continuations,
      onChanged: (goal, previous) => {
        this.emitGoalChanged(goal, previous);
        if (isActiveGoal(previous) !== isActiveGoal(goal)) {
          this.runtimeInvalidated = true;
        }
      },
      onCleared: (goalId) => {
        this.runtimeInvalidated = true;
        this.emit({ type: 'goal.cleared', goalId });
      },
    });
    this.deps.backgroundJobs.onSettled((job) =>
      this.injectBackgroundResult(job),
    );
  }

  get cwd(): string {
    return this.config.cwd;
  }

  async initialize(): Promise<void> {
    if (this.modeState.mode === 'bypass' && !this.config.bypassEnabled) {
      throw this.planError(
        'MODE_NOT_ALLOWED',
        'Initial bypass mode requires bypass_enabled.',
      );
    }
    const opened = await this.deps.sessionStore.repository.open(this.sessionId);
    const persisted = await this.deps.sessionStore.repository.latestModeState(
      this.sessionId,
    );
    if (persisted === null) {
      // 只有本次刚创建的空 session 可以写入配置初始模式；恢复会话绝不从配置猜测。
      if (opened.messages.length > 0 || this.config.sessionId !== null) {
        throw this.planError(
          'SESSION_PROTOCOL_INVALID',
          `Session ${this.sessionId} has no mode event.`,
        );
      }
      await this.deps.sessionStore.repository.appendModeState(
        this.sessionId,
        this.modeState,
      );
    } else {
      this.modeState = { ...persisted, source: 'resume' };
    }
    await this.goalService.load();
    this.setRecoveredUserInput(opened.messages);
  }

  subscribe(listener: CodingEventListener): () => void {
    this.listeners.add(listener);
    if (this.pendingUserInputItem !== null) {
      listener({
        type: 'user.input.requested',
        pending: this.pendingUserInputItem,
      });
    }
    return () => this.listeners.delete(listener);
  }

  /** 提交一次用户输入，消费整条 stream 直到 run 结束或被审批卡住。 */
  async submit(
    prompt: string,
    meta?: Record<string, unknown>,
  ): Promise<AgentRunResult> {
    if (this.pendingUserInputItem !== null) {
      throw new Error(
        `Cannot submit while user input ${this.pendingUserInputItem.toolCallId} is pending.`,
      );
    }
    // v1：把排队的 steer 输入并入本次提交（公共 API 暂无 run 内注入入口）。
    const drained = this.steerQueue.splice(0);
    const input =
      drained.length > 0 ? [...drained, prompt].join('\n\n') : prompt;
    const goal = this.goalService.active();
    const runMetadata =
      goal !== null && meta?.goalId === undefined
        ? { ...meta, goalId: goal.id, goalUserRun: true }
        : meta;
    const result = await this.runInput(input, runMetadata, prompt.slice(0, 80));
    this.scheduleGoalContinuation(result);
    return result;
  }

  /** 运行中追加输入（steer）：优先注入当前 stream 的下一回合。 */
  steer(prompt: string): void {
    if (this.currentStream !== undefined) {
      this.currentStream.steer({ role: 'user', content: prompt });
      return;
    }
    this.steerQueue.push(prompt);
  }

  mode(): SessionModeState {
    return this.modeState;
  }

  /** 快捷键只提交方向，实际循环顺序和 bypass 可用性由引擎决定。 */
  async cycleMode(direction: 'next' | 'previous'): Promise<SessionModeState> {
    return this.setMode(
      cycleSessionMode(
        this.modeState.mode,
        direction,
        this.config.bypassEnabled,
      ),
      'shortcut',
    );
  }

  async setMode(
    mode: SessionMode,
    source: SessionModeSource,
  ): Promise<SessionModeState> {
    // 运行中或存在工具审批时切模式会改变尚未执行工具的权限语义，因此直接拒绝。
    if (
      this.currentStream !== undefined ||
      this.approvalItems.size > 0 ||
      this.pendingUserInputItem !== null
    ) {
      throw this.planError(
        'MODE_CHANGE_WHILE_RUNNING',
        'Cannot change mode while a turn is running.',
      );
    }
    const plan = await this.deps.sessionStore.repository.latestPlanState(
      this.sessionId,
    );
    // Plan 审批属于显式用户决策点，不能靠切换模式隐式跳过。
    if (plan?.status === 'awaiting-approval') {
      throw this.planError(
        'MODE_CHANGE_WHILE_RUNNING',
        'Resolve the pending plan approval before changing mode.',
        plan.requestId,
      );
    }
    if (mode === 'bypass' && !this.config.bypassEnabled) {
      throw this.planError(
        'MODE_NOT_ALLOWED',
        'Bypass mode is disabled by bypass_enabled.',
      );
    }
    if (mode === this.modeState.mode) return this.modeState;
    const next: SessionModeState = {
      mode,
      previousMode: this.modeState.mode,
      source,
      changedAt: new Date().toISOString(),
    };
    await this.deps.sessionStore.repository.appendModeState(
      this.sessionId,
      next,
    );
    // 临时外部目录授权属于旧模式上下文；切换后必须清空并重建 agent/context。
    this.modeState = next;
    this.sessionExternalPaths.clear();
    await this.rebuild();
    this.emit({ type: 'session.mode.changed', state: next });
    return next;
  }

  async handlePlanCommand(
    command: PlanSlashCommand,
  ): Promise<PlanCommandResult> {
    // 保持命令分支穷举，新增 command kind 时 TypeScript 会迫使这里同步处理。
    switch (command.kind) {
      case 'without-input':
        if (this.modeState.mode !== 'plan') {
          throw this.planError('PLAN_TASK_REQUIRED', 'Usage: /plan <task>');
        }
        return { kind: 'previewed', preview: await this.previewPlan() };
      case 'with-input': {
        const prompt = command.input.trim();
        if (prompt.length === 0) {
          throw this.planError('PLAN_TASK_REQUIRED', 'Usage: /plan <task>');
        }
        if (this.modeState.mode !== 'plan') {
          const mode = await this.setMode('plan', 'slash-command');
          this.emit({ type: 'plan.input.submitted', prompt });
          const result = await this.submit(prompt, { source: 'slash-command' });
          return { kind: 'entered', mode, runId: result.id };
        }
        if (this.currentStream !== undefined) {
          this.emit({ type: 'plan.input.submitted', prompt });
          this.steer(prompt);
          return { kind: 'steered', runId: 'active' };
        }
        this.emit({ type: 'plan.input.submitted', prompt });
        const result = await this.submit(prompt, { source: 'slash-command' });
        return { kind: 'submitted', runId: result.id };
      }
    }
  }

  async previewPlan(): Promise<PlanPreview> {
    this.requirePlanMode();
    const plan = await this.requirePlan();
    const artifact = await readPlanArtifact(this.cwd, this.sessionId);
    // Preview 也校验 hash，避免 UI 展示事件流未记录的磁盘内容。
    if (artifact.contentHash !== plan.contentHash) {
      throw this.planError(
        'PLAN_HASH_MISMATCH',
        'Plan artifact does not match persisted state.',
      );
    }
    const preview = {
      sessionId: this.sessionId,
      ...artifact,
      status: plan.status,
    };
    await this.deps.sessionStore.repository.appendPlanPreviewed(
      this.sessionId,
      plan.contentHash,
    );
    this.emit({ type: 'plan.previewed', preview });
    return preview;
  }

  async requestPlanExit(): Promise<void> {
    this.requirePlanMode();
    const current = await this.requirePlan();
    if (
      current.status === 'awaiting-approval' ||
      current.status === 'accepted'
    ) {
      throw this.planError(
        'PLAN_STATE_INVALID',
        `Cannot request approval from ${current.status}.`,
      );
    }
    const artifact = await readPlanArtifact(this.cwd, this.sessionId);
    if (artifact.contentHash !== current.contentHash) {
      throw this.planError(
        'PLAN_HASH_MISMATCH',
        'Plan changed outside the plan writer.',
      );
    }
    const plan: PlanRecord = {
      status: 'awaiting-approval',
      sessionId: this.sessionId,
      contentHash: artifact.contentHash,
      requestId: randomUUID(),
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.deps.sessionStore.repository.appendPlanState(
      this.sessionId,
      'plan.approval.requested',
      plan,
    );
    const preview = {
      sessionId: this.sessionId,
      ...artifact,
      status: plan.status,
    };
    // 工具在模型 turn 内调用本方法；等 turn 收尾后再弹审批，防止用户过早 Accept
    // 导致旧 Plan stream 与新 Execution Session 同时写入运行时。
    if (this.currentStream === undefined) {
      this.emit({ type: 'plan.approval.requested', plan, preview });
    } else {
      this.pendingPlanApprovalEvent = { plan, preview };
    }
  }

  acceptPlan(
    requestId: string,
    contentHash: string,
  ): Promise<{ executionSessionId: string }> {
    // 同一个 requestId + hash 共用同一 Promise，双击和并发重试只创建一个新 session。
    const key = `${requestId}:${contentHash}`;
    const existing = this.planAcceptances.get(key);
    if (existing !== undefined) return existing;
    const acceptance = this.acceptPlanOnce(requestId, contentHash);
    this.planAcceptances.set(key, acceptance);
    // 可恢复错误不应永久污染幂等表；成功 Promise 则保留给后续重复请求复用。
    void acceptance.catch(() => {
      if (this.planAcceptances.get(key) === acceptance) {
        this.planAcceptances.delete(key);
      }
    });
    return acceptance;
  }

  private async acceptPlanOnce(
    requestId: string,
    contentHash: string,
  ): Promise<{ executionSessionId: string }> {
    this.requirePlanMode();
    if (this.currentStream !== undefined) {
      throw this.planError(
        'MODE_CHANGE_WHILE_RUNNING',
        'Cannot accept a plan while a turn is running.',
        requestId,
      );
    }
    const sourceSessionId = this.sessionId;
    const current = await this.requirePlan();
    // 已完成的 Accept 直接返回原 executionSessionId，不重复提交计划。
    if (current.status === 'accepted' && current.contentHash === contentHash) {
      return { executionSessionId: current.executionSessionId };
    }
    this.assertPlanRequest(current, requestId, contentHash);
    const artifact = await readPlanArtifact(this.cwd, sourceSessionId);
    if (artifact.contentHash !== contentHash) {
      throw this.planError(
        'PLAN_HASH_MISMATCH',
        'Accepted plan hash does not match the artifact.',
        requestId,
      );
    }
    const executionSessionId = randomUUID();
    const accepted: PlanRecord = {
      status: 'accepted',
      sessionId: sourceSessionId,
      contentHash,
      executionSessionId,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await this.deps.sessionStore.repository.appendPlanState(
      sourceSessionId,
      'plan.accepted',
      accepted,
    );
    this.emit({ type: 'plan.accepted', plan: accepted });

    // 执行必须发生在全新的 default session；原 Plan Session 保持只读、可恢复和可追溯。
    this.sessionId = executionSessionId;
    await this.deps.sessionStore.load(executionSessionId);
    this.modeState = {
      mode: 'default',
      previousMode: null,
      source: 'plan-accept',
      changedAt: new Date().toISOString(),
    };
    await this.deps.sessionStore.repository.appendModeState(
      executionSessionId,
      this.modeState,
    );
    await this.deps.sessionStore.repository.appendPlanExecutionStarted(
      executionSessionId,
      sourceSessionId,
      contentHash,
    );
    await this.goalService.load();
    await this.rebuild();
    this.emit({ type: 'session.switched', sessionId: executionSessionId });
    this.emit({ type: 'session.mode.changed', state: this.modeState });
    this.emit({
      type: 'plan.execution.started',
      executionSessionId,
      sourcePlanSessionId: sourceSessionId,
      sourcePlanHash: contentHash,
    });
    // 用户接受的是完整 Plan，因此不做截断，直接作为新会话首条 User Prompt 提交。
    await this.submit(artifact.content, {
      sourcePlanSessionId: sourceSessionId,
      sourcePlanHash: contentHash,
    });
    return { executionSessionId };
  }

  async chatAboutPlan(requestId: string, prompt: string): Promise<void> {
    this.requirePlanMode();
    const current = await this.requirePlan();
    this.assertPlanRequest(current, requestId, current.contentHash);
    if (prompt.trim().length === 0)
      throw this.planError(
        'PLAN_STATE_INVALID',
        'Chat prompt must not be empty.',
        requestId,
      );
    const draft: PlanRecord = {
      status: 'draft',
      sessionId: this.sessionId,
      contentHash: current.contentHash,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    // Chat 不创建执行会话；先退回 draft，再复用当前 Plan Session 的正常 submit 管道。
    await this.deps.sessionStore.repository.appendPlanState(
      this.sessionId,
      'plan.chat.requested',
      draft,
    );
    this.emit({ type: 'plan.chat.requested', plan: draft });
    await this.submit(prompt, { source: 'plan-chat' });
  }

  async denyPlan(requestId: string, reason: string | null): Promise<void> {
    this.requirePlanMode();
    const current = await this.requirePlan();
    this.assertPlanRequest(current, requestId, current.contentHash);
    const rejected: PlanRecord = {
      status: 'rejected',
      sessionId: this.sessionId,
      contentHash: current.contentHash,
      reason,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    // rejected 仍是可继续编辑的 Plan 状态，后续 write_plan 会生成新的 draft/hash。
    await this.deps.sessionStore.repository.appendPlanState(
      this.sessionId,
      'plan.rejected',
      rejected,
    );
    this.emit({ type: 'plan.rejected', plan: rejected });
  }

  /** 清空当前可见上下文并切到新会话。 */
  async clear(): Promise<void> {
    if (this.currentStream !== undefined) {
      this.abort('clear requested from TUI');
    }
    await this.newSession();
  }

  /** 收齐当前批次的审批决定后，一次性构造 DeferredRunResults 并恢复。 */
  async approve(requestId: string, decision: ApprovalDecision): Promise<void> {
    const item = this.approvalItems.get(requestId);
    if (item === undefined || this.approvalDecisions.has(requestId)) {
      throw new Error(`Unknown approval: ${requestId}`);
    }

    if (decision.action === 'always_allow') {
      await this.deps.rulesStore.addAllowRule(
        item,
        decision.scope ?? 'session',
      );
      this.addSessionExternalPaths(item);
    } else if (decision.action === 'approve_once') {
      this.addSessionExternalPaths(item);
    } else if (decision.action === 'deny') {
      await this.deps.rulesStore.addDenyRule(item, decision.scope ?? 'session');
    }

    this.approvalDecisions.set(requestId, decision);
    const next = this.nextPendingApproval();
    if (next !== undefined) {
      this.emitPendingApproval(next);
      return;
    }

    const deferred = [...this.approvalItems.values()];
    const approvals = Object.fromEntries(
      deferred.map((approvalItem) => {
        const approvalDecision = this.approvalDecisions.get(
          approvalItem.toolCallId,
        );
        if (approvalDecision === undefined) {
          throw new Error(
            `Approval batch is missing a decision for ${approvalItem.toolCallId}.`,
          );
        }
        return [
          approvalItem.toolCallId,
          {
            approved: approvalDecision.action !== 'deny',
            ...(approvalDecision.reason !== undefined
              ? { reason: approvalDecision.reason }
              : {}),
          },
        ];
      }),
    );
    this.approvalItems.clear();
    this.approvalDecisions.clear();

    const runtime = await this.ensureAgentRuntime();
    const runMetadata = this.pendingRunMetadata;
    const resumed = runtime.agent.resume(
      {
        deferred,
        approvals,
      },
      {
        sessionId: this.sessionId,
        maxTurns: this.activeAgentMaxTurns(),
        ...(runMetadata !== undefined ? { metadata: runMetadata } : {}),
      },
    );
    this.currentStream = resumed;
    let completed: AgentRunResult | undefined;
    try {
      const result = await driveRun({
        currentStream: this.currentStream,
        pendingApprovalCount: () => this.pendingApprovalCount(),
        pendingUserInputCount: () =>
          this.pendingUserInputItem === null ? 0 : 1,
        emit: (event) => this.emit(event),
        onEvent: (event) => this.forward(event),
        checkpoints: this.checkpoints,
      });
      completed = result;
      await this.recordGoalUsage(result, runMetadata);
      if ((result.pending?.length ?? 0) === 0) {
        this.pendingRunMetadata = undefined;
        await this.ensureSessionTitle(this.sessionId, result.messages);
        await this.maybeEnqueueMemoryExtraction(result, runMetadata);
      }
    } finally {
      this.currentStream = undefined;
      this.flushPlanApprovalEvent();
      await this.closeInvalidatedRuntime();
    }
    if (completed !== undefined) {
      this.scheduleGoalContinuation(completed);
    }
  }

  pendingUserInput(): PendingUserInput | null {
    return this.pendingUserInputItem;
  }

  resolveUserInput(
    toolCallId: string,
    resolution: UserInputResolution,
  ): Promise<void> {
    if (this.userInputResolutionTask?.toolCallId === toolCallId) {
      return this.userInputResolutionTask.task;
    }
    const task = this.resolveUserInputOnce(toolCallId, resolution);
    this.userInputResolutionTask = { toolCallId, task };
    const clearTask = () => {
      if (this.userInputResolutionTask?.task === task) {
        this.userInputResolutionTask = undefined;
      }
    };
    void task.then(clearTask, clearTask);
    return task;
  }

  private async resolveUserInputOnce(
    toolCallId: string,
    value: UserInputResolution,
  ): Promise<void> {
    const pending = this.pendingUserInputItem;
    if (pending === null || pending.toolCallId !== toolCallId) {
      throw new Error(`Unknown or stale user input request: ${toolCallId}`);
    }
    if (this.approvalItems.size > 0) {
      throw new Error('User input and approval cannot be pending together.');
    }
    const resolution = validateUserInputResolution(pending.request, value);
    const runMetadata = this.pendingRunMetadata;
    this.pendingUserInputItem = null;
    this.emit({ type: 'user.input.resolved', toolCallId, resolution });
    const deferred: DeferredToolCallItem = {
      kind: 'tool-call',
      toolCallId,
      toolName: REQUEST_USER_INPUT_TOOL_NAME,
      input: pending.request,
    };
    const runtime = await this.ensureAgentRuntime();
    const resumed = runtime.agent.resume(
      { deferred: [deferred], toolResults: { [toolCallId]: resolution } },
      {
        sessionId: this.sessionId,
        maxTurns: this.activeAgentMaxTurns(),
        ...(runMetadata !== undefined ? { metadata: runMetadata } : {}),
      },
    );
    this.currentStream = resumed;
    let completed: AgentRunResult | undefined;
    try {
      const result = await driveRun({
        currentStream: resumed,
        pendingApprovalCount: () => this.pendingApprovalCount(),
        pendingUserInputCount: () =>
          this.pendingUserInputItem === null ? 0 : 1,
        emit: (event) => this.emit(event),
        onEvent: (event) => this.forward(event),
        checkpoints: this.checkpoints,
      });
      completed = result;
      await this.recordGoalUsage(result, runMetadata);
      if ((result.pending?.length ?? 0) === 0) {
        this.pendingRunMetadata = undefined;
        await this.ensureSessionTitle(this.sessionId, result.messages);
        await this.maybeEnqueueMemoryExtraction(result, runMetadata);
      }
    } finally {
      this.currentStream = undefined;
      this.flushPlanApprovalEvent();
      await this.closeInvalidatedRuntime();
    }
    if (completed !== undefined) {
      this.scheduleGoalContinuation(completed);
    }
  }

  /** 中断当前 run。 */
  abort(reason?: string): void {
    this.currentStream?.abort(reason);
    this.emit({ type: 'ui.interrupted', reason: reason ?? 'interrupted' });
  }

  async createGoal(
    objective: string,
    tokenBudget?: number,
  ): Promise<GoalState> {
    if (this.currentStream !== undefined) {
      throw new Error('Cannot create a goal while another run is active.');
    }
    const goal = await this.goalService.create(objective, tokenBudget);
    await this.closeInvalidatedRuntime();
    await this.submit(goal.objective, {
      goalId: goal.id,
      goalInitial: true,
    });
    const current = this.goalService.current();
    if (current === null || current.id !== goal.id) {
      throw new Error(`Goal ${goal.id} disappeared during its initial run.`);
    }
    return current;
  }

  async pauseGoal(): Promise<GoalState> {
    const goal = await this.goalService.pause();
    this.currentStream?.abort('goal paused by user');
    await this.closeInvalidatedRuntime();
    this.notify(`Goal paused: ${goal.objective}`);
    return goal;
  }

  async resumeGoal(): Promise<GoalState> {
    const goal = await this.goalService.resume();
    await this.closeInvalidatedRuntime();
    this.notify(`Goal resumed: ${goal.objective}`);
    this.scheduleGoalContinuation();
    return goal;
  }

  async clearGoal(): Promise<string> {
    this.currentStream?.abort('goal cleared by user');
    const goalId = await this.goalService.clear();
    await this.closeInvalidatedRuntime();
    this.notify(`Goal cleared: ${goalId}`);
    return goalId;
  }

  goalStatus(): GoalStatusView | null {
    return this.goalService.status();
  }

  async waitForGoalContinuation(): Promise<void> {
    await this.continuationTask;
  }

  /** 给前端视图写入一条产品级消息。 */
  notify(text: string): void {
    this.emit({ type: 'ui.message', text });
  }

  /** 切换 profile suite 并重建 Agent，当前运行中不允许切换。 */
  async setProfile(profileName: string): Promise<string> {
    if (this.currentStream !== undefined) {
      throw new Error('Cannot change profile while running.');
    }
    this.providerRegistry.getProfile(profileName);
    this.config = {
      ...this.config,
      active_profile: profileName,
    };
    this.providerRegistry = createProviderRegistry(this.config);
    this.primaryRole = this.resolveRuntimeRole('primary');
    await this.rebuild();
    this.emit({ type: 'model.changed', model: this.primaryRole.ref });
    this.notify(`Profile switched to ${profileName} (${this.primaryRole.ref})`);
    return this.primaryRole.ref;
  }

  /** 基于已有 profile suite 创建新的 profile suite。 */
  async createProfile(
    profileName: string,
    sourceProfileName: string,
  ): Promise<void> {
    if (this.currentStream !== undefined) {
      throw new Error('Cannot create profile while running.');
    }
    if (this.config.profile[profileName] !== undefined) {
      throw new Error(`Profile already exists: ${profileName}`);
    }
    const source = this.config.profile[sourceProfileName];
    if (source === undefined) {
      throw new Error(`Unknown source profile: ${sourceProfileName}`);
    }
    this.config = {
      ...this.config,
      profile: {
        ...this.config.profile,
        [profileName]: cloneProfileConfig({
          ...source,
          label: profileName,
          description: `基于 ${sourceProfileName} 创建。`,
        }),
      },
    };
    this.providerRegistry = createProviderRegistry(this.config);
    this.notify(`Profile created: ${profileName}`);
  }

  /** 删除非当前 profile suite。 */
  async deleteProfile(profileName: string): Promise<void> {
    if (this.currentStream !== undefined) {
      throw new Error('Cannot delete profile while running.');
    }
    if (profileName === this.config.active_profile) {
      throw new Error(`Cannot delete active profile: ${profileName}`);
    }
    if (this.config.profile[profileName] === undefined) {
      throw new Error(`Unknown profile: ${profileName}`);
    }
    const profile = { ...this.config.profile };
    delete profile[profileName];
    if (Object.keys(profile).length === 0) {
      throw new Error('Cannot delete the final profile.');
    }
    this.config = {
      ...this.config,
      profile,
    };
    this.providerRegistry = createProviderRegistry(this.config);
    this.notify(`Profile deleted: ${profileName}`);
  }

  /** 切换当前 profile suite 的 primary 模型，其它 role 绑定保持不变。 */
  async setPrimaryModel(modelReference: string): Promise<string> {
    return this.setProfileRoleModel(
      this.config.active_profile,
      'primary',
      modelReference,
    );
  }

  /** 切换指定 profile suite 的 role 模型绑定。 */
  async setProfileRoleModel(
    profileName: string,
    role: RuntimeRoleModel['role'],
    modelReference: string,
  ): Promise<string> {
    if (this.currentStream !== undefined) {
      throw new Error('Cannot change model while running.');
    }
    const model = this.providerRegistry.getModel(modelReference);
    const profile = this.providerRegistry.getProfile(profileName);
    this.config = {
      ...this.config,
      profile: {
        ...this.config.profile,
        [profile.name]: {
          ...this.config.profile[profile.name]!,
          models: {
            ...profile.models,
            [role]: model.ref,
          },
        },
      },
    };
    this.providerRegistry = createProviderRegistry(this.config);
    this.primaryRole = this.resolveRuntimeRole('primary');
    await this.rebuild();
    this.emit({ type: 'model.changed', model: this.primaryRole.ref });
    this.notify(`Profile ${profileName} role ${role} bound to ${model.ref}`);
    return model.ref;
  }

  /** TUI `!cmd` shell escape：受同一 cwd/allowedPaths 边界约束。 */
  async runShell(command: string): Promise<{
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }> {
    if (this.modeState.mode === 'plan') {
      throw this.planError(
        'MODE_NOT_ALLOWED',
        'Shell escape is disabled in Plan mode.',
      );
    }
    const environment = createSlashRuntimeEnvironment(this.config);
    try {
      const result = await environment.shell?.run(command, {
        cwd: this.config.cwd,
        timeout: 30_000,
      });
      if (result === undefined) {
        throw new Error('Shell environment is not available.');
      }
      return result;
    } finally {
      await environment.close?.();
    }
  }

  /** 切换当前 primary agent 并重建运行时。 */
  async setAgent(agentName: string): Promise<void> {
    if (this.currentStream !== undefined) {
      throw new Error('Cannot change agent while running.');
    }
    const def = this.deps.registry.get(agentName);
    if ((def.mode !== 'primary' && def.mode !== 'all') || def.hidden === true) {
      throw new Error(`Agent is not selectable as primary: ${agentName}`);
    }
    this.activeAgentName = agentName;
    await this.rebuild();
    this.notify(`Switched to agent: ${agentName}`);
  }

  listAgents(): readonly CodingAgentDefinition[] {
    return this.deps.registry.selectablePrimaries();
  }

  listSubagents(): readonly CodingAgentDefinition[] {
    return this.deps.registry.delegatable();
  }

  listBackgroundJobs(): readonly BackgroundJob[] {
    return this.deps.backgroundJobs.list(this.sessionId);
  }

  listTasks(): readonly Task[] {
    return createTaskService(this.deps.storage.taskBoards, {
      type: 'session',
      sessionId: this.sessionId,
    }).list();
  }

  cancelBackgroundJob(id: string): void {
    this.deps.backgroundJobs.cancel(id);
  }

  /** 当前 session 的完整树视图。 */
  sessionTree(): Promise<SessionTreeView> {
    return this.deps.sessionStore.repository.tree(this.sessionId);
  }

  /** 列出可恢复的 session。 */
  listSessions(): Promise<readonly JsonlSessionSummary[]> {
    return this.deps.sessionStore.list();
  }

  /** 把当前 session 的 active path 历史推给前端。 */
  async loadHistory(): Promise<void> {
    await this.emitHistoryLoaded({ allowMissing: true });
    this.emit({ type: 'session.mode.changed', state: this.modeState });
    const goal = this.goalService.current();
    if (goal !== null) this.emit({ type: 'goal.updated', goal });
  }

  /** 切换当前 session 的 active leaf，后续 turn 从该节点继续。 */
  async checkout(entryId: string | null): Promise<void> {
    if (this.currentStream !== undefined) {
      this.abort('checkout requested from TUI');
    }
    await this.deps.sessionStore.checkout(this.sessionId, entryId);
    await this.rebuild();
    this.emit({ type: 'session.switched', sessionId: this.sessionId });
    await this.emitHistoryLoaded();
    this.notify(
      entryId === null
        ? 'Checked out session root.'
        : `Checked out ${entryId}.`,
    );
  }

  /** 回退到指定 user entry 之前，并把该 user 文本交给 TUI 回填输入框。 */
  async rewind(entryId: string): Promise<string> {
    if (this.currentStream !== undefined) {
      this.abort('rewind requested from TUI');
    }
    const target = await this.deps.sessionStore.repository.resolveMessageEntry(
      this.sessionId,
      entryId,
    );
    if (target.message.role !== 'user') {
      throw new Error(`Cannot rewind non-user entry: ${entryId}`);
    }
    const prompt = messageText(target.message);
    await this.deps.sessionStore.checkout(this.sessionId, target.parentId);
    await this.rebuild();
    this.emit({ type: 'session.switched', sessionId: this.sessionId });
    await this.emitHistoryLoaded();
    this.emit({
      type: 'session.rewound',
      sessionId: this.sessionId,
      entryId: target.id,
      prompt,
    });
    return prompt;
  }

  /** 从当前 active branch fork 出新 session，并立即切过去。 */
  async fork(
    reason = 'fork from TUI',
    targetEntryId?: string,
  ): Promise<string> {
    const sourceSessionId = this.sessionId;
    const sourceMode = this.modeState;
    const sourcePlan =
      await this.deps.sessionStore.repository.latestPlanState(sourceSessionId);
    const previousGoalId = this.goalService.current()?.id;
    if (this.currentStream !== undefined) {
      this.abort('fork requested from TUI');
    }
    const resolvedTarget =
      targetEntryId === undefined
        ? undefined
        : (
            await this.deps.sessionStore.repository.resolveMessageEntry(
              this.sessionId,
              targetEntryId,
            )
          ).id;
    const next = await this.deps.sessionStore.repository.fork(this.sessionId, {
      reason,
      ...(resolvedTarget !== undefined
        ? { targetEntryId: resolvedTarget }
        : {}),
    });
    this.sessionId = next.sessionId;
    await this.deps.sessionStore.load(this.sessionId);
    this.modeState = {
      mode: sourceMode.mode,
      previousMode: null,
      source: 'resume',
      changedAt: new Date().toISOString(),
    };
    await this.deps.sessionStore.repository.appendModeState(
      this.sessionId,
      this.modeState,
    );
    if (sourcePlan !== null) {
      const sourceArtifact = await readPlanArtifact(this.cwd, sourceSessionId);
      const copied = await writePlanArtifact({
        cwd: this.cwd,
        sessionId: this.sessionId,
        content: sourceArtifact.content,
      });
      const createdAt = new Date().toISOString();
      const forkedPlan: PlanRecord = {
        status: 'draft',
        sessionId: this.sessionId,
        contentHash: copied.contentHash,
        createdAt,
        updatedAt: createdAt,
      };
      await this.deps.sessionStore.repository.appendPlanState(
        this.sessionId,
        'plan.created',
        forkedPlan,
      );
    }
    await this.goalService.load();
    this.emitGoalSnapshot(previousGoalId);
    await this.rebuild();
    this.emit({ type: 'session.switched', sessionId: this.sessionId });
    await this.emitHistoryLoaded();
    this.notify(`Forked session ${this.sessionId}.`);
    return this.sessionId;
  }

  /** 生成给人看的手动会话摘要，旁路写入 session-summary，不进入模型上下文。 */
  async summarize(): Promise<string> {
    if (this.currentStream !== undefined) {
      throw new Error('Cannot summarize while running.');
    }
    const loaded = await this.deps.sessionStore.repository.load(this.sessionId);
    if (loaded.messages.length === 0) {
      throw new Error('Cannot summarize an empty session.');
    }
    const previous = await this.deps.sessionStore.latestSummary(this.sessionId);
    const summary = await this.generateSessionSummary(
      loaded.messages,
      previous?.summary,
    );
    await this.deps.sessionStore.appendSummary(this.sessionId, summary);
    this.emit({
      type: 'session.summary.created',
      sessionId: this.sessionId,
      summary,
    });
    return summary;
  }

  /** 导出当前 session。 */
  exportSession(format: 'jsonl' | 'html' = 'jsonl'): Promise<string> {
    return format === 'html'
      ? this.deps.sessionStore.repository.exportHtml(this.sessionId)
      : this.deps.sessionStore.repository.exportJsonl(this.sessionId);
  }

  /** 新建会话：换 sessionId 并重建 Agent。 */
  async newSession(): Promise<string> {
    const previousGoalId = this.goalService.current()?.id;
    this.sessionId = randomUUID();
    this.approvalItems.clear();
    this.approvalDecisions.clear();
    this.pendingRunMetadata = undefined;
    this.pendingUserInputItem = null;
    await this.deps.sessionStore.load(this.sessionId);
    this.modeState = {
      mode: this.config.initialMode,
      previousMode: null,
      source: 'config',
      changedAt: new Date().toISOString(),
    };
    await this.deps.sessionStore.repository.appendModeState(
      this.sessionId,
      this.modeState,
    );
    await this.goalService.load();
    if (previousGoalId !== undefined) {
      this.emit({ type: 'goal.cleared', goalId: previousGoalId });
    }
    await this.rebuild();
    this.emit({ type: 'session.switched', sessionId: this.sessionId });
    this.emit({ type: 'ui.clear' });
    return this.sessionId;
  }

  /** 恢复一个已有会话。 */
  async resumeSession(idOrPath: string): Promise<void> {
    // 支持传 id 或 .jsonl 路径；store 以 id 为键。
    const id = idOrPath.endsWith('.jsonl')
      ? idOrPath.replace(/.*\/(.+)\.jsonl$/u, '$1')
      : idOrPath;
    const previousGoalId = this.goalService.current()?.id;
    const loaded = await this.deps.sessionStore.repository.load(id);
    const persistedMode =
      await this.deps.sessionStore.repository.latestModeState(id);
    if (persistedMode === null) {
      throw this.planError(
        'SESSION_PROTOCOL_INVALID',
        `Session ${id} has no mode event.`,
      );
    }
    this.sessionId = id;
    this.modeState = { ...persistedMode, source: 'resume' };
    await this.deps.sessionStore.load(id);
    await this.goalService.load();
    this.emitGoalSnapshot(previousGoalId);
    await this.rebuild();
    this.emit({ type: 'session.switched', sessionId: this.sessionId });
    this.emit({ type: 'session.mode.changed', state: this.modeState });
    this.emitHistoryLoadedFromMessages(loaded.messages, loaded.messageEntryIds);
    this.setRecoveredUserInput(loaded.messages);
    this.scheduleGoalContinuation();
  }

  async close(): Promise<void> {
    this.closing = true;
    this.currentStream?.abort('coding session closed');
    await this.continuationTask;
    await this.deps.backgroundJobs.stopAll('coding session closed');
    await this.closeAgentRuntime();
    if (this.deps.memory !== undefined) {
      await this.deps.memory.close();
    }
    await this.deps.tracing?.shutdown();
    this.deps.storage.close();
  }

  async memoryStatus(): Promise<CodingMemoryStatus> {
    if (this.deps.memory === undefined) {
      return {
        enabled: false,
        privateRoot: this.config.context.memory.private_dir,
        teamRoot: this.config.context.memory.team_dir,
      };
    }
    return this.deps.memory.status();
  }

  async reloadMemory(): Promise<void> {
    const memory = this.requireMemory();
    memory.reload();
  }

  async dream(): Promise<MemoryJob> {
    return (await this.requireMemory().enqueueDream()).job;
  }

  /** 向所有订阅者广播一个事件。 */
  emit(event: CodingSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** 原样转发内核事件，并截获 approval 维护交互状态。 */
  private async forward(event: AgentStreamEvent): Promise<void> {
    if (event.type === 'approval.required') {
      this.approvalItems.set(event.item.toolCallId, event.item);
      this.emit(projectToolEvent(event));
      this.emitPendingApproval(event.item);
      return;
    }
    if (event.type === 'tool.deferred') {
      if (event.item.toolName !== REQUEST_USER_INPUT_TOOL_NAME) {
        throw new Error(`Unsupported deferred tool: ${event.item.toolName}`);
      }
      if (this.approvalItems.size > 0 || this.pendingUserInputItem !== null) {
        throw new Error(
          'A run produced conflicting pending interaction states.',
        );
      }
      const pending = {
        toolCallId: event.item.toolCallId,
        request: UserInputRequestSchema.parse(event.item.input),
      };
      this.pendingUserInputItem = pending;
      this.emit({ type: 'user.input.requested', pending });
      return;
    }
    this.emit(projectToolEvent(event));
  }

  private setRecoveredUserInput(messages: readonly AgentMessage[]): void {
    const pending = recoverPendingUserInput(messages, this.sessionId);
    if (pending !== null && this.approvalItems.size > 0) {
      throw new Error(
        `Session ${this.sessionId} has pending approval and user input ${pending.toolCallId}.`,
      );
    }
    this.pendingUserInputItem = pending;
    if (pending !== null && this.listeners.size > 0) {
      this.emit({ type: 'user.input.requested', pending });
      this.emit({ type: 'status', state: 'awaiting_user_input' });
    }
  }

  private pendingApprovalCount(): number {
    return this.approvalItems.size - this.approvalDecisions.size;
  }

  private nextPendingApproval(): DeferredApprovalItem | undefined {
    return [...this.approvalItems.values()].find(
      (item) => !this.approvalDecisions.has(item.toolCallId),
    );
  }

  private emitPendingApproval(item: DeferredApprovalItem): void {
    const projected = projectApprovalItem(item);
    this.emit({
      type: 'approval.pending',
      requestId: item.toolCallId,
      toolName: projected.toolName,
      input: projected.input,
      ...(projected.metadata !== undefined
        ? { metadata: projected.metadata }
        : {}),
    });
  }

  private async runInput(
    input: AgentInput,
    metadata?: Record<string, unknown>,
    checkpointLabel?: string,
  ): Promise<AgentRunResult> {
    if (this.currentStream !== undefined) {
      throw new Error('Cannot start a run while another run is active.');
    }
    const runtime = await this.ensureAgentRuntime();
    this.currentStream = runtime.agent.stream(input, {
      sessionId: this.sessionId,
      maxTurns: this.activeAgentMaxTurns(),
      ...(metadata !== undefined ? { metadata } : {}),
    });
    try {
      const result = await driveRun({
        currentStream: this.currentStream,
        pendingApprovalCount: () => this.pendingApprovalCount(),
        pendingUserInputCount: () =>
          this.pendingUserInputItem === null ? 0 : 1,
        emit: (event) => this.emit(event),
        onEvent: (event) => this.forward(event),
        checkpoints: this.checkpoints,
        ...(checkpointLabel !== undefined ? { checkpointLabel } : {}),
      });
      await this.recordGoalUsage(result, metadata);
      if ((result.pending?.length ?? 0) === 0) {
        this.pendingRunMetadata = undefined;
        await this.ensureSessionTitle(this.sessionId, result.messages);
        await this.maybeEnqueueMemoryExtraction(result, metadata);
      } else {
        this.pendingRunMetadata = metadata;
      }
      return result;
    } finally {
      this.currentStream = undefined;
      this.flushPlanApprovalEvent();
      await this.closeInvalidatedRuntime();
    }
  }

  private async recordGoalUsage(
    result: AgentRunResult,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const goalId = metadata?.goalId;
    if (typeof goalId !== 'string') return;
    const goal = await this.goalService.recordUsage(goalId, result.usage);
    if (goal?.status === 'paused') {
      if (goal.pauseReason === 'token_budget') {
        this.notify(
          `Goal paused: token budget exhausted (${goal.tokensUsed}/${goal.tokenBudget}).`,
        );
      } else if (goal.pauseReason === 'continuation_limit') {
        this.notify(
          `Goal paused: continuation limit reached (${goal.continuationTurns}/${this.config.goal.max_continuations}).`,
        );
      }
    } else if (goal?.status === 'complete' && goal.tokenBudget !== undefined) {
      this.notify(
        `Goal complete. Final token usage: ${goal.tokensUsed}/${goal.tokenBudget}.`,
      );
    }
  }

  private scheduleGoalContinuation(result?: AgentRunResult): void {
    if (result !== undefined && !canContinueAfter(result)) return;
    if (
      this.goalService.active() === null ||
      this.closing ||
      this.pendingApprovalCount() > 0 ||
      this.continuationTask !== undefined
    ) {
      return;
    }
    const task = this.runGoalContinuations();
    this.continuationTask = task;
    void task
      .catch((error) => {
        this.notify(
          `Goal continuation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        if (this.continuationTask === task) {
          this.continuationTask = undefined;
        }
      });
  }

  private async runGoalContinuations(): Promise<void> {
    while (!this.closing && this.goalService.active() !== null) {
      if (this.pendingApprovalCount() > 0 || this.currentStream !== undefined) {
        return;
      }
      const started = await this.goalService.beginContinuation();
      if (started.status === 'paused') {
        this.notify(
          `Goal paused: continuation limit reached (${started.continuationTurns}/${this.config.goal.max_continuations}).`,
        );
        return;
      }
      this.emit({ type: 'goal.continuation.started', goal: started });
      const result = await this.runInput(
        { messages: [] },
        {
          goalId: started.id,
          goalContinuation: true,
        },
      );
      const current = this.goalService.current();
      if (current !== null) {
        this.emit({ type: 'goal.continuation.completed', goal: current });
      }
      if (!canContinueAfter(result)) return;
    }
  }

  private emitGoalChanged(goal: GoalState, previous: GoalState | null): void {
    if (previous === null) {
      this.emit({ type: 'goal.created', goal });
      return;
    }
    if (goal.status !== previous.status) {
      if (goal.status === 'paused') {
        this.emit({ type: 'goal.paused', goal });
        return;
      }
      if (goal.status === 'complete') {
        this.emit({ type: 'goal.completed', goal });
        return;
      }
      if (goal.status === 'blocked') {
        this.emit({ type: 'goal.blocked', goal });
        return;
      }
    }
    this.emit({ type: 'goal.updated', goal });
  }

  private emitGoalSnapshot(previousGoalId?: string): void {
    const goal = this.goalService.current();
    if (goal !== null) {
      this.emit({ type: 'goal.updated', goal });
    } else if (previousGoalId !== undefined) {
      this.emit({ type: 'goal.cleared', goalId: previousGoalId });
    }
  }

  /** 大 tool 输出在下一次模型输入前替换成 artifact stub。 */
  private async maybeBudgetToolResult(
    toolCallId: string,
    output: unknown,
  ): Promise<void> {
    const text = extractToolOutputText(output);
    if (text === null) {
      return;
    }
    await this.toolResultBudget.maybeReplace(toolCallId, text);
  }

  /** 写类工具（输出带 structured file changes）的改动累积到检查点。 */
  private maybeRecordChange(toolCallId: string, output: unknown): void {
    if (typeof output !== 'object' || output === null) {
      return;
    }
    const metadata =
      (output as { metadata?: unknown }).metadata !== undefined
        ? (output as { metadata?: unknown }).metadata
        : output;
    if (typeof metadata !== 'object' || metadata === null) {
      return;
    }
    const fileChanges = (metadata as { fileChanges?: unknown }).fileChanges;
    if (!Array.isArray(fileChanges)) {
      return;
    }
    for (const change of fileChanges) {
      if (!isFileChangeRecord(change)) {
        throw new Error('Invalid file change metadata.');
      }
      this.checkpoints.record({
        path: change.path,
        diff: change.unifiedDiff,
        toolCallId,
        before: 'before' in change ? change.before : null,
        after: 'after' in change ? change.after : null,
      });
    }
  }

  /** 关闭当前 Agent，按当前 sessionId 重建。 */
  private async rebuild(): Promise<void> {
    await this.closeAgentRuntime();
    this.approvalItems.clear();
    this.approvalDecisions.clear();
    this.steerQueue.length = 0;
  }

  private requireMemory(): MemoryJobCoordinator {
    const memory = this.deps.memory;
    if (memory === undefined) {
      throw new Error(
        'Memory is disabled. Enable context.memory.enabled in config.yaml.',
      );
    }
    return memory;
  }

  private async maybeEnqueueMemoryExtraction(
    result: AgentRunResult,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const memory = this.deps.memory;
    if (
      memory === undefined ||
      !this.config.context.memory.extraction.enabled ||
      !isSuccessfulMemorySourceRun(result) ||
      isExcludedMemorySubmission(meta)
    ) {
      return;
    }
    const loaded = await this.deps.sessionStore.repository.load(this.sessionId);
    if (
      loaded.messages.length <
      this.config.context.memory.extraction.recent_messages
    ) {
      return;
    }
    if (loaded.leafEntryId === null) {
      throw new Error(
        `Session ${this.sessionId} has messages but no extraction leaf.`,
      );
    }
    await memory.enqueueExtraction({
      sessionId: this.sessionId,
      sourceLeafId: loaded.leafEntryId,
    });
  }

  private async ensureAgentRuntime(): Promise<AgentRuntimeDeps> {
    if (this.runtime !== undefined) {
      return this.runtime;
    }
    if (this.runtimeTask !== undefined) {
      return this.runtimeTask;
    }
    this.runtimeTask = this.createAgentRuntime();
    try {
      this.runtime = await this.runtimeTask;
      return this.runtime;
    } finally {
      this.runtimeTask = undefined;
    }
  }

  private async createAgentRuntime(): Promise<AgentRuntimeDeps> {
    const profile = createBootProfile('agent-runtime');
    const skills = await profile.measure('skills.load', () =>
      loadCodingSkills(this.config),
    );
    const compaction = createCompactionPort({
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      port: this.deps.sessionStore,
      generateCheckpoint: makeCompactCheckpointGenerator(
        this.config,
        this.deps.registry,
        this.deps.modelAdapter,
      ),
      settings: {
        enabled: this.config.context.compaction.auto,
        reserveTokens: this.config.context.compaction.reserved_tokens,
        keepRecentTokens: this.config.context.compaction.preserve_recent_tokens,
        tailTurns: this.config.context.compaction.tail_turns,
        splitTurns: this.config.context.compaction.split_turns,
        pruneToolOutput: this.config.context.compaction.prune_tool_output,
        toolOutputMaxChars:
          this.config.context.compaction.tool_output_max_chars,
      },
    });
    const runtime = {
      skills,
      compaction,
      agent: this.buildAgent({ compaction, skills }),
    };
    profile.mark('agent.build');
    profile.flush();
    return runtime;
  }

  private async closeAgentRuntime(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = undefined;
    this.runtimeTask = undefined;
    if (runtime !== undefined) {
      await runtime.agent.close();
    }
    this.runtimeInvalidated = false;
  }

  private async closeInvalidatedRuntime(): Promise<void> {
    if (!this.runtimeInvalidated || this.currentStream !== undefined) {
      return;
    }
    await this.closeAgentRuntime();
  }

  /** 后台 subagent 结束时把结果作为 parent 输入注入。 */
  private injectBackgroundResult(job: BackgroundJob): void {
    if (job.parentSessionId !== this.sessionId) {
      return;
    }
    const state = job.status === 'cancelled' ? 'cancelled' : job.status;
    const content = renderSubagentEnvelope({
      id: job.id,
      agent: job.agentName,
      state,
      summary: job.title,
      ...(job.output !== undefined ? { result: job.output } : {}),
      ...(job.error !== undefined ? { error: job.error } : {}),
    });
    if (this.currentStream !== undefined) {
      this.currentStream.steer({ role: 'user', content });
    } else {
      this.steerQueue.push(content);
    }
    this.emit({ type: 'subagent.background.completed', job });
  }

  /** 把各模块产物拼进 createAgent，这是整个会话运行时的核心装配。 */
  private buildAgent(runtime: {
    readonly compaction: CompactionPort;
    readonly skills: readonly AgentSkill[];
  }): Agent {
    const agentDef = this.deps.registry.get(this.activeAgentName);
    if (
      (agentDef.mode !== 'primary' && agentDef.mode !== 'all') ||
      agentDef.hidden === true
    ) {
      throw new Error(
        `Agent is not selectable as primary: ${this.activeAgentName}`,
      );
    }
    this.primaryRole = this.resolveRuntimeRole(agentDef.role);
    const primaryRole = this.primaryRole;
    if (!primaryRole.model.capabilities.toolCall) {
      throw new Error(
        `Coding agent model '${primaryRole.ref}' does not support tool calls.`,
      );
    }
    const config: CodingAgentConfig = {
      ...this.config,
      initialMode: this.modeState.mode,
    };
    const agentModel = this.resolveAgentModel(primaryRole);
    const observer = createCodingObserver(
      config,
      { model: primaryRole.ref },
      this.deps.storage.usage,
    );
    const runtimeObserver: AgentObserver = {
      onToolCompleted: async (call) => {
        this.maybeRecordChange(call.id, call.output);
        await this.maybeBudgetToolResult(call.id, call.output);
      },
    };
    const contentReplacementTransform = (messages: readonly AgentMessage[]) =>
      this.deps.sessionStore.applyContentReplacements(this.sessionId, messages);
    const decide = makeApprovalPolicy(
      config,
      () => this.deps.rulesStore.rules(),
      () => this.modeState,
    );

    const memory = this.deps.memory;
    const memoryTools =
      memory === undefined
        ? []
        : createMemoryTools({
            port: memory,
            approval: genericApprovalFor(decide),
            onMutation: (mutation) => {
              memory.reload();
              this.emit({
                type: 'memory.saved',
                scope: mutation.scope,
                file: mutation.file,
                operation: mutation.operation,
              });
            },
          });
    const codingTools = createCodingTools({
      config,
      storage: this.deps.storage,
      taskBoardScope: { type: 'session', sessionId: this.sessionId },
      rules: () => this.deps.rulesStore.rules(),
      decide,
      mode: () => this.modeState,
    });
    const selectedTools = [
      ...selectToolsForAgent(codingTools, agentDef.tools),
      ...(this.modeState.mode === 'plan' ? [] : memoryTools),
    ];
    // goal 工具只在 active 状态加入候选集合；超过直连上限后通过 tool_search/call_tool 暴露。
    const goalActive = this.goalService.active() !== null;
    const goalTools = goalActive ? createGoalTools(this.goalService) : [];
    const skillTools = createSkillTools({
      skills: runtime.skills,
      active: this.activeSkills,
    });
    const delegateTool = createDelegateTool({
      registry: this.deps.registry,
      config,
      providerRegistry: this.providerRegistry,
      session: this.deps.sessionStore,
      storage: this.deps.storage,
      parentSessionId: () => this.sessionId,
      rules: () => this.deps.rulesStore.rules(),
      mode: () => this.modeState,
      backgroundJobs: this.deps.backgroundJobs,
      ...(this.deps.tracing !== undefined
        ? { tracing: this.deps.tracing }
        : {}),
      hooks: {
        onEvent: (runId, event) =>
          this.emit({
            type: 'subagent.event',
            runId,
            event: projectToolEvent(event),
          }),
        onStarted: (info) => this.emit({ type: 'subagent.started', ...info }),
        onCompleted: (info) =>
          this.emit({ type: 'subagent.completed', ...info }),
        onFailed: (info) => this.emit({ type: 'subagent.failed', ...info }),
      },
      ...(this.deps.modelAdapter !== undefined
        ? { modelAdapter: this.deps.modelAdapter }
        : {}),
    });
    const targetTools = [
      ...selectedTools,
      ...(this.modeState.mode === 'plan' ? [] : goalTools),
      ...(this.modeState.mode === 'plan' ? [] : skillTools),
      delegateTool,
      ...(this.modeState.mode === 'plan'
        ? createPlanTools({
            write: (content) => this.writePlan(content),
            requestExit: async () => {
              await this.requestPlanExit();
              return 'Plan approval requested.';
            },
          })
        : []),
    ];
    const directTools =
      this.deps.clientCapabilities.requestUserInput &&
      !config.tools.disabled.includes(REQUEST_USER_INPUT_TOOL_NAME)
        ? [createRequestUserInputTool()]
        : [];
    const toolRuntime = createMetaToolRuntime(
      targetTools,
      directTools,
      config.tools,
    );

    const sections = [
      skillIndexContext({
        skills: runtime.skills,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
      }),
      createCodingSystemPromptSection(config, {
        model: primaryRole.ref,
        activeSkills: () => [...this.activeSkills],
        onContextEvent: (event) => this.emit(event),
        ...(this.deps.memory !== undefined
          ? { memoryIndexLoader: this.deps.memory.indexLoader }
          : {}),
      }),
      ...(toolRuntime.usesToolRouting
        ? [dynamicSystemSection(() => TOOL_ROUTING_INSTRUCTIONS)]
        : []),
      dynamicSystemSection(
        activeSkillsContext({
          skills: runtime.skills,
          active: this.activeSkills,
          activation: 'activated',
        }),
      ),
      ...(goalActive
        ? [dynamicSystemSection(createGoalSystemSection(this.goalService))]
        : []),
    ];

    return createAgent({
      name: `ello-${this.activeAgentName}`,
      model: agentModel,
      ...(agentDef.prompt !== undefined
        ? { instructions: agentDef.prompt }
        : {}),
      modelSettings: modelSettingsFromRole(primaryRole),
      environment: createRuntimeEnvironment(
        config,
        () => this.deps.rulesStore.rules(),
        () => [...this.sessionExternalPaths],
      ),
      executionTools: toolRuntime.executionTools,
      modelTools: toolRuntime.modelTools,
      transcript: this.deps.sessionStore,
      eventRecorder: createCodingEventRecorder(
        this.deps.sessionStore.repository,
        combineEventRecorders(
          observer,
          ...(this.deps.tracing === undefined
            ? []
            : [
                createLangfuseEventRecorder({
                  runtime: this.deps.tracing,
                  agentKind: 'primary',
                }),
              ]),
        ),
      ),
      compaction: runtime.compaction,
      observers: [runtimeObserver],
      sessionWindow: { maxMessages: 200 },
      modelInputBudget: {
        maxInputTokens: config.context.max_input_tokens,
        reservedOutputTokens: config.context.reserved_output_tokens,
      },
      modelInput: {
        systemSections: sections,
        messageTransforms: [contentReplacementTransform],
        providerOptions: () => providerOptionsForRole(primaryRole),
        prepare: (input) =>
          prepareModelInputForRuntimeModel(primaryRole.model, input, {
            promptProfile: config.context.system_prompt_profile,
            cwdIdentity: config.cwd,
          }),
      },
      ...(this.deps.modelAdapter !== undefined
        ? { modelAdapter: this.deps.modelAdapter }
        : {}),
      metadata: { sessionId: this.sessionId, cwd: config.cwd },
    });
  }

  private addSessionExternalPaths(item: DeferredApprovalItem): void {
    for (const target of readApprovalExternalDirs(item)) {
      this.sessionExternalPaths.add(resolveAbsolute(this.config.cwd, target));
    }
  }

  private async writePlan(content: string): Promise<string> {
    this.requirePlanMode();
    const current = await this.deps.sessionStore.repository.latestPlanState(
      this.sessionId,
    );
    if (
      current?.status === 'awaiting-approval' ||
      current?.status === 'accepted'
    ) {
      // 待审批版本必须冻结；先 Chat/Deny 回到可编辑状态才能产生新 hash。
      throw this.planError(
        'PLAN_STATE_INVALID',
        `Cannot update a ${current.status} plan.`,
      );
    }
    const artifact = await writePlanArtifact({
      cwd: this.cwd,
      sessionId: this.sessionId,
      content,
    });
    const now = new Date().toISOString();
    const plan: PlanRecord = {
      status: 'draft',
      sessionId: this.sessionId,
      contentHash: artifact.contentHash,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    // created/updated 由是否已有记录决定，正文始终只有一个 session artifact。
    await this.deps.sessionStore.repository.appendPlanState(
      this.sessionId,
      current === null ? 'plan.created' : 'plan.updated',
      plan,
    );
    this.emit({ type: 'plan.updated', plan, path: artifact.path });
    return `Plan written: ${artifact.path}\nsha256: ${artifact.contentHash}`;
  }

  private flushPlanApprovalEvent(): void {
    const pending = this.pendingPlanApprovalEvent;
    if (pending === undefined) return;
    this.pendingPlanApprovalEvent = undefined;
    this.emit({ type: 'plan.approval.requested', ...pending });
  }

  /** 内部工具和公共 API 共用同一模式守卫，防止从测试/RPC 绕过。 */
  private requirePlanMode(): void {
    if (this.modeState.mode !== 'plan') {
      throw this.planError(
        'PLAN_STATE_INVALID',
        'This operation requires Plan mode.',
      );
    }
  }

  private async requirePlan(): Promise<PlanRecord> {
    const plan = await this.deps.sessionStore.repository.latestPlanState(
      this.sessionId,
    );
    if (plan === null) {
      throw this.planError(
        'PLAN_NOT_FOUND',
        `No plan exists for session ${this.sessionId}.`,
      );
    }
    return plan;
  }

  /** 同时校验 requestId 与 hash：前者防重复界面，后者防接受过期正文。 */
  private assertPlanRequest(
    plan: PlanRecord,
    requestId: string,
    contentHash: string,
  ): asserts plan is Extract<PlanRecord, { status: 'awaiting-approval' }> {
    if (plan.status !== 'awaiting-approval' || plan.requestId !== requestId) {
      throw this.planError(
        'PLAN_REQUEST_STALE',
        'Plan approval request is stale.',
        requestId,
      );
    }
    if (plan.contentHash !== contentHash) {
      throw this.planError(
        'PLAN_HASH_MISMATCH',
        'Plan approval hash does not match.',
        requestId,
      );
    }
  }

  private planError(
    code: ConstructorParameters<typeof PlanModeError>[0]['code'],
    message: string,
    requestId?: string,
  ): PlanModeError {
    return new PlanModeError({
      code,
      message,
      sessionId: this.sessionId,
      state: this.modeState,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  private activeAgentMaxTurns(): number {
    return this.deps.registry.get(this.activeAgentName).maxTurns ?? 24;
  }

  private resolveRuntimeRole(role: RuntimeRoleModel['role']): RuntimeRoleModel {
    return this.providerRegistry.resolveRole(this.config.active_profile, role);
  }

  private resolveAgentModel(binding: RuntimeRoleModel): AgentModel {
    if (this.deps.modelAdapter !== undefined) {
      return binding.ref;
    }
    return this.providerRegistry.resolveLanguageModel(
      binding.ref,
      binding.settings,
    );
  }

  private async emitHistoryLoaded(
    options: {
      readonly allowMissing?: boolean;
    } = {},
  ): Promise<void> {
    try {
      const loaded = await this.deps.sessionStore.repository.load(
        this.sessionId,
      );
      this.emitHistoryLoadedFromMessages(
        loaded.messages,
        loaded.messageEntryIds,
      );
    } catch (error) {
      if (options.allowMissing === true && isMissingSessionError(error)) {
        return;
      }
      throw error;
    }
  }

  private emitHistoryLoadedFromMessages(
    messages: readonly AgentMessage[],
    entryIds?: readonly string[],
  ): void {
    this.emit({
      type: 'session.history.loaded',
      sessionId: this.sessionId,
      messages,
      ...(entryIds !== undefined ? { entryIds } : {}),
    });
  }

  private async ensureSessionTitle(
    sessionId: string,
    messages: readonly AgentMessage[],
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const existing = await this.deps.sessionStore.repository.title(sessionId);
    if (existing !== null) {
      return;
    }
    const result = await runInternalAgent({
      definition: this.deps.registry.get('title'),
      prompt: renderTitleConversation(messages),
      config: this.config,
      providerRegistry: this.providerRegistry,
      ...(this.deps.modelAdapter !== undefined
        ? { modelAdapter: this.deps.modelAdapter }
        : {}),
    });
    const title = normalizeGeneratedTitle(result);
    if (!title) {
      return;
    }
    await this.deps.sessionStore.repository.setTitle(sessionId, title);
    this.emit({ type: 'session.title.updated', sessionId, title });
  }

  private async generateSessionSummary(
    messages: readonly AgentMessage[],
    previousSummary?: string,
  ): Promise<string> {
    const result = await runInternalAgent({
      definition: this.deps.registry.get('summary'),
      prompt: renderSummaryInput(messages, previousSummary, this.config),
      config: this.config,
      providerRegistry: this.providerRegistry,
      ...(this.deps.modelAdapter !== undefined
        ? { modelAdapter: this.deps.modelAdapter }
        : {}),
    });
    const summary = result.trim();
    if (summary === '') {
      throw new Error('Session summary model returned empty output.');
    }
    return summary;
  }
}

function readApprovalExternalDirs(
  item: DeferredApprovalItem,
): readonly string[] {
  const metadata = item.metadata;
  // approve_once 不落盘，只把审批事件携带的外部目录加入当前会话运行边界。
  if (metadata === undefined || metadata.externalDirs === undefined) {
    return [];
  }
  if (
    !Array.isArray(metadata.externalDirs) ||
    metadata.externalDirs.some((entry) => typeof entry !== 'string')
  ) {
    throw new Error(
      `Approval item for ${item.toolName} has invalid externalDirs metadata.`,
    );
  }
  return metadata.externalDirs;
}

function messageText(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === 'string' ? content : JSON.stringify(content);
}

function extractToolOutputText(output: unknown): string | null {
  if (typeof output === 'string') {
    return output;
  }
  if (typeof output !== 'object' || output === null) {
    return null;
  }
  const record = output as { output?: unknown };
  if (typeof record.output === 'string') {
    return record.output;
  }
  return JSON.stringify(output);
}

function isFileChangeRecord(value: unknown): value is {
  readonly path: string;
  readonly unifiedDiff: string;
  readonly before?: string;
  readonly after?: string;
} {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as {
    path?: unknown;
    unifiedDiff?: unknown;
    before?: unknown;
    after?: unknown;
  };
  return (
    typeof record.path === 'string' &&
    typeof record.unifiedDiff === 'string' &&
    (record.before === undefined || typeof record.before === 'string') &&
    (record.after === undefined || typeof record.after === 'string')
  );
}

function renderSummaryInput(
  messages: readonly AgentMessage[],
  previousSummary: string | undefined,
  config: CodingAgentConfig,
): string {
  const compacted = serializeForCompact(messages, {
    pruneToolOutput: true,
    toolOutputMaxChars: config.context.compaction.tool_output_max_chars,
  });
  const conversation = renderCompactConversation(compacted);
  const seed =
    previousSummary !== undefined
      ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`
      : '';
  return `${seed}<conversation>\n${conversation}\n</conversation>`;
}

function renderTitleConversation(messages: readonly AgentMessage[]): string {
  return messages
    .slice(-12)
    .map((message) => {
      const content = (message as { content?: unknown }).content;
      const text =
        typeof content === 'string' ? content : JSON.stringify(content);
      return `### ${message.role}\n${text.slice(0, 1000)}`;
    })
    .join('\n\n');
}

function normalizeGeneratedTitle(value: string): string {
  return value
    .trim()
    .replace(/^["'`]+|["'`]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .slice(0, 80);
}

function isSuccessfulMemorySourceRun(result: AgentRunResult): boolean {
  return ![
    'approval-required',
    'interrupted',
    'content-filter',
    'error',
    'unknown',
  ].includes(result.finishReason);
}

function isExcludedMemorySubmission(
  meta: Record<string, unknown> | undefined,
): boolean {
  if (meta === undefined) {
    return false;
  }
  return (
    meta['goalContinuation'] === true ||
    meta['internal'] === true ||
    meta['subagent'] === true ||
    meta['memoryJob'] !== undefined ||
    meta['source'] === 'goal-continuation' ||
    meta['source'] === 'internal' ||
    meta['source'] === 'subagent'
  );
}

function selectToolsForAgent(
  tools: readonly AnyAgentTool[],
  whitelist: readonly string[] | undefined,
): AnyAgentTool[] {
  if (whitelist === undefined) {
    return [...tools];
  }
  const available = new Set(tools.map((tool) => tool.name));
  const missing = whitelist.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Unknown tool in agent definition: ${missing.join(', ')}`);
  }
  const selected = new Set(whitelist);
  return tools.filter((tool) => selected.has(tool.name));
}

function isActiveGoal(goal: GoalState | null): boolean {
  return goal?.status === 'active';
}

/**
 * 构造压缩器用的一次性 compact checkpoint 生成回调。
 *
 * 通过 agent registry 取 internal compact agent，用与主会话相同的 provider
 * 配置跑一次补全，避免压缩器直接依赖 provider 细节。
 */
function makeCompactCheckpointGenerator(
  config: CodingAgentConfig,
  registry: AgentRegistry,
  modelAdapter?: ModelAdapter,
) {
  return async (
    messages: readonly AgentMessage[],
    opts: { previousCheckpoint?: string; maxTokens?: number },
  ): Promise<string> => {
    const previous =
      opts.previousCheckpoint !== undefined
        ? `<previous-compact>\n${opts.previousCheckpoint}\n</previous-compact>\n\n`
        : '';
    const prompt = `${previous}<conversation>\n${renderCompactConversation(messages)}\n</conversation>`;
    return runInternalAgent({
      definition: registry.get('compact'),
      prompt,
      config,
      providerRegistry: createProviderRegistry(config),
      ...(modelAdapter !== undefined ? { modelAdapter } : {}),
    });
  };
}

async function driveRun(options: {
  readonly currentStream: AgentStream;
  readonly pendingApprovalCount: () => number;
  readonly pendingUserInputCount: () => number;
  readonly emit: (event: CodingSessionEvent) => void;
  readonly onEvent: (event: AgentStreamEvent) => Promise<void>;
  readonly checkpoints: CheckpointStore;
  readonly checkpointLabel?: string | undefined;
}): Promise<AgentRunResult> {
  const {
    currentStream,
    pendingApprovalCount,
    pendingUserInputCount,
    emit,
    onEvent,
    checkpoints,
    checkpointLabel,
  } = options;
  emit({ type: 'status', state: 'running' });
  let completedEvent:
    | Extract<AgentStreamEvent, { type: 'run.completed' }>
    | undefined;
  for await (const event of currentStream) {
    if (event.type === 'run.completed') {
      completedEvent = event;
      continue;
    }
    await onEvent(event);
  }
  const result = await currentStream.final;
  if (completedEvent === undefined) {
    throw new Error(`Run ${result.id} completed without run.completed event.`);
  }
  await onEvent(completedEvent);
  emit({ type: 'usage', usage: result.usage });
  await checkpoints.seal(result.id, checkpointLabel);
  emit({
    type: 'status',
    state:
      pendingApprovalCount() > 0
        ? 'awaiting_approval'
        : pendingUserInputCount() > 0
          ? 'awaiting_user_input'
          : 'idle',
  });
  return result;
}

function canContinueAfter(result: AgentRunResult): boolean {
  return (
    (result.pending?.length ?? 0) === 0 &&
    result.finishReason !== 'interrupted' &&
    result.finishReason !== 'error'
  );
}
