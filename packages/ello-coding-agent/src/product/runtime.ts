import { randomUUID } from 'node:crypto';

import {
  createAgent,
  createLocalEnvironment,
  type Agent,
  type AgentMessage,
  type AgentStreamEvent,
  type AnyAgentTool,
  type DeferredRunItem,
  type ModelAdapter,
  type SessionCompactionReport,
  type SessionCompactor,
  type SessionStore,
} from '@ello/agent';

import type { CodingAgentConfig } from '../config.js';
import { createCodingContextReducers } from '../context/reducers.js';
import { createCodingContextSources } from '../context/sources.js';
import { denialKey, PermissionStore, type PermissionRule } from '../permissions.js';
import { JsonlSessionRepository } from '../session/repository.js';
import type { SessionTreeView } from '../session/repository.js';
import { buildCodingSystemPrompt } from '../system-prompt.js';
import { createCodingTools } from '../tools/index.js';

import { ProductEventStore } from './event-store.js';
import {
  type ApprovalDecision,
  type ApprovalRequestView,
  type CodingAgentEvent,
  type CompactSummary,
  type QueuedInput,
  type SessionInfo,
  type UserSubmission,
  mapCoreEvent,
} from './events.js';

/** runtime 构造参数。 */
export interface CodingAgentRuntimeOptions {
  readonly config: CodingAgentConfig;
  readonly modelAdapter?: ModelAdapter;
}

/** session fork 参数。 */
export interface ForkOptions {
  readonly reason?: string;
}

/** compact 参数。 */
export interface CompactOptions {
  readonly reason?: 'manual' | 'context-overflow' | 'session-branch';
}

/** coding-agent 产品层唯一长期对象。 */
export class CodingAgentRuntime {
  readonly events = new ProductEventStore();
  sessionId: string;
  readonly cwd: string;

  private readonly repository: JsonlSessionRepository;
  private readonly permissionStore: PermissionStore;
  private readonly denied = new Map<string, number>();
  private tools: AnyAgentTool[];
  private agent: Agent;
  private readonly pendingApprovals = new Map<string, { request: ApprovalRequestView; deferred: DeferredRunItem }>();
  private readonly mappedTools = new Map<string, import('./events.js').ToolCallView>();
  private readonly steering: QueuedInput[] = [];
  private readonly followUpQueue: QueuedInput[] = [];
  private leafEntryId: string | null = null;
  private closed = false;

  private constructor(
    private options: CodingAgentRuntimeOptions,
    private session: SessionInfo,
    private initialMessages: AgentMessage[],
  ) {
    this.cwd = options.config.cwd;
    this.sessionId = session.sessionId;
    this.repository = new JsonlSessionRepository({ sessionDir: options.config.sessionDir, cwd: options.config.cwd });
    this.permissionStore = new PermissionStore(options.config.cwd);
    this.tools = this.createTools(options.config);
    this.agent = this.createAgentForConfig(options.config);
  }

  /** 创建并初始化 runtime。 */
  static async create(options: CodingAgentRuntimeOptions): Promise<CodingAgentRuntime> {
    const repository = new JsonlSessionRepository({ sessionDir: options.config.sessionDir, cwd: options.config.cwd });
    const opened = await repository.open(options.config.sessionId ?? undefined);
    const runtime = new CodingAgentRuntime(options, opened.info, opened.messages);
    runtime.leafEntryId = opened.leafEntryId;
    await runtime.emit({ type: 'session.started', sessionId: opened.info.sessionId, session: opened.info, createdAt: new Date().toISOString() });
    return runtime;
  }

  /**
   * 提交用户输入并消费 core stream。
   *
   * print、json、rpc 和 TUI 都应调用这个入口，而不是直接碰 @ello/agent。
   */
  async submit(input: UserSubmission | string): Promise<void> {
    const submission = typeof input === 'string' ? { prompt: input, source: 'submit' as const } : input;
    const runOptions = {
      sessionId: this.sessionId,
      ...(submission.metadata !== undefined ? { metadata: submission.metadata } : {}),
    };
    const stream = this.agent.stream(submission.prompt, runOptions);
    await this.consumeStream(stream, submission);
  }

