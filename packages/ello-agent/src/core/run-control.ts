/**
 * 运行控制与消息排队中枢。
 *
 * 一次运行的输入并非只有最初的 prompt，还包括会话历史、运行中追加的引导
 * （steering）、后续提问（follow-up），以及审批/中断产生的延迟项。本模块用一组
 * 语义各异的队列把这些来源统一管理，并在每个回合开始时按固定顺序「抽干」成当回合
 * 的消息序列；同时维护运行状态（运行中/待审批/已中断），供回合循环判定去留。
 */
import type {
  AgentMessage,
  DeferredRunItem,
  DeferredRunResults,
  QueueDrainDiagnostic,
} from '../public/types.js';

import type {
  AgentMessageQueue,
  AgentMessageQueueMode,
  AgentRunControlStatus,
} from './runtime-types.js';
import {
  collectToolCallIds,
  createToolCallMessage,
  createToolResultMessage,
} from './tool-messages.js';

/** {@link AgentRunControl} 的可序列化快照，用于保存/恢复完整排队状态。 */
export interface AgentRunControlSnapshot {
  /** 运行状态（运行中/待审批/已中断）。 */
  readonly status: AgentRunControlStatus;
  /** 是否已被中断。 */
  readonly interrupted: boolean;
  /** 输入队列中尚未消费的消息。 */
  readonly input: AgentMessage[];
  /** 载入的会话历史队列中尚未消费的消息。 */
  readonly session: AgentMessage[];
  /** 后续提问队列中尚未消费的消息。 */
  readonly followUp: AgentMessage[];
  /** 引导队列中尚未消费的消息。 */
  readonly steering: AgentMessage[];
  /** 延迟项队列（审批/中断/延迟工具调用）。 */
  readonly deferred: DeferredRunItem[];
  /** 会话历史是否已被抽干（仅在首个回合抽一次）。 */
  readonly sessionDrained: boolean;
}

/**
 * 消息队列的默认实现。
 *
 * 通过 `mode` 控制抽取粒度：`'all'` 一次抽干全部，`'one-at-a-time'` 每次只抽一条
 * （用于需要逐条推进的引导/后续提问，避免一次性灌入打乱回合节奏）。
 */
export class DefaultAgentMessageQueue<
  T = AgentMessage,
> implements AgentMessageQueue<T> {
  private readonly items: T[] = [];

  constructor(readonly mode: AgentMessageQueueMode = 'all') {}

  /** 当前队列长度。 */
  get size(): number {
    return this.items.length;
  }

  /** 队列是否非空。 */
  get hasItems(): boolean {
    return this.items.length > 0;
  }

  /** 入队一条消息。 */
  push(item: T): void {
    this.items.push(item);
  }

  /** 按 `mode` 抽取消息：`one-at-a-time` 取队首一条，否则取出全部。 */
  drain(): T[] {
    if (this.items.length === 0) {
      return [];
    }
    if (this.mode === 'one-at-a-time') {
      const item = this.items.shift();
      return item === undefined ? [] : [item];
    }
    return this.items.splice(0);
  }

  /** 清空队列。 */
  clear(): void {
    this.items.splice(0);
  }

  /** 拷贝当前队列内容（不改变队列本身）。 */
  snapshot(): T[] {
    return [...this.items];
  }

  /** 用给定内容整体替换队列（配合 `snapshot` 实现保存/恢复）。 */
  restore(items: readonly T[]): void {
    this.items.splice(0, this.items.length, ...items);
  }
}

/** 单个回合抽取消息的结果：合并后的消息序列及各队列的抽取诊断。 */
export interface DrainNextTurnResult {
  /** 本回合按固定顺序合并出的消息序列。 */
  readonly messages: AgentMessage[];
  /** 各来源队列各自抽取了多少条的诊断信息。 */
  readonly diagnostics: QueueDrainDiagnostic[];
}

/**
 * 一次运行的排队与状态控制器。
 *
 * 维护五条来源队列与运行状态，对外提供入队、整回合抽取、状态查询与快照恢复。
 * 抽取顺序固定为：延迟项恢复 → 会话历史（仅首回合）→ 输入 → 引导 → 后续提问。
 */
