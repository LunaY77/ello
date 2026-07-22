/**
 * 通用 Agent engine 的创建入口、公开门面与回合循环。
 *
 * `createAgent()` 在唯一构造边界校验稳定配置，`ElloAgent` 只持有跨 run 共享的模型和环境，
 * 每次 `stream()` 都创建独立 `RunState`。文件内的回合循环按“初始化 → 模型输入 → 模型调用 →
 * 工具执行 → 回合结算 → 终态”线性推进，不读取 Thread、JSON-RPC 或产品持久化状态。
 */
import type {
  Agent,
  AgentEnvironment,
  AgentInput,
  AgentResumeInput,
  AgentRunOptions,
  AgentRunResult,
  AgentStream,
  CreateAgentOptions,
} from './contracts.js';
import { closeAgentResources } from './events.js';
import { buildModelInput } from './model-input.js';
import { callModel, type ModelAdapter } from './model.js';
import {
  beginRunTurn,
  canBeginRunTurn,
  completeRunState,
  completeRunTurn,
  createRunState,
  failRunState,
  initializeRunState,
  shouldStopRun,
  type RunState,
} from './run-state.js';
import { executeToolCalls } from './tools.js';

/**
 * 创建一个尚未开始运行的通用 Agent。
 *
 * Args:
 * - `options`: 已解析的模型、环境、工具和运行策略；实例持有环境直到 `close()` 完成。
 *
 * Returns:
 * - 返回稳定的 `Agent` 门面；每次 run 拥有独立状态，调用方负责最终关闭该实例。
 *
 * Throws:
 * - 环境、模型 adapter、工具集合或压缩预算不满足创建契约时直接抛错。
 */
export function createAgent(options: CreateAgentOptions): Agent {
  assertRuntimeDependencies(options);
  assertToolCollections(options);
  if (
    options.compactor !== undefined &&
    options.modelInputBudget === undefined
  ) {
    throw new Error(
      'Message compaction requires modelInputBudget.maxInputTokens.',
    );
  }
  return new ElloAgent(options);
}

/**
 * `Agent` 接口的默认实现：provider 无关的代理循环入口。
 *
 * 持有创建时确定的不变配置（模型、工具、环境、会话存储等），每次 `run` /
 * `stream` / `resume` 都新建一个独立的运行状态来承载对应 run 的可变状态，
 * 因此同一个实例可被多次、并发地复用而互不干扰。具体的回合循环逻辑委托给
 * `runAgentLoop`，本类只负责装配与对外暴露三种触发方式。
 */
class ElloAgent implements Agent {
  /** 运行环境由创建者显式注入，并由 Agent 在 close 时释放。 */
  private readonly environment: AgentEnvironment;
  /** 模型适配器由创建者显式注入，所有 run 共享同一无会话状态边界。 */
  private readonly modelAdapter: ModelAdapter;

  /**
   * 创建 `ElloAgent` 并保存跨 run 共享的稳定配置。
   *
   * Args:
   * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
   */
  constructor(private readonly config: CreateAgentOptions) {
    this.environment = config.environment;
    this.modelAdapter = config.modelAdapter;
  }

  /**
   * 跑完一次完整运行并返回最终结果。
   *
   * 内部即 `stream` 加上「把事件流消费到底」：调用方不关心中间事件时使用，
   * 等价于 `for await ... stream` 后取 `stream.final`。
   *
   * Args:
   * - `input`: `run` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   * - `options`: 仅作用于 `run` 的调用选项；函数只读取该对象，不保留可变引用；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - Promise 在事件流结束并生成唯一终态后兑现为运行结果。
   *
   * Throws:
   * - 输入、模型、工具或资源生命周期不满足契约时直接抛错，并保留底层失败原因。
   */
  async run(
    input: AgentInput,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const stream = this.stream(input, options);
    for await (const _event of stream) {
      // 仅为驱动循环推进而消费事件，事件本身在此被丢弃
    }
    return stream.final;
  }

  /**
   * 启动一次运行并返回事件流。
   *
   * 同步返回 {@link AgentStream}，回合循环 `runAgentLoop` 在后台异步推进
   * （`void` 表示不在此处等待其 Promise）；调用方必须持续迭代 stream 取事件，
   * 并在迭代结束后读取 `stream.final`。
   *
   * Args:
   * - `input`: `stream` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   * - `options`: 仅作用于 `stream` 的调用选项；函数只读取该对象，不保留可变引用；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - 返回 `stream` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  stream(input: AgentInput, options: AgentRunOptions = {}): AgentStream {
    const run = createRunState({
      config: this.config,
      input,
      runOptions: options,
      environment: this.environment,
      modelAdapter: this.modelAdapter,
    });
    void runAgentLoop(run);
    return run.stream;
  }

  /**
   * 在审批/延迟工具调用得到决定后恢复运行。
   *
   * 不再追加新的用户输入（`messages` 为空），仅通过 `resume` 选项把延迟项与
   * 其审批结果带入新一次运行的首个回合，由此续接被卡住的那一轮。
   *
   * Args:
   * - `input`: `resume` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
   * - `options`: 仅作用于 `resume` 的调用选项；函数只读取该对象，不保留可变引用；省略时使用声明中明确的调用语义。
   *
   * Returns:
   * - 返回 `resume` 计算出的声明结果；返回值不包含未声明的兜底状态。
   */
  resume(input: AgentResumeInput, options: AgentRunOptions = {}): AgentStream {
    return this.stream(
      { messages: [...input.messages] },
      { ...options, resume: input.deferred },
    );
  }