  /** 运行中 steering 队列。当前实现会排队并在下一次 submit 前可视化。 */
  steer(input: UserSubmission): void {
    this.steering.push({ id: randomUUID(), prompt: input.prompt, createdAt: new Date().toISOString() });
    void this.emitQueue();
  }

  /** 完成后 follow-up 队列。 */
  followUp(input: UserSubmission): void {
    this.followUpQueue.push({ id: randomUUID(), prompt: input.prompt, createdAt: new Date().toISOString() });
    void this.emitQueue();
  }

  /** 中断当前运行；stream abort 由 TUI controller 管理，这里记录产品诊断。 */
  abort(reason = 'aborted by user'): void {
    void this.emit({ type: 'runtime.diagnostic', sessionId: this.sessionId, level: 'warn', message: reason, createdAt: new Date().toISOString() });
  }

  /**
   * 审批并恢复原 deferred tool call。
   *
   * approve_once/always_allow 会执行原工具；deny 会记录 repeated denial，并把
   * denial result 交给 core resume，使模型能理解拒绝原因。
   */
  async approve(requestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (pending === undefined) {
      throw new Error(`Unknown approval request: ${requestId}`);
    }
    await this.emit({ type: 'approval.resolved', sessionId: this.sessionId, runId: pending.request.id, requestId, decision, createdAt: new Date().toISOString() });
    const approved = decision.action === 'approve_once' || decision.action === 'always_allow';
    if (!approved) {
      this.denied.set(denialKey({ toolName: pending.request.toolName, input: pending.request.input }), (this.denied.get(denialKey({ toolName: pending.request.toolName, input: pending.request.input })) ?? 0) + 1);
    } else if (decision.action === 'always_allow') {
      await this.permissionStore.addRule(this.createAllowRule(pending.request, decision.scope ?? 'session', decision.reason));
    }
    const approvalResult = { approved, ...(decision.reason !== undefined ? { reason: decision.reason } : {}) };
    const stream = this.agent.resume(
      {
        deferred: [pending.deferred],
        approvals: { [pending.request.toolCallId]: approvalResult },
      },
      { sessionId: this.sessionId },
    );
    this.pendingApprovals.delete(requestId);
    await this.consumeStream(stream, { prompt: '', source: 'command' });
  }

  /** 切换模型，当前 runtime 记录诊断；新模型在新 runtime 生效。 */
  async switchModel(model: string): Promise<void> {
    await this.agent.close();
    this.options = { ...this.options, config: { ...this.options.config, model } };
    this.agent = this.createAgentForConfig(this.options.config);
    await this.emit({ type: 'runtime.diagnostic', sessionId: this.sessionId, level: 'info', message: `model switched: ${model}`, createdAt: new Date().toISOString() });
  }

  /** 手动 compact，写入 session compaction record。 */
  async compact(options: CompactOptions = {}): Promise<void> {
    await this.emit({ type: 'compaction.started', sessionId: this.sessionId, reason: options.reason ?? 'manual', createdAt: new Date().toISOString() });
    const summary: CompactSummary = {
      id: randomUUID(),
      ...(this.leafEntryId !== null ? { boundaryEntryId: this.leafEntryId } : {}),
      summary: `Compacted ${this.events.all().length} product events at ${new Date().toISOString()}.`,
    };
    await this.repository.compact(this.sessionId, summary);
    await this.emit({ type: 'compaction.completed', sessionId: this.sessionId, summary, createdAt: new Date().toISOString() });
  }

  /** 创建新 session。CLI/TUI 可通过新 runtime 使用返回的 session。 */
  async newSession(): Promise<SessionInfo> {
    const opened = await this.repository.open();
    await this.replaceSession(opened.info, opened.messages, opened.leafEntryId);
    return opened.info;
  }

