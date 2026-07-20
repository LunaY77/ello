import { z } from 'zod';

import { defineTool, type AgentTool } from '../engine/index.js';

import {
  ACTIVATE_SKILL_TOOL_NAME,
  SkillActivationService,
  type SkillActivatedData,
} from './activation.js';

type ActivateSkillInput = { name: string; arguments?: string | undefined };

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
