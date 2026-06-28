/**
 * 子代理（subagent）委派模块。
 *
 * 子代理是一个独立配置（自有指令、自有工具集）的从属 Agent。父代理通过
 * `delegate_to_subagent` 工具把一项子任务整体交给它，在隔离的运行中跑完后
 * 把结果作为工具输出返回。子代理拥有独立的对话历史，仅共享父代理的环境，
 * 从而把子任务的中间过程与父会话上下文隔开。
 */

import { z } from 'zod';

import { createAgent } from '../public/create-agent.js';
import { defineTool } from '../public/tool.js';
import type {
  AgentModel,
  AgentObserver,
  AgentTool,
  AnyAgentTool,
  ModelAdapter,
  SessionStore,
  SubagentDefinition,
} from '../public/types.js';

/** 定义一个子代理：恒等透传，仅用于获得类型推断与可读的声明点。 */
export function defineSubagent(
  definition: SubagentDefinition,
): SubagentDefinition {
  return definition;
}

/** {@link createDelegateTool} 的入参。 */
export interface CreateDelegateToolOptions {
  /** 可委派的子代理定义集合。 */
  readonly subagents: readonly SubagentDefinition[];
  /** 子代理使用的模型（与父代理共享同一模型配置）。 */
  readonly model: AgentModel;
  /** 可选的模型适配器，用于测试或私有 provider 注入。 */
  readonly modelAdapter?: ModelAdapter;
  /** 父代理的工具集，供声明了 `inheritTools` 的子代理按 `inherit` 标记继承。 */
  readonly parentTools?: readonly AnyAgentTool[];
  /** 可选会话存储，供子代理持久化其自身历史。 */
  readonly session?: SessionStore;
  /** 可选观测器集合，传递给子代理以便统一观测。 */
  readonly observers?: readonly AgentObserver[];
}

/**
 * 构造 `delegate_to_subagent` 工具。
 *
 * 执行时按名查找子代理定义，临时创建一个隔离的子 Agent 跑完任务后返回其结果，
 * 并在 `finally` 中关闭以释放资源。子代理沿用父代理的环境，但拥有独立的工具集
 * 与对话历史，仅在显式声明继承时才纳入父代理中标记为可继承的工具。
 */
export function createDelegateTool(
  options: CreateDelegateToolOptions,
): AgentTool<{ name: string; input: string }, unknown> {
  return defineTool({
    name: 'delegate_to_subagent',
    description: 'Delegate a task to a named subagent.',
    input: z.object({
      name: z.string(),
      input: z.string(),
    }),
    execute: async ({ name, input }, ctx) => {
      const definition = options.subagents.find((item) => item.name === name);
      if (definition === undefined) {
        throw new Error(`Unknown subagent: ${name}`);
      }
      // 仅当子代理声明 inheritTools 时，才从父工具中挑出标记为可继承的工具；
      // 否则子代理只拥有自身定义的工具，保持能力面隔离。
      const inherited =
        definition.inheritTools === true
          ? (options.parentTools ?? []).filter((tool) => tool.inherit === true)
          : [];
      const agent = createAgent({
        name: definition.name,
        model: options.model,
        instructions: definition.instructions,
        // 共享父代理环境（文件系统、shell 等），但对话历史相互独立。
        environment: ctx.environment,
        tools: [...inherited, ...(definition.tools ?? [])],
        metadata: {
          ...ctx.metadata,
          // 记录委派血缘：标注子代理身份与父 run，便于观测与追踪。
          subagent: definition.name,
          parentRunId: ctx.runId,
          ...definition.metadata,
        },
        ...(options.modelAdapter !== undefined
          ? { modelAdapter: options.modelAdapter }
          : {}),
        ...(options.session !== undefined ? { session: options.session } : {}),
        ...(options.observers !== undefined ? { observers: options.observers } : {}),
      });
      try {
        return await agent.run(input, {
          metadata: { parentRunId: ctx.runId, delegatedBy: 'delegate_to_subagent' },
        });
      } finally {
        // 无论成功与否都关闭子代理，避免泄漏其持有的资源。
        await agent.close();
      }
    },
  });
}
