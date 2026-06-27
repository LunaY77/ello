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

export function defineSubagent(
  definition: SubagentDefinition,
): SubagentDefinition {
  return definition;
}

export interface CreateDelegateToolOptions {
  readonly subagents: readonly SubagentDefinition[];
  readonly model: AgentModel;
  readonly modelAdapter?: ModelAdapter;
  readonly parentTools?: readonly AnyAgentTool[];
  readonly session?: SessionStore;
  readonly observers?: readonly AgentObserver[];
}

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
      const inherited =
        definition.inheritTools === true
          ? (options.parentTools ?? []).filter((tool) => tool.inherit === true)
          : [];
      const agent = createAgent({
        name: definition.name,
        model: options.model,
        instructions: definition.instructions,
        environment: ctx.environment,
        tools: [...inherited, ...(definition.tools ?? [])],
        metadata: {
          ...ctx.metadata,
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
        await agent.close();
      }
    },
  });
}
