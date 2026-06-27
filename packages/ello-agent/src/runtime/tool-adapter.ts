import { tool as aiTool, type ToolSet } from 'ai';

import type { RuntimeToolset } from '../agents.js';
import type { AgentContext } from '../context.js';
import type { ToolArgs, ToolsetTool } from '../toolsets/index.js';

export function createAiTool(options: {
  toolset: RuntimeToolset;
  name: string;
  toolDef: ToolsetTool;
  getContext: () => AgentContext | null;
}): ToolSet[string] {
  return aiTool({
    description: options.toolDef.description,
    inputSchema: options.toolDef.inputSchema,
    execute: async (input) => {
      if (options.toolDef.requiresApproval) {
        return {
          status: 'deferred',
          reason: 'Tool execution requires approval.',
        };
      }
      const ctx = options.getContext();
      if (ctx === null) {
        throw new Error('AgentRuntime context is not available.');
      }
      return options.toolset.callTool(
        options.name,
        input as ToolArgs,
        { deps: ctx },
        options.toolDef,
      );
    },
  });
}
