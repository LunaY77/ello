import { defineDeferredTool } from '@ello/agent';

import { UserInputRequestSchema } from './schema.js';

export const REQUEST_USER_INPUT_TOOL_NAME = 'request_user_input';

export function createRequestUserInputTool() {
  return defineDeferredTool({
    name: REQUEST_USER_INPUT_TOOL_NAME,
    description:
      'Ask the user 1-3 short questions only when repository inspection cannot resolve a choice that materially changes architecture, scope, risk, or user preference. Put the recommended option first and explain why. Call this tool by itself; never use it for permissions or Plan Mode exit.',
    discovery: {
      aliases: ['ask user', 'clarify requirements'],
      risk: 'readonly',
    },
    input: UserInputRequestSchema,
  });
}
