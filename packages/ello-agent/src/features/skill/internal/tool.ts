/**
 * 本文件负责 skill feature 的“tool”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { z } from 'zod';

import { defineTool, type AgentTool } from '../../agent/engine/index.js';

import {
  ACTIVATE_SKILL_TOOL_NAME,
  SkillActivationService,
  type SkillActivatedData,
} from './activation.js';

type ActivateSkillInput = { name: string; arguments?: string | undefined };

/**
 * 构造 Skill `tool` 模块 中的 `createActivateSkillTool` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `options`: 仅作用于 `createActivateSkillTool` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `createActivateSkillTool` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 Skill `tool` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createActivateSkillTool(options: {
  readonly service: SkillActivationService;
  readonly onActivated?: (data: SkillActivatedData) => void;
}): AgentTool<ActivateSkillInput, string> {
  return defineTool({
    name: ACTIVATE_SKILL_TOOL_NAME,
    description:
      'Load the complete instructions for a named Skill before responding.',
    discovery: { aliases: ['load skill'], risk: 'readonly' },
    input: z
      .object({
        name: z.string().trim().min(1).describe('Skill name to activate'),
        arguments: z
          .string()
          .optional()
          .describe('Optional arguments passed to the skill'),
      })
      .strict(),
    execute: (input, context) => {
      const activated = options.service.activate({
        ...input,
        runId: context.runId,
      });
      options.onActivated?.({
        toolCallId: context.toolCallId,
        name: activated.skill.name,
        source: activated.skill.source,
        trigger: 'model',
        contentHash: activated.skill.contentHash,
      });
      return activated.output;
    },
  });
}
