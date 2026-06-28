import { randomUUID } from 'node:crypto';

import {
  createAgent,
  createDelegateTool,
  createLocalShellEnvironment,
  createSkillTools,
  activeSkillsContext,
  type Agent,
  type AgentMessage,
  type AgentRunResult,
  type AgentSkill,
  type AgentStream,
  type AgentStreamEvent,
  type DeferredApprovalItem,
  type ModelAdapter,
  type SessionCompactor,
} from '@ello/agent';

import { CheckpointStore } from '../change/checkpoint.js';
import type { CodingAgentConfig } from '../config.js';
import {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_PROMPT,
  UPDATE_SUMMARIZATION_PROMPT,
  createSessionCompactor,
} from '../context/compactor.js';
import { createCodingMemory } from '../context/memory.js';
import { buildSystemSections } from '../context/sections.js';
import { createCodingObserver } from '../observability/observer.js';
import { RulesStore } from '../permission/rules-store.js';
import { JsonlSessionStore } from '../session/jsonl-store.js';
import { checkpointsDir } from '../session/paths.js';
import { loadCodingSkills } from '../skills.js';
import { codingSubagents } from '../subagents.js';
import { buildCodingSystemPrompt } from '../system-prompt.js';
import { createCodingTools } from '../tools/index.js';

import type { ApprovalDecision, CodingEventListener, CodingSessionEvent } from './intents.js';

/** 模型上下文窗口默认值，用于压缩触发判定。 */
const DEFAULT_CONTEXT_WINDOW = 160_000;

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
  submit(prompt: string, meta?: Record<string, unknown>): Promise<AgentRunResult>;
  steer(prompt: string): void;
  approve(requestId: string, decision: ApprovalDecision): Promise<void>;
  abort(reason?: string): void;
  newSession(): Promise<string>;
  resumeSession(idOrPath: string): Promise<void>;
  close(): Promise<void>;
}

/** 装配完成后注入 {@link CodingSessionImpl} 的依赖。 */
interface SessionDeps {
  readonly sessionStore: JsonlSessionStore;
  readonly rulesStore: RulesStore;
  readonly compactor: SessionCompactor;
  readonly skills: readonly AgentSkill[];
  readonly modelAdapter?: ModelAdapter;
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
  const sessionId = config.sessionId ?? randomUUID();

  const sessionStore = new JsonlSessionStore({ sessionDir: config.sessionDir, cwd: config.cwd });
  const rulesStore = new RulesStore(config.cwd);
  await rulesStore.load();

  const compactor = createSessionCompactor({
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    previousSummary: () => sessionStore.latestCompactionSummary(sessionId),
    summarize: makeSummarizer(config, options.modelAdapter),
  });

  const skills = await loadCodingSkills(config);

  const session = new CodingSessionImpl(sessionId, config, {
    sessionStore,
    rulesStore,
    compactor,
    skills,
    ...(options.modelAdapter !== undefined ? { modelAdapter: options.modelAdapter } : {}),
  });
  session.emit({ type: 'session.opened', sessionId, cwd: config.cwd });
  return session;
}

/** CodingSession 的具体实现。 */
class CodingSessionImpl implements CodingSession {
  readonly checkpoints: CheckpointStore;

  private agent: Agent;
  /** 当前激活技能名集合，被 activate_skill 工具与 section 共享。 */
  private readonly activeSkills = new Set<string>();
  private readonly listeners = new Set<CodingEventListener>();
  private readonly pendingApprovals = new Map<string, DeferredApprovalItem>();
  private readonly steerQueue: string[] = [];
  private currentStream: AgentStream | undefined;

  constructor(
    public sessionId: string,
    private readonly config: CodingAgentConfig,
    private readonly deps: SessionDeps,
  ) {
    this.checkpoints = new CheckpointStore(checkpointsDir(config.cwd));
    this.agent = this.buildAgent();
  }

  get cwd(): string {
    return this.config.cwd;
  }

