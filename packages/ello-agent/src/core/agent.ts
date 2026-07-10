/**
 * 代理对象的对外入口。
 *
 * 定义 {@link ElloAgent} —— `Agent` 接口的默认实现，是整个代理运行时面向使用者
 * 的门面。它把不变的创建配置与每次运行的可变状态分离开：实例本身只保存配置，
 * 而 `run` / `stream` / `resume` 三个方法各自开启一个独立的运行会话，真正的
 * 「构建模型输入 → 调模型 → 执行工具 → 结束回合」回合循环由 `runAgentLoop` 承载。
 */
import type {
  Agent,
  AgentInput,
  AgentRunOptions,
  AgentRunResult,
  AgentStream,
  CreateAgentOptions,
  ModelAdapter,
} from '../public/types.js';

import { closeAgentResources } from './events.js';
import { runAgentLoop } from './loop.js';
import { createRunSession, defaultModelAdapter } from './run-session.js';

/**
 * `Agent` 接口的默认实现：provider 无关的代理循环入口。
 *
 * 持有创建时确定的不变配置（模型、工具、环境、会话存储等），每次 `run` /
 * `stream` / `resume` 都新建一个独立的 {@link RunSession} 来承载本次运行的可变状态，
 * 因此同一个实例可被多次、并发地复用而互不干扰。具体的回合循环逻辑委托给
 * `runAgentLoop`，本类只负责装配与对外暴露三种触发方式。
 */
export class ElloAgent implements Agent {
  /** 运行环境（shell/沙箱等），缺省为不做任何事的空环境。 */
  private readonly environment;
  /** 模型适配器，未显式注入时回退到默认的 AI SDK 适配器。 */
  private readonly modelAdapter: ModelAdapter;

  constructor(private readonly config: CreateAgentOptions) {
    this.environment = config.environment ?? {};
    this.modelAdapter = config.modelAdapter ?? defaultModelAdapter();
  }

  /**
   * 跑完一次完整运行并返回最终结果。
   *
   * 内部即 `stream` 加上「把事件流消费到底」：调用方不关心中间事件时使用，
   * 等价于 `for await ... stream` 后取 `stream.final`。
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
   */
  stream(input: AgentInput, options: AgentRunOptions = {}): AgentStream {
    const run = createRunSession({
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
   */
  resume(
    deferred: NonNullable<AgentRunOptions['resume']>,
    options: AgentRunOptions = {},
  ): AgentStream {
    return this.stream({ messages: [] }, { ...options, resume: deferred });
  }

  /** 释放环境占用的资源（如关闭沙箱/子进程）。 */
  async close(): Promise<void> {
    await closeAgentResources(this.environment);
  }
}
