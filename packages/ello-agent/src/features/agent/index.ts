/**
 * 产品 Agent feature 只拥有运行构建、活动运行生命周期和进程关闭顺序。
 *
 * Thread 通过 `AgentFeature.startRun()` 启动一次独立运行；engine、checkpoint 和装配资源都在
 * 运行完成前由本 feature 持有，关闭时先等待构建任务，再中断活动运行。
 */
import { buildAgent } from './build.js';
import type {
  AgentFeature,
  AgentRun,
  AgentRunRequest,
  CreateAgentFeatureInput,
} from './contracts.js';
import { startAgentRun } from './run.js';

/**
 * 创建进程级 Agent feature。单次运行资源由 AgentRun 持有，进程关闭时统一中断并等待所有运行收口。
 *
 * Args:
 * - `input`: `createAgentFeature` 的完整领域输入；调用期间只读，缺字段或非法组合直接失败。
 *
 * Returns:
 * - 返回 `createAgentFeature` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 产品 Agent 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createAgentFeature(
  input: CreateAgentFeatureInput,
): AgentFeature {
  const activeRuns = new Set<AgentRun>();
  const startingRuns = new Set<Promise<AgentRun>>();
  let closing = false;

  const start = async (runInput: AgentRunRequest): Promise<AgentRun> => {
    if (closing) throw new Error('Agent is closing.');
    const built = await buildAgent(runInput, input);
    if (closing) {
      await built.close();
      throw new Error('Agent closed while a run was being built.');
    }
    const run = startAgentRun(built, runInput, input.createCheckpoints());
    activeRuns.add(run);
    const clear = () => activeRuns.delete(run);
    void run.result.then(clear, clear);
    return run;
  };

  return {
    /**
     * 为一次稳定请求启动独立 Agent run，并把事件流与最终结果的观察权交给调用方。
     *
     * Args:
     * - `runInput`: `startRun` 所需的业务值；函数按声明读取，不补造缺失内容。
     *
     * Returns:
     * - Promise 兑现为独立 `AgentRun`；其事件流与 `result` 覆盖该运行的完整生命周期。
     *
     * Throws:
     * - 当 产品 Agent 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
     */
    startRun(runInput) {
      const task = start(runInput);
      startingRuns.add(task);
      const clear = () => startingRuns.delete(task);
      void task.then(clear, clear);
      return task;
    },
    /**
     * 停止 产品 Agent 公开入口 模块 的异步工作并释放其拥有的资源；关闭完成后不再接受新操作。
     *
     * Args:
     * - 无：操作使用实例或闭包已经持有的稳定状态。
     *
     * Returns:
     * - Promise 在全部已拥有资源完成释放、后台工作停止后兑现；失败会直接拒绝。
     *
     * Throws:
     * - 当 产品 Agent 公开入口 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
     */
    async close() {
      if (closing) return;
      closing = true;
      await Promise.allSettled(startingRuns);
      const runs = [...activeRuns];
      for (const run of runs) run.interrupt('agent closing');
      await Promise.all(runs.map((run) => run.result));
    },
  };
}

export type {
  AgentRunContextParts,
  AgentRunTools,
  AgentFeature,
  AgentInteraction,
  AgentRunGoal,
  AgentRunSelection,
  AgentRunRequest,
  AgentResumeResult,
  AgentRun,
  AgentRunEvent,
  AgentRunResult,
  CreateAgentFeatureInput,
  CreateAgentTools,
  LoadAgentContext,
  PermissionSessionView,
  ResolvedAgentDefinition,
  ResolvedAgentModel,
  ResolveAgentDefinition,
  ResolveAgentModel,
} from './contracts.js';
export { PLAN_EXIT_TOOL_NAME } from './contracts.js';
export { createAgentRoutes } from './routes.js';
export { CheckpointStore } from './change/checkpoint.js';
export {
  createCheckpointRecordStore,
  type CheckpointRecordStore,
} from './change/store.js';
export { recordCheckpointChanges } from './change/recording.js';
export { createCodingSystemPromptSection } from './context/prompts.js';
export { createAgentRegistry } from './subagents/registry.js';
export {
  estimateTextTokens,
  type ContextSourceLoadResult,
} from './context/source-registry.js';
export { renderPromptTemplate } from './context/prompts.js';
export {
  createRequestUserInputTool,
  REQUEST_USER_INPUT_TOOL_NAME,
  UserInputRequestSchema,
  validateUserInputResolution,
} from './user-input/index.js';