  /**
   * 释放环境占用的资源（如关闭沙箱/子进程）。
   *
   * Args:
   * - 无：操作使用实例或闭包已经持有的稳定状态。
   *
   * Returns:
   * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
   *
   * Throws:
   * - 共享环境释放失败时直接拒绝，并保留底层失败原因。
   */
  async close(): Promise<void> {
    await closeAgentResources(this.environment);
  }
}

/**
 * 驱动一次运行直到产生唯一终态。
 *
 * Args:
 * - `run`: 当前 stream 独占的可变状态；阶段函数按固定顺序更新该对象。
 *
 * Returns:
 * - Promise 在运行完成或失败事件写入 stream 并关闭生产端后兑现。
 */
async function runAgentLoop(run: RunState): Promise<void> {
  try {
    await initializeRunState(run);

    while (canBeginRunTurn(run)) {
      const turn = await beginRunTurn(run);
      if (turn.skipModel === 'interrupted') {
        await completeRunTurn(
          run,
          turn,
          undefined,
          undefined,
          { messages: [], toolCalls: [], pendingCount: 0 },
          'interrupted',
        );
        break;
      }

      const input = await buildModelInput(run);
      const assistant = await callModel(run, input);
      const toolResults = await executeToolCalls(run, assistant);

      await completeRunTurn(
        run,
        turn,
        input.diagnostics,
        assistant.response,
        toolResults,
        assistant.stopReason,
      );

      if (shouldStopRun(run)) {
        break;
      }
    }

    await completeRunState(run);
  } catch (error) {
    await failRunState(run, error);
  }
}

/**
 * 校验创建阶段必须显式提供的运行时依赖。
 *
 * Args:
 * - `options`: 公开创建入口接收的完整配置；函数只读取依赖形状。
 *
 * Returns:
 * - 所有必需依赖存在且 callable 时返回，不修改配置。
 *
 * Throws:
 * - 环境缺失或模型 adapter 缺少 `generate` / `stream` 时直接抛错。
 */
function assertRuntimeDependencies(options: CreateAgentOptions): void {
  if (
    options.environment === undefined ||
    options.environment === null ||
    typeof options.environment !== 'object'
  ) {
    throw new Error('environment is required.');
  }
  if (
    options.modelAdapter === undefined ||
    typeof options.modelAdapter.generate !== 'function' ||
    typeof options.modelAdapter.stream !== 'function'
  ) {
    throw new Error('modelAdapter with generate() and stream() is required.');
  }
}

/**
 * 校验模型可见工具与实际执行注册表的一致性。
 *
 * Args:
 * - `options`: 同时包含完整执行工具和模型可见工具的创建配置。
 *
 * Returns:
 * - 两个集合均非空、名称唯一且模型工具都有执行实现时返回。
 *
 * Throws:
 * - 工具集合缺失、为空、名称为空、名称重复或模型工具无法执行时直接抛错。
 */
function assertToolCollections(options: CreateAgentOptions): void {
  if (
    !Array.isArray(options.executionTools) ||
    !Array.isArray(options.modelTools)
  ) {
    throw new Error('executionTools and modelTools are required.');
  }
  if (options.executionTools.length === 0 || options.modelTools.length === 0) {
    throw new Error('executionTools and modelTools must both be non-empty.');
  }
  const executionNames = uniqueNames(options.executionTools, 'executionTools');
  uniqueNames(options.modelTools, 'modelTools');
  for (const tool of options.modelTools) {
    if (!executionNames.has(tool.name)) {
      throw new Error(
        `Model tool '${tool.name}' is not registered in executionTools.`,
      );
    }
  }
}

/**
 * 校验工具名称并返回可用于集合关系检查的名称集合。
 *
 * Args:
 * - `tools`: 当前工具集合的只读快照。
 * - `collection`: 出现在错误信息中的精确配置字段名。
 *
 * Returns:
 * - 返回与输入一一对应的唯一工具名称集合。
 *
 * Throws:
 * - 任一名称为空或在同一集合中重复时直接抛错。
 */
function uniqueNames(
  tools: readonly { readonly name: string }[],
  collection: string,
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.name.trim() === '') {
      throw new Error(`${collection} contains an empty tool name.`);
    }
    if (names.has(tool.name)) {
      throw new Error(`Duplicate tool '${tool.name}' in ${collection}.`);
    }
    names.add(tool.name);
  }
  return names;
}
