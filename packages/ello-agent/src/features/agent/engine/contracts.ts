/**
 * 通用 Agent engine 的公开契约集中定义运行输入、环境端口、资源生命周期、stream 与 deferred resume。
 *
 * engine 只依赖本文件中的小型能力接口，不知道 Thread、JSON-RPC、产品配置或持久化实现。
 * 每次 run 拥有独立 context、取消信号和 stream；environment/resource 必须显式 setup 并按逆序 close。
 */
import type {
  AgentEventRecorder,
  AgentObserver,
  EngineEvent,
  MessageCompactor,
} from './events.js';
import type {
  AgentMessage,
  AgentModel,
  AgentModelSettings,
  MessageTransform,
  ModelAdapter,
  ModelInputDiagnostics,
  PrepareModelInput,
  ProviderOptionsResolver,
  SystemSection,
  MaybePromise,
} from './model.js';
import type { AgentToolCall, AnyAgentTool } from './tools.js';

export interface AgentFileSystem {
  /**
   * 把环境可见路径解析为通过权限校验的绝对路径。
   *
   * Args:
   * - `path`: 用户或工具提供的路径；实现负责相对 cwd 解析并校验允许根。
   *
   * Returns:
   * - 返回规范绝对路径；越界路径不会返回伪造结果。
   *
   * Throws:
   * - 路径越界、格式非法或无法规范化时直接抛错。
   */
  resolvePath(path: string): string;
  /**
   * 读取通过权限校验的路径状态。
   *
   * Args:
   * - `path`: 用户或工具提供的路径；实现必须先应用与读写相同的路径边界。
   *
   * Returns:
   * - Promise 兑现为只暴露目录判定的状态视图。
   *
   * Throws:
   * - 路径越界、不存在或底层状态读取失败时直接拒绝。
   */
  stat(path: string): Promise<AgentFileSystemStat>;
  /**
   * 读取一个 engine 可访问路径的 UTF-8 文本。
   *
   * Args:
   * - `path`: 已由产品环境解释的文件路径；实现负责校验访问边界和文件存在性。
   *
   * Returns:
   * - Promise 在完整文本读取完成后兑现；不会用空字符串代替缺失文件。
   *
   * Throws:
   * - 路径越界、目标不存在或读取失败时直接拒绝。
   */
  readText(path: string): Promise<string>;
  /**
   * 把完整 UTF-8 文本写入一个 engine 可访问路径。
   *
   * Args:
   * - `path`: 已由产品环境解释的目标路径；实现负责校验写入边界。
   * - `content`: 要完整写入的不可变文本；空字符串代表显式清空文件。
   *
   * Returns:
   * - Promise 在写入完成后兑现，不返回业务值。
   *
   * Throws:
   * - 路径越界、目录缺失或写入失败时直接拒绝。
   */
  writeText(path: string, content: string): Promise<void>;
  /**
   * 列出一个 engine 可访问目录中的直接子项。
   *
   * Args:
   * - `path`: 已由产品环境解释的目录路径；实现负责校验访问边界。
   *
   * Returns:
   * - Promise 兑现为目录项名称快照；调用方不能借此修改文件系统状态。
   */
  listDir(path: string): Promise<string[]>;
  /**
   * 读取文件系统端口希望注入模型上下文的稳定说明。
   *
   * Args:
   * - 无：说明由端口实现已经持有的根目录与能力决定。
   *
   * Returns:
   * - 返回文本或 Promise；没有说明时显式返回 `null`。
   */
  getContextInstructions?(): MaybePromise<string | null>;
  /**
   * 释放文件系统端口持有的 watcher、句柄或临时资源。
   *
   * Args:
   * - 无：仅释放该端口明确拥有的资源。
   *
   * Returns:
   * - 返回值或 Promise 在资源释放完成后兑现。
   *
   * Throws:
   * - 任一资源释放失败时直接抛错或拒绝。
   */
  close?(): MaybePromise<void>;
}