export class AgentRunControl {
  /** 初始用户输入及 `messages` 选项，一次性全部抽取。 */
  readonly inputQueue = new DefaultAgentMessageQueue<AgentMessage>('all');
  /** 载入的会话历史，仅在首个回合抽取一次。 */
  readonly sessionQueue = new DefaultAgentMessageQueue<AgentMessage>('all');
  /** 后续提问队列，逐条抽取。 */
  readonly followUpQueue = new DefaultAgentMessageQueue<AgentMessage>(
    'one-at-a-time',
  );
  /** 运行中追加的引导消息队列，逐条抽取。 */
  readonly steeringQueue = new DefaultAgentMessageQueue<AgentMessage>(
    'one-at-a-time',
  );
  /** 延迟项队列：审批、中断快照、待恢复的工具调用。 */
  readonly deferredQueue = new DefaultAgentMessageQueue<DeferredRunItem>('all');
  /** 当前运行状态，回合循环据此决定是否停止。 */
  status: AgentRunControlStatus = 'running';
  /** 是否已被中断（中断后无法继续开新回合）。 */
  interrupted = false;
  /** 会话历史是否已抽取过，确保只在首回合注入一次。 */
  private sessionDrained = false;

  constructor(readonly runId: string) {}

  /** 入队一条初始输入消息。 */
  pushInput(message: AgentMessage): void {
    this.inputQueue.push(message);
  }

  /** 入队一条后续提问。 */
  pushFollowUp(message: AgentMessage): void {
    this.followUpQueue.push(message);
  }

  /** 入队一条运行中引导消息。 */
  pushSteering(message: AgentMessage): void {
    this.steeringQueue.push(message);
  }

  /** 入队一个延迟项，并据其类型联动更新运行状态。 */
  pushDeferred(item: DeferredRunItem): void {
    this.deferredQueue.push(item);
    // 审批类延迟项使运行进入待审批状态，需调用方决定后才能恢复。
    if (item.kind === 'approval') {
      this.status = 'waiting_approval';
    }
    if (item.kind === 'tool-call') {
      this.status = 'waiting_tool_result';
    }
    // 中断类延迟项保存中断现场并把运行置为已中断。
    if (item.kind === 'interrupted') {
      this.status = 'interrupted';
      this.interrupted = true;
    }
  }

  /** 是否还有待处理的排队消息（会话历史只在未抽取时计入）。 */
  hasQueuedWork(): boolean {
    return (
      this.inputQueue.hasItems ||
      this.followUpQueue.hasItems ||
      this.steeringQueue.hasItems ||
      (!this.sessionDrained && this.sessionQueue.hasItems)
    );
  }

  /**
   * 抽取并合并出下一个回合的消息序列。
   *
   * 按固定顺序拼装：先注入会话历史（仅首回合），再用 `resume` 补齐审批
   * tool-result，随后依次抽取输入、引导、后续提问。审批恢复必须在历史之后，
   * 因为上一次挂起运行已经可能把 assistant tool-call 持久化进 session。
   */
  drainNextTurn(resume?: DeferredRunResults): DrainNextTurnResult {
    const diagnostics: QueueDrainDiagnostic[] = [];
    const messages: AgentMessage[] = [];

    // 1) 会话历史：仅在首个回合注入一次，之后置位避免重复。
    if (!this.sessionDrained) {
      const drained = this.sessionQueue.drain();
      this.sessionDrained = true;
      messages.push(...drained);
      diagnostics.push({ queue: 'session', count: drained.length });
    } else {
      diagnostics.push({ queue: 'session', count: 0 });
    }

    // 2) 延迟项恢复：对历史中已有的 tool-call 只补 tool-result，避免重复
    // assistant tool-call 造成 AI SDK 再次判定缺失 tool-result。
    const recovery = this.createRecoveryMessages(
      resume,
      collectToolCallIds(messages),
    );
    messages.push(...recovery);
    diagnostics.push({ queue: 'deferred', count: recovery.length });

    // 3) 依次抽取输入、引导、后续提问（后两者逐条推进）。
    for (const [queue, drained] of [
      ['input', this.inputQueue.drain()],
      ['steering', this.steeringQueue.drain()],
      ['follow-up', this.followUpQueue.drain()],
    ] as const) {
      messages.push(...drained);
      diagnostics.push({ queue, count: drained.length });
    }

    return { messages, diagnostics };
  }

  /** 拍下完整排队/状态快照（用于子运行隔离或回滚）。 */
  snapshot(): AgentRunControlSnapshot {
    return {
      status: this.status,
      interrupted: this.interrupted,
      input: this.inputQueue.snapshot(),
      session: this.sessionQueue.snapshot(),
      followUp: this.followUpQueue.snapshot(),
      steering: this.steeringQueue.snapshot(),
      deferred: this.deferredQueue.snapshot(),
      sessionDrained: this.sessionDrained,
    };
  }

