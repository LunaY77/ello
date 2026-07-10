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
  type AgentModel,
  type AgentObserver,
  type AgentRunResult,
  type AgentShell,
  type AgentSkill,
  type AgentStream,
  type AgentStreamEvent,
  type AnyAgentTool,
  type DeferredApprovalItem,
  type ModelAdapter,
  type SessionCompactor,
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
import {
  createSessionCompactor,
  renderCompactConversation,
  serializeForCompact,
} from '../context/compactor.js';
import { createCodingMemory } from '../context/memory.js';
import { createCodingSystemPromptSection } from '../context/prompts.js';
import {
  createToolResultBudget,
  type ToolResultBudget,
} from '../context/tool-result-budget.js';
import { createCodingObserver } from '../observability/observer.js';
import { isPathInside, resolveAbsolute } from '../permission/engine.js';
import { RulesStore } from '../permission/rules-store.js';
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
import { createCodingTools } from '../tools/index.js';
import { createBootProfile } from '../utils/boot-profile.js';

import { createCodingEventRecorder } from './event-recorder.js';
import type {
  ApprovalDecision,
  CodingEventListener,
  CodingSessionEvent,
} from './intents.js';

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
    ...(fileSystem !== undefined ? { fileSystem, files: fileSystem } : {}),
    ...(shell !== undefined ? { shell } : {}),
    ...(resources !== undefined ? { resources } : {}),
    getContextInstructions: () => null,
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
    getContextInstructions: () => null,
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
  clear(): Promise<void>;
  approve(requestId: string, decision: ApprovalDecision): Promise<void>;
  abort(reason?: string): void;
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
  exportSession(format?: 'jsonl' | 'html'): Promise<string>;
  newSession(): Promise<string>;
  resumeSession(idOrPath: string): Promise<void>;
  close(): Promise<void>;
}

/** 装配完成后注入 {@link CodingSessionImpl} 的依赖。 */
interface SessionDeps {
  readonly storage: CodingStorage;
  readonly sessionStore: JsonlSessionStore;
  readonly rulesStore: RulesStore;
  readonly registry: AgentRegistry;
  readonly backgroundJobs: BackgroundJobStore;
  readonly modelAdapter?: ModelAdapter;
}

interface AgentRuntimeDeps {
  readonly agent: Agent;
  readonly compactor: SessionCompactor;
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

  profile.mark('start');
  const sessionStore = new JsonlSessionStore({
    sessionDir: config.sessionDir,
    cwd: config.cwd,
  });
  const storage = createCodingStorage();
  const rulesStore = new RulesStore(config.cwd);
  let session: CodingSessionImpl;
  try {
    await profile.measure('rules.load', () => rulesStore.load());
    const registry = await profile.measure('agents.registry', () =>
      createAgentRegistry(config),
    );
    session = new CodingSessionImpl(sessionId, config, {
      storage,
      sessionStore,
      rulesStore,
      registry,
      backgroundJobs: new BackgroundJobStore(),
      ...(options.modelAdapter !== undefined
        ? { modelAdapter: options.modelAdapter }
        : {}),
    });
  } catch (error) {
    storage.close();
    throw error;
  }
  profile.mark('ready');
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
  private readonly pendingApprovals = new Map<string, DeferredApprovalItem>();
  private readonly sessionExternalPaths = new Set<string>();
  private readonly steerQueue: string[] = [];
  private currentStream: AgentStream | undefined;
  private config: CodingAgentConfig;
  private providerRegistry: ProviderRegistry;
  private primaryRole: RuntimeRoleModel;
  private readonly toolResultBudget: ToolResultBudget;
  private activeAgentName: string;

  constructor(
    public sessionId: string,
    config: CodingAgentConfig,
    private readonly deps: SessionDeps,
  ) {
    this.config = config;
    this.activeAgentName = config.default_agent;
    this.providerRegistry = createProviderRegistry(config);
    this.checkpoints = new CheckpointStore(this.deps.storage.checkpoints);
    this.primaryRole = this.resolveRuntimeRole('primary');
    this.toolResultBudget = createToolResultBudget({
      sessionStore: this.deps.sessionStore,
      sessionId: () => this.sessionId,
      config: config.context.tool_result_budget,
    });
    this.deps.backgroundJobs.onSettled((job) =>
      this.injectBackgroundResult(job),
    );
  }

  get cwd(): string {
    return this.config.cwd;
  }

