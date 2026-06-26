import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { AgentContext } from '../context.js';
import type { SubagentCompleteEvent, SubagentStartEvent } from '../events.js';
import type { RunContextLike } from '../hooks.js';
import {
  BaseTool,
  Instruction,
  Toolset,
  type BaseToolConstructor,
  type ToolArgs,
} from '../toolsets/index.js';

import {
  buildSubagentAgent,
  type BuildSubagentAgentOptions,
  type SubagentRunner,
} from './builder.js';
import type { SubagentConfig } from './config.js';

/** delegate 工具参数 schema。 */
export const DelegateArgsSchema = z.object({
  subagentName: z.string(),
  prompt: z.string(),
  agentId: z.string().nullable().optional(),
});

/** createDelegateTool 参数。 */
export interface CreateDelegateToolOptions extends BuildSubagentAgentOptions {
  name?: string;
  description?: string;
  runners?: Record<string, SubagentRunner>;
}

/** 内部 subagent 注册条目。 */
export interface SubagentEntry {
  config: SubagentConfig;
  agent: SubagentRunner;
}

/** 创建统一 delegate 工具。 */
export function createDelegateTool(
  configs: SubagentConfig[],
  parentToolset: Toolset,
  options: CreateDelegateToolOptions = {},
): BaseToolConstructor {
  if (configs.length === 0) {
    throw new Error('At least one SubagentConfig is required');
  }

  const registry: Record<string, SubagentEntry> = {};
  for (const config of configs) {
    registry[config.name] = {
      config,
      agent:
        options.runners?.[config.name] ??
        buildSubagentAgent(config, parentToolset, {
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.parentAgentName === undefined
            ? {}
            : { parentAgentName: options.parentAgentName }),
          ...(options.subagentWrapper === undefined
            ? {}
            : { subagentWrapper: options.subagentWrapper }),
        }),
    };
  }

  const toolName = options.name ?? 'delegate';
  const toolDescription =
    options.description ?? 'Delegate a task to a specialized subagent.';

  class DelegateTool extends BaseTool {
    static override toolName = toolName;
    static override description = toolDescription;
    static override tags = new Set(['delegation']);
    static override inputSchema = DelegateArgsSchema;

    override isAvailable(): boolean {
      return Object.keys(registry).length > 0;
    }

    override async getInstruction(): Promise<Instruction | null> {
      if (Object.keys(registry).length === 0) {
        return null;
      }
      const lines = [
        'Use the delegate tool to dispatch bounded subtasks to specialized subagents.',
        'Multiple delegate calls in the same response run concurrently.',
        '',
        'Available subagents:',
      ];
      for (const [name, entry] of Object.entries(registry)) {
        const instruction =
          entry.config.instruction ?? entry.config.description;
        lines.push(`- **${name}**: ${instruction}`);
      }
      return new Instruction('delegation', lines.join('\n'));
    }

    async call(
      ctx: RunContextLike<AgentContext>,
      args: ToolArgs,
    ): Promise<string> {
      const parsed = DelegateArgsSchema.parse(args);
      const entry = registry[parsed.subagentName];
      if (entry === undefined) {
        return `Error: Unknown subagent '${parsed.subagentName}'. Available: ${Object.keys(
          registry,
        ).join(', ')}`;
      }
      return executeSubagent(entry, ctx, parsed.prompt, parsed.agentId ?? null);
    }
  }

  Object.defineProperty(DelegateTool, 'name', { value: 'DelegateTool' });
  return DelegateTool;
}

/** 执行 subagent 并返回格式化结果。 */
export async function executeSubagent(
  entry: SubagentEntry,
  ctx: RunContextLike<AgentContext>,
  prompt: string,
  agentId: string | null,
): Promise<string> {
  const deps = ctx.deps;
  const effectiveAgentId =
    agentId ??
    `${entry.config.name}-${randomUUID().replaceAll('-', '').slice(0, 4)}`;
  const promptPreview =
    prompt.length > 100 ? `${prompt.slice(0, 100)}...` : prompt;

  const startEvent: SubagentStartEvent = {
    runId: deps.runId,
    timestamp: new Date(),
    agentId: effectiveAgentId,
    agentName: entry.config.name,
    promptPreview,
  };
  deps.emitEvent(startEvent);

  const subCtx = deps.prepareNewRun();
  const messageHistory = deps.subagentHistory.get(effectiveAgentId) as
    | import('ai').ModelMessage[]
    | undefined;
  let success = true;
  let error = '';
  let output = '';

  try {
    const result = await entry.agent.run(
      prompt,
      messageHistory === undefined
        ? { deps: subCtx }
        : { deps: subCtx, messageHistory },
    );
    output = result.output;
    deps.subagentHistory.set(effectiveAgentId, result.allMessages());
  } catch (caught) {
    success = false;
    error = caught instanceof Error ? caught.message : String(caught);
    output = `Error: subagent execution failed: ${error}`;
  } finally {
    const resultPreview =
      output.length > 500 ? `${output.slice(0, 500)}...` : output;
    const completeEvent: SubagentCompleteEvent = {
      runId: deps.runId,
      timestamp: new Date(),
      agentId: effectiveAgentId,
      agentName: entry.config.name,
      success,
      resultPreview,
      ...(error ? { error } : {}),
    };
    deps.emitEvent(completeEvent);
  }

  return `<id>${effectiveAgentId}</id>\n<response>${output}</response>\n`;
}