  /** 恢复指定 session，并让当前 runtime 后续输入写入该 session。 */
  async resumeSession(idOrPath: string): Promise<void> {
    const sessionId = idOrPath.endsWith('.jsonl')
      ? idOrPath.split('/').at(-1)?.replace(/\.jsonl$/, '') ?? idOrPath
      : idOrPath;
    const opened = await this.repository.open(sessionId);
    await this.replaceSession(opened.info, opened.messages, opened.leafEntryId);
  }

  /** fork active branch 到新 session。 */
  async fork(entryId: string, options: ForkOptions = {}): Promise<void> {
    if (entryId) {
      await this.repository.checkout(this.sessionId, entryId);
    }
    const info = await this.repository.fork(this.sessionId, options.reason);
    await this.emit({ type: 'runtime.diagnostic', sessionId: this.sessionId, level: 'info', message: `forked session ${info.sessionId}`, createdAt: new Date().toISOString() });
  }

  /** 导出当前 session。 */
  async exportSession(format: 'jsonl' | 'html' = 'jsonl'): Promise<string> {
    return format === 'html'
      ? this.repository.exportHtml(this.sessionId)
      : this.repository.exportJsonl(this.sessionId);
  }

  /** 读取当前 session tree，供 /tree、TUI overlay 和 RPC 使用。 */
  async sessionTree(): Promise<SessionTreeView> {
    return this.repository.tree(this.sessionId);
  }

