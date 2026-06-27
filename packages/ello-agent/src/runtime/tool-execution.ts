import type { ToolSet } from 'ai';

import type { RuntimeToolset } from '../agents.js';
import type { AgentContext } from '../context.js';
import type { ToolArgs } from '../toolsets/index.js';

import { createAiTool } from './tool-adapter.js';

export type ApprovalPredicate = (args: ToolArgs) => boolean;

export async function collectRuntimeTools(options: {
  ctx: AgentContext | null;
  toolsets: RuntimeToolset[];
  approvalToolNames?: Set<string>;
  approvalPredicates?: Map<string, ApprovalPredicate>;
}): Promise<ToolSet> {
  if (options.ctx === null) {
    return {};
  }

  const result: ToolSet = {};
  const runCtx = { deps: options.ctx };
  for (const toolset of options.toolsets) {
    const tools = await toolset.getTools(runCtx);
    for (const [name, toolDef] of Object.entries(tools)) {
      if (toolDef.requiresApproval) {
        options.approvalToolNames?.add(name);
      }
      if (toolDef.requiresApprovalFor !== undefined) {
        const previous = options.approvalPredicates?.get(name);
        options.approvalPredicates?.set(name, (args) =>
          Boolean(previous?.(args) || toolDef.requiresApprovalFor?.(args)),
        );
      }
      result[name] = createAiTool({
        toolset,
        name,
        toolDef,
        getContext: () => options.ctx,
      });
    }
  }
  return result;
}