export interface AgentFileSystemStat {
  /**
   * 判断已读取路径是否为目录。
   *
   * Args:
   * - 无：判断只读取当前 stat 对象已经持有的文件系统元数据。
   *
   * Returns:
   * - 目录返回 `true`，其他文件系统对象返回 `false`。
   */
  isDirectory(): boolean;
}

export interface AgentShellResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface AgentShell {
  /**
   * 执行一条 shell command，并完整收集退出码、stdout 与 stderr。
   *
   * Args:
   * - `command`: 要交给 shell 的完整命令文本；空命令属于非法输入。
   * - `options`: 当前命令的可选执行约束；`cwd` 是工作目录，`timeout` 单位为毫秒，`env` 是显式环境变量覆盖。
   *
   * Returns:
   * - Promise 在子进程退出且输出流读取完成后兑现为 `AgentShellResult`。
   *
   * Throws:
   * - 进程无法启动、超时或输出收集失败时直接拒绝。
   */
  run(
    command: string,
    options?: {
      readonly cwd?: string;
      readonly timeout?: number;
      readonly env?: Record<string, string>;
    },
  ): Promise<AgentShellResult>;
  /**
   * 读取 shell 端口希望注入模型上下文的稳定说明。
   *
   * Args:
   * - 无：说明由 shell 实现已经持有的执行边界决定。
   *
   * Returns:
   * - 返回文本或 Promise；没有说明时显式返回 `null`。
   */
  getContextInstructions?(): MaybePromise<string | null>;
  /**
   * 停止 shell 端口拥有的子进程并释放相关句柄。
   *
   * Args:
   * - 无：仅处理该端口创建且仍存活的进程。
   *
   * Returns:
   * - 返回值或 Promise 在全部子进程终止后兑现。
   *
   * Throws:
   * - 子进程无法终止或句柄释放失败时直接抛错或拒绝。
   */
  close?(): MaybePromise<void>;
}

export interface AgentEnvironment {
  readonly fileSystem?: AgentFileSystem;
  readonly shell?: AgentShell;
  readonly resources?: AgentResourceRegistry;
  /**
   * 在 run 开始前初始化环境及其 eager resources。
   *
   * Args:
   * - `ctx`: 当前 run 的只读 context；生命周期由 engine 持有且不会跨 run 复用。
   *
   * Returns:
   * - 返回值或 Promise 在环境可供 model/tool 使用后兑现。
   */
  setup?(ctx: AgentRunContext): MaybePromise<void>;
  /**
   * 基于当前 run context 生成环境级 system instructions。
   *
   * Args:
   * - `ctx`: 已完成 setup 的当前 run context；只读使用。
   *
   * Returns:
   * - 返回文本或 Promise；环境没有附加说明时显式返回 `null`。
   */
  getInstructions?(ctx: AgentRunContext): MaybePromise<string | null>;
  /**
   * 按环境定义的顺序释放 file system、shell 与 resource registry。
   *
   * Args:
   * - 无：资源集合在环境 setup 前已经绑定。
   *
   * Returns:
   * - 返回值或 Promise 在环境拥有的全部资源关闭后兑现。
   *
   * Throws:
   * - 任一资源关闭失败时直接抛错或拒绝。
   */
  close?(): MaybePromise<void>;
}

export interface AgentResource {
  /**
   * 初始化单个资源，使其可被当前环境使用。
   *
   * Args:
   * - 无：构造参数已经固化在资源实例中。
   *
   * Returns:
   * - 返回值或 Promise 在资源进入 ready 状态后兑现。
   */
  setup?(): MaybePromise<void>;
  /**
   * 释放该资源独占的句柄和后台工作。
   *
   * Args:
   * - 无：只释放当前资源实例拥有的状态。
   *
   * Returns:
   * - 返回值或 Promise 在资源完成关闭后兑现。
   *
   * Throws:
   * - 资源关闭失败时直接抛错或拒绝。
   */
  close?(): MaybePromise<void>;
  /**
   * 读取该资源希望暴露给模型的 context instructions。
   *
   * Args:
   * - 无：只读取已经 setup 的资源状态。
   *
   * Returns:
   * - 返回文本或 Promise；资源没有说明时显式返回 `null`。
   */
  getContextInstructions?(): MaybePromise<string | null>;
}