  /** 关闭 runtime。 */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.agent.close();
  }

  private async consumeStream(stream: ReturnType<Agent['stream']>, submission: UserSubmission): Promise<void> {
    let runId = '';
    try {
      for await (const event of stream) {
        if (event.type === 'run.started') {
          runId = event.runId;
          await this.emit({
            type: 'run.started',
            sessionId: this.sessionId,
            runId,
            input: { prompt: submission.prompt, source: submission.source ?? 'submit' },
            createdAt: new Date().toISOString(),
          });
          continue;
        }
        await this.handleCoreEvent(event, runId || coreRunId(event));
      }
    } catch (error) {
      await this.emit({
        type: 'run.failed',
        sessionId: this.sessionId,
        ...(runId ? { runId } : {}),
        error: normalizeError(error),
        createdAt: new Date().toISOString(),
      });
      throw error;
    }
    await stream.final;
  }

  private async handleCoreEvent(event: AgentStreamEvent, runId: string): Promise<void> {
    const mapped = mapCoreEvent({ event, sessionId: this.sessionId, runId, toolCalls: this.mappedTools });
    for (const productEvent of mapped) {
      if (productEvent.type === 'approval.requested') {
        this.pendingApprovals.set(productEvent.request.id, {
          request: productEvent.request,
          deferred: {
            kind: 'approval',
            toolCallId: productEvent.request.toolCallId,
            toolName: productEvent.request.toolName,
            input: productEvent.request.input,
            reason: productEvent.request.reason,
          },
        });
      }
      await this.emit(productEvent);
    }
  }

  private async emit(event: CodingAgentEvent): Promise<void> {
    this.events.append(event);
    this.leafEntryId = await this.repository.appendEvent(this.sessionId, this.leafEntryId, event);
  }

  private async emitQueue(): Promise<void> {
    await this.emit({ type: 'queue.updated', sessionId: this.sessionId, steering: [...this.steering], followUp: [...this.followUpQueue], createdAt: new Date().toISOString() });
  }

  private createSessionStore(): SessionStore {
    return {
      load: async () => [...this.initialMessages],
      append: async (_sessionId, messages) => {
        this.leafEntryId = await this.repository.appendMessages(this.sessionId, this.leafEntryId, messages);
      },
      compact: async (_sessionId, report, metadata) => {
        await this.repository.compact(this.sessionId, {
          id: randomUUID(),
          ...(this.leafEntryId !== null ? { boundaryEntryId: this.leafEntryId } : {}),
          summary: typeof metadata?.summary === 'string'
            ? metadata.summary
            : `Auto compacted ${report.beforeMessageCount} messages to ${report.afterMessageCount}.`,
        });
      },
    };
  }

  private async replaceSession(info: SessionInfo, messages: AgentMessage[], leafEntryId: string | null): Promise<void> {
    await this.agent.close();
    this.session = info;
    this.sessionId = info.sessionId;
    this.initialMessages = messages;
    this.leafEntryId = leafEntryId;
    this.agent = this.createAgentForConfig(this.options.config);
    await this.emit({ type: 'session.started', sessionId: info.sessionId, session: info, createdAt: new Date().toISOString() });
  }

  private createAgentForConfig(config: CodingAgentConfig): Agent {
    this.tools = this.createTools(config);
    return createAgent({
      name: 'ello-coding-agent',
      model: config.model,
      instructions: buildCodingSystemPrompt(config),
      context: createCodingContextSources(config, {
        sessionSummary: () => this.repository.latestCompactionSummary(this.sessionId),
        activeSkills: () => [],
      }),
      reducers: createCodingContextReducers(),
      environment: createLocalEnvironment({ cwd: config.cwd, allowedPaths: config.allowedPaths }),
      tools: this.tools,
      ...(this.options.modelAdapter !== undefined ? { modelAdapter: this.options.modelAdapter } : {}),
      session: this.createSessionStore(),
      compactor: this.createSessionCompactor(),
      metadata: { sessionId: this.sessionId, cwd: config.cwd },
    });
  }

  /**
   * 创建自动 compact 策略。
   *
   * 这里先用确定性摘要把长会话边界落到 session JSONL；真正的模型总结器可以
   * 后续替换该 compactor，而 runtime/session/TUI 的协议不需要变化。
   */
  private createSessionCompactor(): SessionCompactor {
    return {
      name: 'coding.summary-compactor',
      maybeCompact: async (sessionId, store, ctx): Promise<SessionCompactionReport | null> => {
        const messages = ctx.state.messages;
        const totalChars = messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
        if (messages.length < 24 && totalChars < 80_000) {
          return null;
        }
        const report: SessionCompactionReport = {
          compactor: 'coding.summary-compactor',
          beforeMessageCount: messages.length,
          afterMessageCount: Math.min(messages.length, 8),
          metadata: { totalChars },
        };
        const summary = summarizeMessagesForCompact(messages);
        await store.compact?.(sessionId, report, { summary });
        await this.emit({
          type: 'compaction.completed',
          sessionId: this.sessionId,
          summary: {
            id: randomUUID(),
            ...(this.leafEntryId !== null ? { boundaryEntryId: this.leafEntryId } : {}),
            summary,
          },
          createdAt: new Date().toISOString(),
        });
        return report;
      },
    };
  }

  private createTools(config: CodingAgentConfig): AnyAgentTool[] {
    return createCodingTools({
      config,
      denied: this.denied,
      rules: () => this.permissionStore.rules(),
    });
  }

  private createAllowRule(
    request: ApprovalRequestView,
    scope: NonNullable<PermissionRule['scope']>,
    reason?: string,
  ): PermissionRule {
    const input = request.input as Record<string, unknown> | undefined;
    return {
      action: 'allow',
      tool: request.toolName,
      scope,
      ...(typeof input?.path === 'string' ? { pathGlob: input.path } : {}),
      ...(typeof input?.command === 'string' ? { commandPattern: escapeRegExp(input.command) } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function coreRunId(event: AgentStreamEvent): string {
  if ('runId' in event && typeof event.runId === 'string') {
    return event.runId;
  }
  return 'unknown';
}

function normalizeError(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, ...(error.stack !== undefined ? { stack: error.stack } : {}) };
  }
  return { name: 'Error', message: String(error) };
}

function summarizeMessagesForCompact(messages: readonly AgentMessage[]): string {
  const tail = messages.slice(-8).map((message, index) => {
    const content = (message as { content?: unknown }).content;
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    return `${index + 1}. ${message.role}: ${text.slice(0, 500)}`;
  });
  return [
    `Session compact summary generated at ${new Date().toISOString()}.`,
    `Original messages: ${messages.length}. Recent active context:`,
    ...tail,
  ].join('\n');
}
