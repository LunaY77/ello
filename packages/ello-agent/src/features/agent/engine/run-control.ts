/**
 * 运行控制与消息排队中枢。
 *
 * 一次运行的输入并非只有最初的 prompt，还包括会话历史、运行中追加的引导
 * （steering）、后续提问（follow-up），以及审批/中断产生的延迟项。本模块用一组
 * 语义各异的队列把这些来源统一管理，并在每个回合开始时按固定顺序「抽干」成当回合
 * 的消息序列；同时维护运行状态（运行中/待审批/已中断），供回合循环判定去留。
 */
import { modelMessageSchema } from 'ai';
import { z } from 'zod';

import type {
  DeferredRunItem,
  DeferredRunResults,
  QueueDrainDiagnostic,
} from './contracts.js';
import { normalizeAgentError } from './errors.js';
import type { AgentMessage } from './model.js';
import type {
  AgentMessageQueue,
  AgentMessageQueueMode,
  AgentRunControlStatus,
  RunState,
} from './run-state.js';
import {
  collectToolCallIds,
  createToolCallMessage,
  createToolResultMessage,
} from './tools.js';

const DeferredRunItemSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('approval'),
      toolCallId: z.string().min(1),
      toolName: z.string().min(1),
      input: z.unknown().optional(),
      reason: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool-call'),
      toolCallId: z.string().min(1),
      toolName: z.string().min(1),
      input: z.unknown().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('interrupted'),
      messages: z.array(modelMessageSchema),
      reason: z.string().optional(),
    })
    .strict(),
]);
const ApprovalDecisionSchema = z.union([
  z.boolean(),
  z.object({ approved: z.boolean(), reason: z.string().optional() }).strict(),
]);
const DefinedToolResultSchema = z
  .unknown()
  .refine((value) => value !== undefined, 'Tool result must be defined.');
const DeferredRunResultsSchema = z
  .object({
    deferred: z.array(DeferredRunItemSchema).readonly().optional(),
    approvals: z.record(z.string().min(1), ApprovalDecisionSchema).optional(),
    toolResults: z
      .record(z.string().min(1), DefinedToolResultSchema)
      .optional(),
  })
  .strict();

/**
 * 在 resume 唯一入口校验 deferred items、审批决定和外部工具结果。
 *
 * Args:
 * - `value`: 宿主传回的外部 resume 数据；进入本函数前不信任其 TypeScript 标注。
 *
 * Returns:
 * - 返回从 Zod schema 投影出的 `DeferredRunResults`，消息与对象不复用外部可变引用。
 *
 * Throws:
 * - 字段缺失、出现未知字段、消息非法或工具结果为 `undefined` 时直接抛出 Zod 错误。
 */