/**
 * 延迟构造一个归指定 environment 管理的资源。
 *
 * Args:
 * - `environment`: 已绑定 registry 的同一环境对象；factory 不接管环境关闭职责。
 *
 * Returns:
 * - 返回资源或 Promise；registry 在 factory 完成后负责 setup 与 close。
 */
export type AgentResourceFactory = (
  environment: AgentEnvironment,
) => MaybePromise<AgentResource>;

export interface AgentResourceRegistry {
  /**
   * 绑定所有延迟 resource factory 将接收的 environment。
   *
   * Args:
   * - `environment`: 与该 registry 同生命周期的环境对象；只保存引用，不立即创建资源。
   *
   * Returns:
   * - 内部 environment 引用更新后同步返回。
   */
  bind?(environment: AgentEnvironment): void;
  /**
   * 按注册顺序 setup 全部 eager resources。
   *
   * Args:
   * - 无：只处理当前已经构造并登记的资源。
   *
   * Returns:
   * - 返回值或 Promise 在全部 eager resources ready 后兑现。
   */
  setupAll?(): MaybePromise<void>;
  /**
   * 登记一个已经构造、后续由 registry setup/close 的资源。
   *
   * Args:
   * - `key`: registry 内唯一且稳定的资源键；重复 key 直接失败。
   * - `resource`: 已构造资源；登记成功后其关闭责任转移给 registry。
   *
   * Returns:
   * - 资源写入注册顺序后同步返回。
   */
  register(key: string, resource: AgentResource): void;
  /**
   * 登记一个首次读取时才执行的 resource factory。
   *
   * Args:
   * - `key`: registry 内唯一且稳定的资源键；重复 key 直接失败。
   * - `factory`: 延迟构造函数；创建出的资源由 registry setup 并接管关闭责任。
   *
   * Returns:
   * - factory 写入注册顺序后同步返回，不立即构造资源。
   */
  registerFactory(key: string, factory: AgentResourceFactory): void;
  /**
   * 读取已经构造的资源，不触发 lazy factory。
   *
   * Args:
   * - `key`: 要读取的稳定资源键。
   *
   * Returns:
   * - 返回已构造资源；尚未构造或未注册时返回 `undefined`。
   */
  get(key: string): AgentResource | undefined;
  /**
   * 读取或通过已登记 factory 创建唯一资源实例。
   *
   * Args:
   * - `key`: 要解析的稳定资源键；必须已经注册资源或 factory。
   *
   * Returns:
   * - Promise 在 factory 和 resource setup 完成后兑现为唯一实例。
   */
  getOrCreate(key: string): Promise<AgentResource>;
  /**
   * 列出 eager resource 与 lazy factory 的去重 key 快照。
   *
   * Args:
   * - 无：只读取 registry 的两张注册表。
   *
   * Returns:
   * - 返回保持注册顺序的 key 数组；修改数组不会影响 registry。
   */
  keys(): string[];
  /**
   * 聚合所有已构造资源提供的 context instructions。
   *
   * Args:
   * - 无：不会为了生成说明而实例化 lazy resources。
   *
   * Returns:
   * - 返回 `<resources>` 文本或 Promise；没有内容时显式返回 `null`。
   */
  getContextInstructions?(): MaybePromise<string | null>;
  /**
   * 按注册顺序的逆序关闭全部已构造资源并清空 registry。
   *
   * Args:
   * - 无：lazy factory 未构造资源时只从 registry 移除。
   *
   * Returns:
   * - 返回值或 Promise 在全部资源关闭且注册表清空后兑现。
   *
   * Throws:
   * - 任一资源关闭失败时直接抛错或拒绝，并保留该资源错误。
   */
  closeAll?(): MaybePromise<void>;
}

export type AgentInput =
  | string
  | AgentMessage[]
  | {
      prompt?: string;
      messages?: AgentMessage[];
      context?: Record<string, unknown>;
    };