  /** 从快照整体恢复排队/状态。 */
  restore(snapshot: AgentRunControlSnapshot): void {
    this.status = snapshot.status;
    this.interrupted = snapshot.interrupted;
    this.inputQueue.restore(snapshot.input);
    this.sessionQueue.restore(snapshot.session);
    this.followUpQueue.restore(snapshot.followUp);
    this.steeringQueue.restore(snapshot.steering);
    this.deferredQueue.restore(snapshot.deferred);
    this.sessionDrained = snapshot.sessionDrained;
  }

  /**
   * 把延迟项重建为可喂给模型的消息序列，用于恢复被中止的回合。
   *
   * 对每类延迟项：
   * - `approval`：批准则携带补跑出的工具结果（缺省回退为 `{ approved: true }`），
   *   拒绝则生成「执行被拒」输出；二者都先补一条对应的 tool-call 消息再补 tool 结果，
   *   以维持模型期望的「调用-结果」配对。
   * - `tool-call`：同样补出 tool-call + tool 结果（取 `toolResults` 中的输出）。
   * - 其他（如中断快照）：直接展开其携带的原始消息。
   */
  private createRecoveryMessages(
    resume?: DeferredRunResults,
    existingToolCallIds: ReadonlySet<string> = new Set(),
  ): AgentMessage[] {
    if (resume === undefined) {
      return [];
    }
    // 调用方显式给出延迟项时，以其为准覆盖队列现状。
    if (resume.deferred !== undefined) {
      this.deferredQueue.restore(resume.deferred);
    }
    validateResumeToolResults(
      this.deferredQueue.snapshot(),
      resume.toolResults ?? {},
    );
    const messages: AgentMessage[] = [];
    for (const item of this.deferredQueue.drain()) {
      if (item.kind === 'approval') {
        // 解析审批决定，决定取真实工具结果还是「被拒」输出。
        const decision = resume.approvals?.[item.toolCallId];
        const approved =
          typeof decision === 'boolean'
            ? decision
            : (decision?.approved ?? false);
        const output = approved
          ? (resume.toolResults?.[item.toolCallId] ?? { approved: true })
          : createDeniedOutput(
              typeof decision === 'object' ? decision.reason : undefined,
            );
        // 历史里没有对应 tool-call 时才补 assistant tool-call；恢复已持久化
        // 的审批运行时，历史通常已经包含该调用，只需要追加 tool-result。
        if (!existingToolCallIds.has(item.toolCallId)) {
          messages.push(
            createToolCallMessage({
              id: item.toolCallId,
              name: item.toolName,
              input: item.input,
            }),
          );
        }
        messages.push(
          createToolResultMessage(
            { id: item.toolCallId, name: item.toolName, input: item.input },
            output,
            approved ? 'success' : 'denied',
          ),
        );
        continue;
      }
      if (item.kind === 'tool-call') {
        // 已执行的延迟工具调用：按需重建调用与其结果消息对。
        if (!existingToolCallIds.has(item.toolCallId)) {
          messages.push(
            createToolCallMessage({
              id: item.toolCallId,
              name: item.toolName,
              input: item.input,
            }),
          );
        }
        messages.push(
          createToolResultMessage(
            { id: item.toolCallId, name: item.toolName, input: item.input },
            resume.toolResults?.[item.toolCallId] ?? null,
          ),
        );
        continue;
      }
      // 中断快照等：直接还原其保存的消息。
      messages.push(...item.messages);
    }
    return messages;
  }
}

function validateResumeToolResults(
  deferred: readonly DeferredRunItem[],
  toolResults: Readonly<Record<string, unknown>>,
): void {
  const ids = new Set(
    deferred
      .filter((item) => item.kind === 'approval' || item.kind === 'tool-call')
      .map((item) => item.toolCallId),
  );
  const unknown = Object.keys(toolResults).filter((id) => !ids.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Resume contains results for unknown tool calls: ${unknown.join(', ')}`,
    );
  }
  const missing = deferred
    .filter((item) => item.kind === 'tool-call')
    .map((item) => item.toolCallId)
    .filter((id) => !Object.hasOwn(toolResults, id));
  if (missing.length > 0) {
    throw new Error(
      `Resume is missing deferred tool results: ${missing.join(', ')}`,
    );
  }
}

/** 构造「执行被拒」的工具输出，可附带拒绝原因。 */
function createDeniedOutput(reason: string | undefined): unknown {
  return reason === undefined
    ? { type: 'execution-denied' }
    : { type: 'execution-denied', reason };
}