  subscribe(listener: CodingEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 提交一次用户输入，消费整条 stream 直到 run 结束或被审批卡住。 */
  async submit(
    prompt: string,
    meta?: Record<string, unknown>,
  ): Promise<AgentRunResult> {
    // v1：把排队的 steer 输入并入本次提交（公共 API 暂无 run 内注入入口）。
    const drained = this.steerQueue.splice(0);
    const input =
      drained.length > 0 ? [...drained, prompt].join('\n\n') : prompt;
    const runtime = await this.ensureAgentRuntime();

    this.currentStream = runtime.agent.stream(input, {
      sessionId: this.sessionId,
      maxTurns: this.activeAgentMaxTurns(),
      ...(meta !== undefined ? { metadata: meta } : {}),
    });
    try {
      const result = await driveRun({
        currentStream: this.currentStream,
        pendingApprovalCount: () => this.pendingApprovals.size,
        emit: (event) => this.emit(event),
        onEvent: (event) => this.forward(event),
        checkpoints: this.checkpoints,
        checkpointLabel: prompt.slice(0, 80),
      });
      if ((result.pending?.length ?? 0) === 0) {
        this.scheduleSessionTitle(result.messages);
      }
      return result;
    } finally {
      this.currentStream = undefined;
    }
  }

  /** 运行中追加输入（steer）：优先注入当前 stream 的下一回合。 */
  steer(prompt: string): void {
    if (this.currentStream !== undefined) {
      this.currentStream.steer({ role: 'user', content: prompt });
      return;
    }
    this.steerQueue.push(prompt);
  }

  /** 清空当前可见上下文并切到新会话。 */
  async clear(): Promise<void> {
    if (this.currentStream !== undefined) {
      this.abort('clear requested from TUI');
    }
    await this.newSession();
  }

  /** 审批决定：翻译成 DeferredRunResults 并 `agent.resume()`。 */
  async approve(requestId: string, decision: ApprovalDecision): Promise<void> {
    const item = this.pendingApprovals.get(requestId);
    if (item === undefined) {
      throw new Error(`Unknown approval: ${requestId}`);
    }
    this.pendingApprovals.delete(requestId);

    const approved = decision.action !== 'deny';
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

    const runtime = await this.ensureAgentRuntime();
    const resumed = runtime.agent.resume(
      {
        deferred: [item],
        approvals: {
          [item.toolCallId]: {
            approved,
            ...(decision.reason !== undefined
              ? { reason: decision.reason }
              : {}),
          },
        },
      },
      { sessionId: this.sessionId, maxTurns: this.activeAgentMaxTurns() },
    );
    this.currentStream = resumed;
    try {
      const result = await driveRun({
        currentStream: this.currentStream,
        pendingApprovalCount: () => this.pendingApprovals.size,
        emit: (event) => this.emit(event),
        onEvent: (event) => this.forward(event),
        checkpoints: this.checkpoints,
      });
      if ((result.pending?.length ?? 0) === 0) {
        this.scheduleSessionTitle(result.messages);
      }
    } finally {
      this.currentStream = undefined;
    }
  }

  /** 中断当前 run。 */
  abort(reason?: string): void {
    this.currentStream?.abort(reason);
    this.emit({ type: 'ui.interrupted', reason: reason ?? 'interrupted' });
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
  loadHistory(): Promise<void> {
    return this.emitHistoryLoaded({ allowMissing: true });
  }

  /** 切换当前 session 的 active leaf，后续 turn 从该节点继续。 */
  async checkout(entryId: string | null): Promise<void> {
    if (this.currentStream !== undefined) {
      this.abort('checkout requested from TUI');
    }
    await this.deps.sessionStore.repository.checkout(this.sessionId, entryId);
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
    await this.deps.sessionStore.repository.checkout(
      this.sessionId,
      target.parentId,
    );
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
    this.sessionId = randomUUID();
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
    const loaded = await this.deps.sessionStore.repository.load(id);
    this.sessionId = id;
    await this.rebuild();
    this.emit({ type: 'session.switched', sessionId: this.sessionId });
    this.emitHistoryLoadedFromMessages(loaded.messages, loaded.messageEntryIds);
  }

  async close(): Promise<void> {
    await this.deps.backgroundJobs.stopAll('coding session closed');
    await this.closeAgentRuntime();
    this.deps.storage.close();
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
      this.pendingApprovals.set(event.item.toolCallId, event.item);
      this.emit(event);
      this.emit({
        type: 'approval.pending',
        requestId: event.item.toolCallId,
        toolName: event.item.toolName,
        input: event.item.input,
        ...(event.item.metadata !== undefined
          ? { metadata: event.item.metadata }
          : {}),
      });
      return;
    }
    this.emit(event);
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
    this.pendingApprovals.clear();
    this.steerQueue.length = 0;
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
    const compactor = createSessionCompactor({
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
      compactor,
      agent: this.buildAgent({ compactor, skills }),
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
    readonly compactor: SessionCompactor;
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
    const config: CodingAgentConfig = {
      ...this.config,
      ...(agentDef.approvalMode !== undefined
        ? { approvalMode: agentDef.approvalMode }
        : {}),
    };
    const agentModel = this.resolveAgentModel(primaryRole);
    const memory = createCodingMemory(config, this.deps.storage.memory);
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
      this.deps.sessionStore.repository.applyContentReplacements(
        this.sessionId,
        messages,
      );

    const tools = createCodingTools({
      config,
      storage: this.deps.storage,
      taskBoardScope: { type: 'session', sessionId: this.sessionId },
      rules: () => this.deps.rulesStore.rules(),
    });
    const selectedTools = selectToolsForAgent(tools, agentDef.tools);
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
      backgroundJobs: this.deps.backgroundJobs,
      hooks: {
        onEvent: (runId, event) =>
          this.emit({ type: 'subagent.event', runId, event }),
        onStarted: (info) => this.emit({ type: 'subagent.started', ...info }),
        onCompleted: (info) =>
          this.emit({ type: 'subagent.completed', ...info }),
        onFailed: (info) => this.emit({ type: 'subagent.failed', ...info }),
      },
      ...(this.deps.modelAdapter !== undefined
        ? { modelAdapter: this.deps.modelAdapter }
        : {}),
    });

    const sections = [
      createCodingSystemPromptSection(config, {
        model: primaryRole.ref,
        activeSkills: () => [...this.activeSkills],
        onContextEvent: (event) => this.emit(event),
      }),
      activeSkillsContext({
        skills: runtime.skills,
        active: this.activeSkills,
        activation: 'activated',
      }),
      skillIndexContext({
        skills: runtime.skills,
        contextWindow: DEFAULT_CONTEXT_WINDOW,
      }),
      memory.section,
    ];

    return createAgent({
      name: `ello-${this.activeAgentName}`,
      model: agentModel,
      modelSettings: modelSettingsFromRole(primaryRole),
      environment: createRuntimeEnvironment(
        config,
        () => this.deps.rulesStore.rules(),
        () => [...this.sessionExternalPaths],
      ),
      tools: [...selectedTools, ...skillTools, delegateTool],
      session: this.deps.sessionStore,
      eventRecorder: createCodingEventRecorder(
        this.deps.sessionStore.repository,
      ),
      compactor: runtime.compactor,
      observers: [observer, memory.observer, runtimeObserver],
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
          prepareModelInputForRuntimeModel(primaryRole.model, input),
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

  private scheduleSessionTitle(messages: readonly AgentMessage[]): void {
    const sessionId = this.sessionId;
    void this.ensureSessionTitle(sessionId, messages).catch((error) => {
      this.emit({
        type: 'context.source.failed',
        origin: 'session-title',
        error: error instanceof Error ? error.message : String(error),
      });
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
  readonly emit: (event: CodingSessionEvent) => void;
  readonly onEvent: (event: AgentStreamEvent) => Promise<void>;
  readonly checkpoints: CheckpointStore;
  readonly checkpointLabel?: string | undefined;
}): Promise<AgentRunResult> {
  const {
    currentStream,
    pendingApprovalCount,
    emit,
    onEvent,
    checkpoints,
    checkpointLabel,
  } = options;
  emit({ type: 'status', state: 'running' });
  let completedEvent:
    | Extract<AgentStreamEvent, { type: 'run.completed' }>
    | undefined;
  let activeMessageId: string | undefined;
  let activeMessageHasDelta = false;
  for await (const event of currentStream) {
    if (event.type === 'message.started') {
      activeMessageId = event.messageId;
      activeMessageHasDelta = false;
    } else if (
      event.type === 'message.delta' &&
      event.messageId === activeMessageId
    ) {
      activeMessageHasDelta = true;
    } else if (event.type === 'run.completed') {
      completedEvent = event;
      continue;
    }
    await onEvent(event);
  }
  const result = await currentStream.final;
  if (completedEvent === undefined) {
    throw new Error(`Run ${result.id} completed without run.completed event.`);
  }
  if (
    activeMessageId !== undefined &&
    !activeMessageHasDelta &&
    result.output.trim() !== ''
  ) {
    await onEvent({
      type: 'message.delta',
      messageId: activeMessageId,
      text: result.output,
    });
  }
  await onEvent(completedEvent);
  emit({ type: 'usage', usage: result.usage });
  await checkpoints.seal(result.id, checkpointLabel);
  emit({
    type: 'status',
    state: pendingApprovalCount() > 0 ? 'awaiting_approval' : 'idle',
  });
  return result;
}