function parseDeferredRunResults(value: unknown): DeferredRunResults {
  const parsed = DeferredRunResultsSchema.parse(value);
  const deferred = parsed.deferred?.map((item): DeferredRunItem => {
    switch (item.kind) {
      case 'approval':
        return {
          kind: item.kind,
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          ...(item.input === undefined ? {} : { input: item.input }),
          ...(item.reason === undefined ? {} : { reason: item.reason }),
          ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
        };
      case 'tool-call':
        return {
          kind: item.kind,
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          ...(item.input === undefined ? {} : { input: item.input }),
        };
      case 'interrupted':
        return {
          kind: item.kind,
          messages: [...item.messages],
          ...(item.reason === undefined ? {} : { reason: item.reason }),
        };
      default:
        item satisfies never;
        throw new Error(`Unsupported deferred item: ${String(item)}`);
    }
  });
  const approvals:
    | Record<
        string,
        boolean | { readonly approved: boolean; readonly reason?: string }
      >
    | undefined =
    parsed.approvals === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(parsed.approvals).map(([toolCallId, decision]) => [
            toolCallId,
            typeof decision === 'boolean'
              ? decision
              : {
                  approved: decision.approved,
                  ...(decision.reason === undefined
                    ? {}
                    : { reason: decision.reason }),
                },
          ]),
        );
  return {
    ...(deferred === undefined ? {} : { deferred }),
    ...(approvals === undefined ? {} : { approvals }),
    ...(parsed.toolResults === undefined
      ? {}
      : { toolResults: parsed.toolResults }),
  };
}

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

  /**
   * 创建 `DefaultAgentMessageQueue`，由该实例独占 产品 Agent Agent engine 运行控制 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `mode`: 决定控制流的闭合状态值；未声明的 variant 必须在边界失败。
   */
  constructor(readonly mode: AgentMessageQueueMode = 'all') {}

  /**
   * 当前队列长度。
   *
   * Returns:
   * - 返回 产品 Agent Agent engine 运行控制 模块 当前持有的只读视图，不触发状态转换。
   */
  get size(): number {
    return this.items.length;
  }

  /**
   * 队列是否非空。
   *
   * Returns:
   * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
   */
  get hasItems(): boolean {
    return this.items.length > 0;
  }

  /**
   * 入队一条消息。
   *
   * Args:
   * - `item`: 要由 `push` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - 产品 Agent Agent engine 运行控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  push(item: T): void {
    this.items.push(item);
  }

  /**
   * 按 `mode` 抽取消息：`one-at-a-time` 取队首一条，否则取出全部。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  drain(): T[] {
    if (this.items.length === 0) {
      return [];
    }
    if (this.mode === 'one-at-a-time') {
      return this.items.splice(0, 1);
    }
    return this.items.splice(0);
  }

  /**
   * 清空队列。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 产品 Agent Agent engine 运行控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  clear(): void {
    this.items.splice(0);
  }

  /**
   * 拷贝当前队列内容（不改变队列本身）。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
   */
  snapshot(): T[] {
    return [...this.items];
  }

  /**
   * 用给定内容整体替换队列（配合 `snapshot` 实现保存/恢复）。
   *
   * Args:
   * - `items`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
   *
   * Returns:
   * - 产品 Agent Agent engine 运行控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
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

  /**
   * 创建 `AgentRunControl`，由该实例独占 产品 Agent Agent engine 运行控制 模块 中声明的可变状态和资源生命周期。
   *
   * Args:
   * - `runId`: 目标对象的稳定标识；用于定位唯一状态，未知标识直接失败。
   */
  constructor(readonly runId: string) {}

  /**
   * 入队一条初始输入消息。
   *
   * Args:
   * - `message`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
   *
   * Returns:
   * - 产品 Agent Agent engine 运行控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  pushInput(message: AgentMessage): void {
    this.inputQueue.push(message);
  }

  /**
   * 入队一条后续提问。
   *
   * Args:
   * - `message`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
   *
   * Returns:
   * - 产品 Agent Agent engine 运行控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  pushFollowUp(message: AgentMessage): void {
    this.followUpQueue.push(message);
  }

  /**
   * 入队一条运行中引导消息。
   *
   * Args:
   * - `message`: 调用方提供的不可变文本内容；函数不会用空字符串掩盖缺失输入。
   *
   * Returns:
   * - 产品 Agent Agent engine 运行控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
  pushSteering(message: AgentMessage): void {
    this.steeringQueue.push(message);
  }

  /**
   * 入队一个延迟项，并据其类型联动更新运行状态。
   *
   * Args:
   * - `item`: 要由 `pushDeferred` 读取或写入的单个领域值；所有权仍归调用方。
   *
   * Returns:
   * - 产品 Agent Agent engine 运行控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
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

  /**
   * 是否还有待处理的排队消息（会话历史只在未抽取时计入）。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
   */
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
   *
   * Args:
   * - `resume`: 用于完成唯一待处理操作的结果；同一结果不得重复消费。
   *
   * Returns:
   * - 返回 `drainNextTurn` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  drainNextTurn(resume?: DeferredRunResults): DrainNextTurnResult {
    const parsedResume =
      resume === undefined ? undefined : parseDeferredRunResults(resume);
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
      parsedResume,
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

  /**
   * 拍下完整排队/状态快照（用于子运行隔离或回滚）。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - 返回 `snapshot` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
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

  /**
   * 从快照整体恢复排队/状态。
   *
   * Args:
   * - `snapshot`: `restore` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - 产品 Agent Agent engine 运行控制 模块 的同步状态变更完成后返回，不产生业务结果。
   */
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
   * - `approval`：批准时必须存在补跑后的真实工具结果，拒绝时生成明确的「执行被拒」输出；
   *   二者都先补一条对应的 tool-call 消息再补 tool result，以维持模型要求的调用-结果配对。
   * - `tool-call`：同样补出 tool-call + tool 结果（取 `toolResults` 中的输出）。
   * - 其他（如中断快照）：直接展开其携带的原始消息。
   *
   * Args:
   * - `resume`: 已校验的恢复数据；缺失表示当前 turn 不消费 deferred queue。
   * - `existingToolCallIds`: 历史消息中已经存在的 assistant tool-call ID。
   *
   * Returns:
   * - 返回按 deferred queue 顺序生成的恢复消息，并消费对应队列项。
   *
   * Throws:
   * - resume 引用不完整、结果缺失或消息工厂无法构造配对消息时直接抛错。
   */
  private createRecoveryMessages(
    resume: DeferredRunResults | undefined,
    existingToolCallIds: ReadonlySet<string>,
  ): AgentMessage[] {
    if (resume === undefined) {
      return [];
    }
    // 调用方显式给出延迟项时，以其为准覆盖队列现状。
    if (resume.deferred !== undefined) {
      this.deferredQueue.restore(resume.deferred);
    }
    const deferred = this.deferredQueue.snapshot();
    validateResumeReferences(deferred, resume);
    const messages: AgentMessage[] = [];
    for (const item of this.deferredQueue.drain()) {
      if (item.kind === 'approval') {
        const decision = requireApprovalDecision(
          resume.approvals,
          item.toolCallId,
        );
        const approved =
          typeof decision === 'boolean' ? decision : decision.approved;
        const output = approved
          ? requireToolResult(resume.toolResults, item.toolCallId)
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
            requireToolResult(resume.toolResults, item.toolCallId),
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

/**
 * 校验 resume 中的结果键与 deferred tool call 集合完全对应。
 *
 * Args:
 * - `deferred`: 当前 run 等待恢复的延迟项快照。
 * - `resume`: 已通过 schema 的审批决定和工具结果映射。
 *
 * Returns:
 * - 所有引用已知且必需结果齐全时返回，不修改输入。
 *
 * Throws:
 * - 出现未知 tool call ID、缺少工具结果或审批决定时直接抛错。
 */
function validateResumeReferences(
  deferred: readonly DeferredRunItem[],
  resume: DeferredRunResults,
): void {
  const ids = new Set(
    deferred
      .filter((item) => item.kind === 'approval' || item.kind === 'tool-call')
      .map((item) => item.toolCallId),
  );
  const resultIds =
    resume.toolResults === undefined ? [] : Object.keys(resume.toolResults);
  const approvalIds =
    resume.approvals === undefined ? [] : Object.keys(resume.approvals);
  const unknown = [...resultIds, ...approvalIds].filter((id) => !ids.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Resume contains data for unknown tool calls: ${unknown.join(', ')}`,
    );
  }
  const missing = deferred
    .filter((item) => item.kind === 'tool-call')
    .map((item) => item.toolCallId)
    .filter(
      (id) =>
        resume.toolResults === undefined ||
        !Object.hasOwn(resume.toolResults, id),
    );
  if (missing.length > 0) {
    throw new Error(
      `Resume is missing deferred tool results: ${missing.join(', ')}`,
    );
  }
  for (const item of deferred) {
    if (item.kind === 'approval') {
      requireApprovalDecision(resume.approvals, item.toolCallId);
    }
  }
}

/**
 * 读取指定 tool call 的必需审批决定。
 *
 * Args:
 * - `approvals`: resume 携带的审批决定映射。
 * - `toolCallId`: 当前 approval item 的稳定调用 ID。
 *
 * Returns:
 * - 返回布尔决定或带原因的结构化决定。
 *
 * Throws:
 * - 映射缺失、键不存在或值为 `undefined` 时直接抛错。
 */
function requireApprovalDecision(
  approvals: DeferredRunResults['approvals'],
  toolCallId: string,
): NonNullable<DeferredRunResults['approvals']>[string] {
  if (approvals === undefined || !Object.hasOwn(approvals, toolCallId)) {
    throw new Error(`Resume is missing approval decision: ${toolCallId}`);
  }
  const decision = approvals[toolCallId];
  if (decision === undefined) {
    throw new Error(`Resume approval decision is undefined: ${toolCallId}`);
  }
  return decision;
}

/**
 * 读取指定 deferred tool call 的必需结果。
 *
 * Args:
 * - `toolResults`: resume 携带的外部或已批准执行结果映射。
 * - `toolCallId`: 当前 tool-call item 的稳定调用 ID。
 *
 * Returns:
 * - 返回调用方显式提供的结果；`null` 是有效结果。
 *
 * Throws:
 * - 映射缺失、键不存在或结果为 `undefined` 时直接抛错。
 */
function requireToolResult(
  toolResults: DeferredRunResults['toolResults'],
  toolCallId: string,
): unknown {
  if (toolResults === undefined || !Object.hasOwn(toolResults, toolCallId)) {
    throw new Error(`Resume is missing tool result: ${toolCallId}`);
  }
  const result = toolResults[toolCallId];
  if (result === undefined) {
    throw new Error(`Resume tool result is undefined: ${toolCallId}`);
  }
  return result;
}

/**
 * 构造模型可观察的工具拒绝结果。
 *
 * Args:
 * - `reason`: 宿主提供的可选拒绝原因；缺失时只返回稳定的拒绝类型。
 *
 * Returns:
 * - 返回不会与成功工具输出混淆的结构化对象。
 */
function createDeniedOutput(reason: string | undefined): unknown {
  return reason === undefined
    ? { type: 'execution-denied' }
    : { type: 'execution-denied', reason };
}

/**
 * 校验并准备一次 resume，把已批准但尚未执行的工具调用补成真实结果。
 *
 * Args:
 * - `run`: 新 run 的 scheduler、事件发布器和当前 turn 状态。
 * - `resume`: 宿主返回的 deferred items、审批决定和外部工具结果。
 *
 * Returns:
 * - 返回补齐已批准工具结果后的 resume 数据；没有 resume 时返回 `undefined`。
 *
 * Throws:
 * - resume schema 非法、引用不完整、已批准工具再次请求审批或执行失败时直接拒绝。
 */
export async function prepareResume(
  run: RunState,
  resume: DeferredRunResults | undefined,
): Promise<DeferredRunResults | undefined> {
  if (resume === undefined) return undefined;
  const parsedResume = parseDeferredRunResults(resume);
  if (parsedResume.deferred === undefined) return parsedResume;
  validateResumeReferences(parsedResume.deferred, parsedResume);
  const approvalItems = parsedResume.deferred.filter(
    (item): item is Extract<DeferredRunItem, { kind: 'approval' }> =>
      item.kind === 'approval',
  );
  if (approvalItems.length === 0) return parsedResume;
  const toolResults: Record<string, unknown> = {};
  if (parsedResume.toolResults !== undefined) {
    Object.assign(toolResults, parsedResume.toolResults);
  }
  for (const item of approvalItems) {
    const decision = requireApprovalDecision(
      parsedResume.approvals,
      item.toolCallId,
    );
    const approved =
      typeof decision === 'boolean' ? decision : decision.approved;
    if (!approved) {
      const reason = typeof decision === 'object' ? decision.reason : undefined;
      await run.events.emit({
        type: 'tool.failed',
        turnIndex: run.state.turn,
        toolCallId: item.toolCallId,
        error: normalizeAgentError(
          new Error(
            reason ?? `Tool '${item.toolName}' was denied by the user.`,
          ),
        ),
      });
      continue;
    }
    if (Object.hasOwn(toolResults, item.toolCallId)) continue;
    const result = await run.toolScheduler.executeApproved(
      { id: item.toolCallId, name: item.toolName, input: item.input },
      {
        onToolStarted: (toolCallId, name, input) =>
          run.events.emit({
            type: 'tool.started',
            turnIndex: run.state.turn,
            toolCallId,
            name,
            input,
          }),
        onApprovalRequired: () => {
          throw new Error(
            `Approved tool '${item.toolName}' requested approval again.`,
          );
        },
        onToolDeferred: () => {
          throw new Error(
            `Approved tool '${item.toolName}' became deferred during execution.`,
          );
        },
        onToolCompleted: (toolCallId, output) =>
          run.events.emit({
            type: 'tool.completed',
            turnIndex: run.state.turn,
            toolCallId,
            output,
          }),
        onToolFailed: (toolCallId, error) =>
          run.events.emit({
            type: 'tool.failed',
            turnIndex: run.state.turn,
            toolCallId,
            error: normalizeAgentError(error),
          }),
      },
    );
    toolResults[item.toolCallId] =
      result.error === undefined
        ? result.output
        : { error: result.error.message };
  }
  return { ...parsedResume, toolResults };
}
