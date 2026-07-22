/**
 * 产品 Agent 的稳定边界集中定义 Thread 请求、运行事件、运行结果、装配结果和显式函数依赖。
 *
 * Thread 只能通过本文件中的 `AgentFeature` 与一次运行交互；通用 engine 类型仅作为消息、工具和
 * 执行内核契约使用，不能把 Thread snapshot、RPC DTO 或持久化实现带入 engine。
 */
import type { SessionMode } from '../../protocol/v1/index.js';
import type { CodingAgentConfig, PermissionRule } from '../config/index.js';

import type { ContextSourceLoadResult } from './context/source-registry.js';
import type {
  Agent as EngineAgent,
  AgentEventRecorder,
  AgentMessage,
  AgentModel,
  AgentProviderOptions,
  AgentSkill,
  AgentUsage,
  AnyAgentTool,
  CreateAgentOptions,
  DeferredApprovalItem,
  DeferredToolCallItem,
  MessageCompactor,
  ModelAdapter,
  ModelInput,
  SystemSection,
} from './engine/index.js';
import type { AgentRegistry } from './subagents/registry.js';
import type { CodingAgentDefinition } from './subagents/schema.js';

export interface AgentRunSelection {
  readonly mode: SessionMode;
  readonly profile: string;
  readonly model: string;
  readonly agent: string;
}

export const PLAN_EXIT_TOOL_NAME = 'request_plan_exit';