  subscribe(listener: CodingEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 提交一次用户输入，消费整条 stream 直到 run 结束或被审批卡住。 */
  async submit(prompt: string, meta?: Record<string, unknown>): Promise<AgentRunResult> {
    // v1：把排队的 steer 输入并入本次提交（公共 API 暂无 run 内注入入口）。
    const drained = this.steerQueue.splice(0);
    const input = drained.length > 0 ? [...drained, prompt].join('\n\n') : prompt;

    this.emit({ type: 'status', state: 'running' });
    this.currentStream = this.agent.stream(input, {
      sessionId: this.sessionId,
      ...(meta !== undefined ? { metadata: meta } : {}),
    });
    try {
      for await (const event of this.currentStream) {
        this.forward(event);
      }
      const result = await this.currentStream.final;
      this.emit({ type: 'usage', usage: result.usage });
      await this.checkpoints.seal(result.id, prompt.slice(0, 80));
      this.emit({
        type: 'status',
        state: this.pendingApprovals.size > 0 ? 'awaiting_approval' : 'idle',
      });
      return result;
    } finally {
      this.currentStream = undefined;
    }
  }

  /** 运行中追加输入（steer）。v1 缓冲到下一次 submit 前合并。 */
  steer(prompt: string): void {
    this.steerQueue.push(prompt);
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
      await this.deps.rulesStore.addAllowRule(item, decision.scope ?? 'session');
    } else if (decision.action === 'deny') {
      await this.deps.rulesStore.addDenyRule(item, decision.scope ?? 'session');
    }

    this.emit({ type: 'status', state: 'running' });
    const resumed = this.agent.resume(
      {
        deferred: [item],
        approvals: {
          [item.toolCallId]: {
            approved,
            ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
          },
        },
      },
      { sessionId: this.sessionId },
    );
    this.currentStream = resumed;
    try {
      for await (const event of resumed) {
        this.forward(event);
      }
      const result = await resumed.final;
      this.emit({ type: 'usage', usage: result.usage });
      await this.checkpoints.seal(result.id);
      this.emit({
        type: 'status',
        state: this.pendingApprovals.size > 0 ? 'awaiting_approval' : 'idle',
      });
    } finally {
      this.currentStream = undefined;
    }
  }

  /** 中断当前 run。 */
  abort(reason?: string): void {
    this.currentStream?.abort(reason);
  }

  /** 新建会话：换 sessionId 并重建 Agent。 */
  async newSession(): Promise<string> {
    this.sessionId = randomUUID();
    await this.rebuild();
    this.emit({ type: 'session.switched', sessionId: this.sessionId });
    return this.sessionId;
  }