export interface AgentRunOptions {
  readonly runId?: string;
  readonly modelSettings?: AgentModelSettings;
  readonly maxTurns?: number;
  readonly signal?: AbortSignal;
  readonly metadata?: Record<string, unknown>;
  readonly context?: unknown;
  /** 仅参与当前 run 的 system 输入，不写入 transcript 或后续 session history。 */
  readonly ephemeralInstructions?: string;
  readonly resume?: DeferredRunResults;
}

export interface Agent {
  /**
   * 启动一次 run，并等待其事件流和资源收尾全部完成。
   *
   * Args:
   * - `input`: 字符串、消息序列或结构化 prompt；会在 run 创建时归一化为独立消息。
   * - `options`: 仅作用于当前 run 的 ID、model settings、turn 上限、取消信号、metadata、context、临时指令和 resume 数据。
   *
   * Returns:
   * - Promise 在 run 终态产生且环境关闭后兑现为最终 `AgentRunResult`。
   *
   * Throws:
   * - 输入非法、run 已关闭、model/tool 失败或取消时直接拒绝或返回对应终态。
   */
  run(input: AgentInput, options?: AgentRunOptions): Promise<AgentRunResult>;
  /**
   * 启动一次独立 run，并立即返回带背压的事件 stream。
   *
   * Args:
   * - `input`: 字符串、消息序列或结构化 prompt；在 stream 创建时复制并归一化。
   * - `options`: 仅作用于当前 run 的稳定选项；调用方继续拥有传入对象。
   *
   * Returns:
   * - 返回 `AgentStream`；事件按生产顺序迭代，`final` 在资源收尾完成后兑现。
   */
  stream(input: AgentInput, options?: AgentRunOptions): AgentStream;
  /**
   * 从明确的 deferred items 与结果创建一条恢复 run。
   *
   * Args:
   * - `input`: 已持久化消息和与其精确匹配的 deferred 结果；不会从产品 store 隐式加载历史。
   * - `options`: 当前恢复 run 的稳定选项；不得再携带另一份 `resume` 数据。
   *
   * Returns:
   * - 返回新的 `AgentStream`；恢复校验失败时不会创建部分 run。
   */
  resume(input: AgentResumeInput, options?: AgentRunOptions): AgentStream;
  /**
   * 关闭 Agent 稳定配置与仍由门面持有的共享资源。
   *
   * Args:
   * - 无：单次 run 资源由各自 stream 终态负责关闭。
   *
   * Returns:
   * - Promise 在门面拥有的资源释放后兑现；完成后不能再启动 run。
   *
   * Throws:
   * - 资源关闭失败时拒绝，并保留底层错误。
   */
  close(): Promise<void>;
}

export interface AgentResumeInput {
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly deferred: DeferredRunResults;
}

export interface AgentStream extends AsyncIterable<EngineEvent> {
  /** 事件生产结束并完成 run 资源关闭后兑现的唯一终态。 */
  readonly final: Promise<AgentRunResult>;
  /**
   * 把一条 steering message 加入当前 run 的下一 turn 队列。
   *
   * Args:
   * - `message`: 已满足 engine message schema 的完整消息；按调用顺序排队且只消费一次。
   *
   * Returns:
   * - 消息完成入队后同步返回；stream 已结束时直接抛错。
   */
  steer(message: AgentMessage): void;
  /**
   * 中止当前 stream 对应的 run。
   *
   * Args:
   * - `reason`: 传给取消信号和最终错误归一化的原始原因；允许显式省略。
   *
   * Returns:
   * - 取消信号发出后同步返回；终态仍通过 `final` 观察。
   */
  abort(reason?: unknown): void;
}

export interface AgentUsage {
  readonly requests: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly toolCalls: number;
}

export type AgentFinishReason =
  | 'stop'
  | 'length'
  | 'tool-calls'
  | 'approval-required'
  | 'tool-result-required'
  | 'interrupted'
  | 'no-progress'
  | 'content-filter'
  | 'error'
  | 'unknown';