export interface AgentRunGoal {
  readonly id: string;
  readonly objective: string;
  readonly status: 'active' | 'paused' | 'blocked' | 'complete';
  readonly tokenBudget?: number;
  readonly tokensUsed: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type AgentInteraction =
  | {
      readonly type: 'approval';
      readonly interactionId: string;
      readonly item: DeferredApprovalItem;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'toolResult';
      readonly interactionId: string;
      readonly item: DeferredToolCallItem;
      readonly occurredAt: string;
    };

export type AgentRunEvent =
  | {
      readonly type: 'messageStarted';
      readonly messageId: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'messageDelta';
      readonly messageId: string;
      readonly text: string;
    }
  | {
      readonly type: 'messageCompleted';
      readonly messageId: string;
      readonly text: string;
    }
  | {
      readonly type: 'toolStarted';
      readonly toolCallId: string;
      readonly name: string;
      readonly input: unknown;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'toolCompleted';
      readonly toolCallId: string;
      readonly output: unknown;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'toolFailed';
      readonly toolCallId: string;
      readonly message: string;
    }
  | {
      readonly type: 'interactionRequired';
      readonly interaction: AgentInteraction;
    }
  | {
      readonly type: 'contextCompacted';
      readonly beforeMessageCount: number;
      readonly afterMessageCount: number;
      readonly summary: string;
      readonly keptMessageCount: number;
      readonly tokensBefore: number;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'runFailed';
      readonly code: string;
      readonly message: string;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'messagesAppended';
      readonly messages: ReadonlyArray<AgentMessage>;
    };

export type AgentRunResult =
  | { readonly status: 'completed'; readonly usage: AgentUsage }
  | {
      readonly status: 'interrupted';
      readonly usage: AgentUsage;
      readonly reason: string;
    }
  | {
      readonly status: 'failed';
      readonly usage: AgentUsage;
      readonly error: { readonly code: string; readonly message: string };
    };

interface ResumeMode {
  readonly mode?: SessionMode;
}

export type AgentResumeResult =
  | (ResumeMode & {
      readonly type: 'approval';
      readonly interactionId: string;
      readonly approved: boolean;
      readonly reason?: string;
    })
  | (ResumeMode & {
      readonly type: 'toolResult';
      readonly interactionId: string;
      readonly result: unknown;
    })
  | {
      readonly type: 'rejected';
      readonly interactionId: string;
      readonly error: { readonly code: number; readonly message: string };
    };

export interface AgentRun {
  /** 单次运行按发生顺序发布的事实流；每个事件只消费一次。 */
  readonly events: AsyncIterable<AgentRunEvent>;
  /** 事件生产结束后兑现的唯一终态，不会早于事件流关闭。 */
  readonly result: Promise<AgentRunResult>;
  /**
   * 把运行中的用户引导加入当前 run，供下一个可执行 turn 消费。
   *
   * Args:
   * - `input`: 非空用户文本；调用方保留字符串所有权，run 按调用顺序排队。
   *
   * Returns:
   * - 输入完成入队后同步返回；run 已结束或正在关闭时直接抛错。
   */
  steer(input: string): void;
  /**
   * 请求中断当前 run，并把原因写入最终 `interrupted` 结果。
   *
   * Args:
   * - `reason`: 面向调用方的中断原因；在 run 生命周期内只记录一次。
   *
   * Returns:
   * - 取消信号发出后同步返回；终态仍通过 `result` 异步观察。
   */
  interrupt(reason: string): void;
  /**
   * 完成当前 run 唯一挂起的交互，并允许 engine 继续执行。
   *
   * Args:
   * - `result`: 与已发布 `interactionRequired` 的类型和 `interactionId` 精确匹配的结果；只消费一次。
   *
   * Returns:
   * - 挂起状态被解析并送入 run 后同步返回；错配或重复恢复直接抛错。
   */
  resume(result: AgentResumeResult): void;
}

/** Thread 启动产品 Agent 所需的完整稳定快照；运行期间不得反向修改 Thread 状态。 */
export interface AgentRunRequest {
  readonly threadId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly selection: AgentRunSelection;
  readonly history: ReadonlyArray<AgentMessage>;
  readonly input: string;
  readonly goal: AgentRunGoal | null;
  readonly permission: PermissionSessionView;
}

export interface PermissionSessionView {
  /**
   * 读取当前 run 生效的 permission rules。
   *
   * Args:
   * - 无：规则由 Thread permission session 持有。
   *
   * Returns:
   * - 返回调用时刻的只读规则快照；后续审批写入可在下一次读取时生效。
   */
  rules(): ReadonlyArray<PermissionRule>;
  /**
   * 读取当前 run 已批准访问的 workspace 外部路径。
   *
   * Args:
   * - 无：路径集合由 Thread permission session 持有。
   *
   * Returns:
   * - 返回调用时刻的只读路径快照；调用方不能修改底层批准集合。
   */
  externalPaths(): ReadonlyArray<string>;
}

export interface BuiltAgent {
  readonly engine: EngineAgent;
  readonly maxTurns: number;
  /**
   * 更新工具执行读取的 session mode。
   *
   * Args:
   * - `mode`: 下一次工具选择和 permission 判断使用的闭合模式值。
   *
   * Returns:
   * - mode reader 更新后同步返回，不修改已经完成的工具调用。
   */
  setMode(mode: SessionMode): void;
  /**
   * 按逆序关闭 engine 与 tracing 等该 run 装配产生的资源。
   *
   * Args:
   * - 无：资源集合在 `buildAgent()` 返回前已经固定。
   *
   * Returns:
   * - Promise 在全部资源完成释放后兑现；重复调用复用同一次关闭结果。
   *
   * Throws:
   * - 任一资源关闭失败时拒绝，并保留该资源的原始错误。
   */
  close(): Promise<void>;
}

export interface AgentFeature {
  /**
   * 为一次稳定请求启动独立 Agent run，并把事件流与最终结果的观察权交给调用方。
   *
   * Args:
   * - `input`: Thread 投影出的稳定请求；history、selection、goal 和 permission 在边界完整提供。
   *
   * Returns:
   * - Promise 在产品能力和 engine 完成装配后兑现为独立 `AgentRun`；此时执行已经启动。
   *
   * Throws:
   * - definition、model、tool 或 tracing 装配失败时直接拒绝，不返回部分 run。
   */
  startRun(input: AgentRunRequest): Promise<AgentRun>;
  /**
   * 关闭 feature 创建但尚未释放的全部 run 资源。
   *
   * Args:
   * - 无：active run 集合由 feature 内部持有。
   *
   * Returns:
   * - Promise 在已登记 run 全部停止并释放后兑现；此后 `startRun()` 直接失败。
   *
   * Throws:
   * - 任一 run 关闭失败时拒绝，并保留原始资源错误。
   */
  close(): Promise<void>;
}

export interface AgentCheckpoints {
  /**
   * 从一次成功工具调用中提取并暂存文件改动。
   *
   * Args:
   * - `input`: 工具运行目录、调用 ID 与结构化输出；仅包含有效 `fileChanges` 时才产生暂存状态。
   *
   * Returns:
   * - 所有有效改动按工具调用顺序写入当前 open checkpoint 后返回。
   */
  record(input: {
    readonly cwd: string;
    readonly toolCallId: string;
    readonly output: unknown;
  }): void;
  /**
   * 把当前 run 累积的文件改动封存为 durable checkpoint。
   *
   * Args:
   * - `runId`: 归属本批改动的稳定 run ID；用于建立 checkpoint owner 关系。
   *
   * Returns:
   * - Promise 在 checkpoint 元数据和 artifact owner 关系提交后兑现；没有改动时不创建空记录。
   */
  seal(runId: string): Promise<void>;
}

/**
 * 为一个 Agent run 创建独立的 checkpoint 累积器。
 *
 * Args:
 * - 无：持久化依赖由 factory 闭包显式捕获。
 *
 * Returns:
 * - 返回仅归当前 run 使用的 `AgentCheckpoints`，其 pending changes 不与其他 run 共享。
 */
export type CreateAgentCheckpoints = () => AgentCheckpoints;

export interface AgentTracing {
  readonly eventRecorder?: AgentEventRecorder;
  /**
   * 刷新并关闭该 run 的 tracing recorder。
   *
   * Args:
   * - 无：recorder 与 exporter 由该 tracing runtime 持有。
   *
   * Returns:
   * - Promise 在待发送 span 完成 flush 且 exporter 关闭后兑现。
   *
   * Throws:
   * - flush 或 exporter 关闭失败时拒绝，并保留底层错误。
   */
  close(): Promise<void>;
}

/**
 * 为指定 Thread 创建一次 run 使用的 tracing runtime。
 *
 * Args:
 * - `input`: 已解析配置和稳定 `threadId`；配置决定是否提供 `eventRecorder`。
 *
 * Returns:
 * - 返回拥有 recorder 与关闭职责的 `AgentTracing`；关闭权转移给 `BuiltAgent`。
 */
export type CreateAgentTracing = (input: {
  readonly config: CodingAgentConfig;
  readonly threadId: string;
}) => AgentTracing;

export interface AgentCompactorInput {
  readonly config: CodingAgentConfig;
  readonly profileName: string;
  readonly contextWindow: number;
  readonly agentRegistry: AgentRegistry;
}

/**
 * 创建单次运行使用的上下文压缩器。
 *
 * Args:
 * - `input`: 已解析的配置、profile、上下文窗口和当前 agent registry。
 *
 * Returns:
 * - 返回与当前 run 生命周期一致的压缩端口。
 */
export type CreateAgentCompactor = (
  input: AgentCompactorInput,
) => MessageCompactor;

export interface ResolvedAgentDefinition {
  readonly config: CodingAgentConfig;
  readonly definition: CodingAgentDefinition;
  readonly agentRegistry: AgentRegistry;
}

export interface ResolvedAgentModel {
  readonly modelRef: string;
  readonly model: AgentModel;
  readonly modelAdapter: ModelAdapter;
  readonly modelSettings: NonNullable<CreateAgentOptions['modelSettings']>;
  readonly contextWindow: number;
  /**
   * 读取当前 model role 对应的 provider options。
   *
   * Args:
   * - 无：provider 与 role 已在 model resolution 阶段固定。
   *
   * Returns:
   * - 返回 provider 原生选项；该 role 没有选项时显式返回 `undefined`。
   */
  readonly providerOptions: () => AgentProviderOptions | undefined;
  /**
   * 在调用 provider 前应用该 runtime model 唯一的输入转换。
   *
   * Args:
   * - `input`: engine 已完成预算与 cache layout 的模型输入；转换不得修改原对象。
   *
   * Returns:
   * - Promise 兑现为 provider 可接受的新 `ModelInput`；不会写入 Thread 或 engine 状态。
   */
  readonly prepareModelInput: (input: ModelInput) => Promise<ModelInput>;
}

export interface AgentMemoryContextLoader {
  /**
   * 加载该 run 的 system prompt 使用的 Memory context source。
   *
   * Args:
   * - 无：Memory root 和筛选规则已在 loader 创建时固定。
   *
   * Returns:
   * - Promise 在 Memory 文件读取和解析完成后兑现为显式 load result。
   *
   * Throws:
   * - Memory 文件缺失、格式非法或读取失败时直接拒绝。
   */
  load(): Promise<ContextSourceLoadResult>;
}

export interface AgentRunContextParts {
  readonly skills: ReadonlyArray<AgentSkill>;
  readonly activationTool: AnyAgentTool;
  /**
   * 读取工具与 Skill 在当前 run 可见的根目录。
   *
   * Args:
   * - 无：workspace root 与动态批准路径由 context runtime 持有。
   *
   * Returns:
   * - 返回调用时刻的只读路径快照，workspace root 始终位于稳定位置。
   *
   * Throws:
   * - 读取动态 permission view 失败时直接抛错。
   */
  readRoots(): ReadonlyArray<string>;
  /**
   * 按稳定 cache 顺序组装当前 run 的 system sections。
   *
   * Args:
   * - `input`: 可选 Memory loader、必需 Goal section 与可选工具路由说明；调用期间只读。
   *
   * Returns:
   * - 返回完成排序的只读 section 集合；稳定内容先于动态内容排列。
   *
   * Throws:
   * - 必需 section 缺失或 source 构造失败时直接抛错。
   */
  createSystemSections(input: {
    readonly memoryIndexLoader?: AgentMemoryContextLoader;
    readonly goalSystemSection: SystemSection;
    readonly routingInstructions?: string;
  }): ReadonlyArray<SystemSection>;
}

export interface AgentRunTools {
  readonly executionTools: ReadonlyArray<AnyAgentTool>;
  readonly modelTools: ReadonlyArray<AnyAgentTool>;
  readonly memoryIndexLoader?: AgentMemoryContextLoader;
  readonly goalSystemSection: SystemSection;
  readonly routingInstructions?: string;
  /**
   * 更新 execution tools 动态读取的 session mode。
   *
   * Args:
   * - `mode`: 下一次 permission 与工具执行使用的闭合模式值。
   *
   * Returns:
   * - mode state 更新后同步返回，不重建现有工具定义。
   */
  setMode(mode: SessionMode): void;
}

/**
 * 解析运行请求选中的产品 Agent definition 与可用 subagent registry。
 *
 * Args:
 * - `request`: Thread 提供的完整运行请求；只读取 agent/profile 选择和工作目录。
 *
 * Returns:
 * - Promise 兑现为同源配置、definition 和 registry；三者在该 run 内保持稳定。
 */
export type ResolveAgentDefinition = (
  request: AgentRunRequest,
) => Promise<ResolvedAgentDefinition>;

/**
 * 根据已解析 definition 选择并构造该 run 的 runtime model。
 *
 * Args:
 * - `input`: 稳定运行请求与 definition 结果；不得重新加载另一份配置。
 *
 * Returns:
 * - Promise 兑现为 model、adapter、settings、context window 与输入转换的单一组合。
 */
export type ResolveAgentModel = (input: {
  readonly request: AgentRunRequest;
  readonly definition: ResolvedAgentDefinition;
}) => Promise<ResolvedAgentModel>;

/**
 * 加载该 run 所需的 Skill、system section 与动态读取能力。
 *
 * Args:
 * - `input`: 同一次请求得到的 definition 和 model；调用期间只读且不得跨 run 复用可变资源。
 *
 * Returns:
 * - Promise 兑现为当前 run 独占的 context parts；资源所有权由其返回契约表达。
 */
export type LoadAgentContext = (input: {
  readonly request: AgentRunRequest;
  readonly definition: ResolvedAgentDefinition;
  readonly model: ResolvedAgentModel;
}) => Promise<AgentRunContextParts>;

/**
 * 为该 run 创建 execution tools、model-visible tools 与 mode reader。
 *
 * Args:
 * - `input`: 同一次请求的 definition 与 context；工具不得持有整个 app composition root。
 *
 * Returns:
 * - Promise 兑现为工具集合及其动态依赖；execution/model 两组工具顺序在 run 内稳定。
 */
export type CreateAgentTools = (input: {
  readonly request: AgentRunRequest;
  readonly definition: ResolvedAgentDefinition;
  readonly context: AgentRunContextParts;
}) => Promise<AgentRunTools>;

export interface CreateAgentFeatureInput {
  readonly createCheckpoints: CreateAgentCheckpoints;
  readonly resolveDefinition: ResolveAgentDefinition;
  readonly resolveModel: ResolveAgentModel;
  readonly loadContext: LoadAgentContext;
  readonly createTools: CreateAgentTools;
  readonly createCompactor: CreateAgentCompactor;
  readonly createTracing: CreateAgentTracing;
}