  /** 恢复一个已有会话。 */
  async resumeSession(idOrPath: string): Promise<void> {
    // 支持传 id 或 .jsonl 路径；store 以 id 为键。
    const id = idOrPath.endsWith('.jsonl')
      ? idOrPath.replace(/.*\/(.+)\.jsonl$/u, '$1')
      : idOrPath;
    this.sessionId = id;
    await this.rebuild();
    this.emit({ type: 'session.switched', sessionId: this.sessionId });
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  /** 向所有订阅者广播一个事件。 */
  emit(event: CodingSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** 原样转发内核事件，并截获 approval/写改动维护内部状态。 */
  private forward(event: AgentStreamEvent): void {
    if (event.type === 'approval.required') {
      this.pendingApprovals.set(event.item.toolCallId, event.item);
      this.emit(event);
      this.emit({
        type: 'approval.pending',
        requestId: event.item.toolCallId,
        toolName: event.item.toolName,
        input: event.item.input,
      });
      return;
    }
    if (event.type === 'tool.completed') {
      this.maybeRecordChange(event.toolCallId, event.output);
    }
    this.emit(event);
  }

  /** 写类工具（输出带 path + diff）的改动累积到检查点。 */
  private maybeRecordChange(toolCallId: string, output: unknown): void {
    if (typeof output !== 'object' || output === null) {
      return;
    }
    const record = output as {
      path?: unknown;
      diff?: unknown;
      before?: unknown;
      after?: unknown;
    };
    if (typeof record.path !== 'string' || typeof record.diff !== 'string') {
      return;
    }
    this.checkpoints.record({
      path: record.path,
      diff: record.diff,
      toolCallId,
      before: typeof record.before === 'string' ? record.before : null,
      after: typeof record.after === 'string' ? record.after : null,
    });
  }

  /** 关掉旧 Agent，按当前 sessionId 重建。 */
  private async rebuild(): Promise<void> {
    await this.agent.close();
    this.pendingApprovals.clear();
    this.steerQueue.length = 0;
    this.agent = this.buildAgent();
  }

  /** 把各模块产物拼进 createAgent，这是整个会话运行时的核心装配。 */
  private buildAgent(): Agent {
    const { config } = this;
    const memory = createCodingMemory(config);
    const observer = createCodingObserver(config);

    const tools = createCodingTools({ config, rules: () => this.deps.rulesStore.rules() });
    const skillTools = createSkillTools({ skills: this.deps.skills, active: this.activeSkills });
    const delegateTool = createDelegateTool({
      subagents: codingSubagents(config),
      model: config.model,
      parentTools: tools,
      session: this.deps.sessionStore,
      ...(this.deps.modelAdapter !== undefined ? { modelAdapter: this.deps.modelAdapter } : {}),
    });

    const sections = [
      ...buildSystemSections(config, {
        activeSkills: () => [...this.activeSkills],
        sessionSummary: () => this.deps.sessionStore.latestCompactionSummary(this.sessionId),
      }),
      activeSkillsContext({ skills: this.deps.skills, activation: 'activated' }),
      memory.section,
    ];

    return createAgent({
      name: 'ello-coding-agent',
      model: config.model,
      instructions: buildCodingSystemPrompt(config),
      environment: createLocalShellEnvironment({
        cwd: config.cwd,
        allowedPaths: config.allowedPaths,
      }),
      tools: [...tools, ...skillTools, delegateTool],
      session: this.deps.sessionStore,
      compactor: this.deps.compactor,
      observers: [observer, memory.observer],
      sessionWindow: { maxMessages: 200 },
      modelInputBudget: { maxInputTokens: 160_000, reservedOutputTokens: 8_000 },
      modelInput: { systemSections: sections },
      ...(this.deps.modelAdapter !== undefined ? { modelAdapter: this.deps.modelAdapter } : {}),
      metadata: { sessionId: this.sessionId, cwd: config.cwd },
    });
  }
}

/**
 * 构造压缩器用的一次性摘要回调。
 *
 * 临时起一个无工具的小 Agent 跑一次补全，用与主会话相同的 model / adapter，
 * 避免压缩器直接依赖 provider 细节（保持与内核解耦）。
 */
function makeSummarizer(config: CodingAgentConfig, modelAdapter?: ModelAdapter) {
  return async (
    messages: readonly AgentMessage[],
    opts: { previousSummary?: string; maxTokens?: number },
  ): Promise<string> => {
    const head =
      opts.previousSummary !== undefined
        ? `${UPDATE_SUMMARIZATION_PROMPT}<previous-summary>\n${opts.previousSummary}\n</previous-summary>\n`
        : SUMMARIZATION_PROMPT;
    const conversation = messages
      .map((message) => {
        const content = (message as { content?: unknown }).content;
        const text = typeof content === 'string' ? content : JSON.stringify(content);
        return `### ${message.role}\n${text}`;
      })
      .join('\n\n');
    const prompt = `${head}\n<conversation>\n${conversation}\n</conversation>`;

    const summarizer = createAgent({
      name: 'ello-compactor',
      model: config.model,
      instructions: SUMMARIZATION_SYSTEM_PROMPT,
      ...(modelAdapter !== undefined ? { modelAdapter } : {}),
    });
    try {
      const result = await summarizer.run(prompt);
      return result.output || result.text || '';
    } finally {
      await summarizer.close();
    }
  };
}