export interface AgentRunResult {
  readonly id: string;
  readonly text: string;
  readonly output: string;
  readonly messages: AgentMessage[];
  readonly newMessages: AgentMessage[];
  readonly usage: AgentUsage;
  readonly finishReason: AgentFinishReason;
  readonly toolCalls: AgentToolCall[];
  readonly pending: DeferredRunItem[];
  readonly diagnostics: AgentRunDiagnostics;
  readonly compactions: ReadonlyArray<MessageCompactionReport>;
  readonly metadata: Record<string, unknown>;
}

export interface AgentError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: unknown;
}

export interface AgentRunContext<TContext = unknown> {
  readonly runId: string;
  readonly agentName: string;
  readonly sessionId?: string;
  readonly input: AgentInput;
  readonly context: TContext;
  readonly options: AgentRunOptions;
  readonly environment: AgentEnvironment;
  readonly metadata: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

export type AgentContext = AgentRunContext;

export type DeferredRunItem =
  | DeferredApprovalItem
  | DeferredToolCallItem
  | InterruptedRunItem;

export interface DeferredApprovalItem {
  readonly kind: 'approval';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input?: unknown;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface DeferredToolCallItem {
  readonly kind: 'tool-call';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input?: unknown;
}

export interface InterruptedRunItem {
  readonly kind: 'interrupted';
  readonly messages: AgentMessage[];
  readonly reason?: string;
}

export interface DeferredRunResults {
  readonly deferred?: readonly DeferredRunItem[];
  readonly approvals?: Record<
    string,
    boolean | { readonly approved: boolean; readonly reason?: string }
  >;
  readonly toolResults?: Record<string, unknown>;
}

export interface QueueDrainDiagnostic {
  readonly queue: string;
  readonly count: number;
}

export interface MessageCompactionReport {
  readonly compactor: string;
  readonly beforeMessageCount: number;
  readonly afterMessageCount: number;
  readonly summary: string;
  readonly keptMessageCount: number;
  readonly tokensBefore: number;
  readonly metadata?: Record<string, unknown>;
}

export interface AgentRunDiagnostics {
  readonly modelInput?: ModelInputDiagnostics;
  readonly turns: AgentTurnDiagnostics[];
  readonly queueDrains: QueueDrainDiagnostic[];
  readonly pendingCount: number;
  readonly resumeSource?: 'options.resume';
  readonly compactions: MessageCompactionReport[];
}

export interface AgentTurnDiagnostics {
  readonly turn: number;
  readonly modelInput?: ModelInputDiagnostics;
  readonly queueDrains: QueueDrainDiagnostic[];
  readonly finishReason: AgentFinishReason;
  readonly newMessageCount: number;
}

export interface CreateAgentOptions<TContext = unknown> {
  readonly model: AgentModel;
  readonly name?: string;
  readonly instructions?: string;
  readonly modelSettings?: AgentModelSettings;
  readonly modelAdapter: ModelAdapter;
  /** 当前 Agent 独占的运行环境；无外部能力时调用方也必须显式传入空环境。 */
  readonly environment: AgentEnvironment;
  /** 完整执行注册表；超过直连上限时同时包含目标工具和路由工具。 */
  readonly executionTools: readonly AnyAgentTool[];
  /** 模型可见工具集；由产品层决定直接暴露或切换为 tool_search/call_tool。 */
  readonly modelTools: readonly AnyAgentTool[];
  readonly observers?: readonly AgentObserver<TContext>[];
  readonly eventRecorder?: AgentEventRecorder<TContext>;
  readonly stream?: { readonly maxBufferedEvents: number };
  readonly compactor?: MessageCompactor;
  readonly metadata?: Record<string, unknown>;
  readonly sessionWindow?: { readonly maxMessages: number };
  readonly modelInputBudget?: {
    readonly maxInputTokens: number;
    readonly reservedOutputTokens?: number;
  };
  readonly modelInput?: {
    readonly systemSections?: readonly SystemSection<TContext>[];
    readonly messageTransforms?: readonly MessageTransform<TContext>[];
    readonly providerOptions?: ProviderOptionsResolver<TContext>;
    readonly prepare?: PrepareModelInput<TContext>;
  };
}
