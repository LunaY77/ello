import type { ModelMessage } from 'ai';

import type { AgentContext } from '../context.js';
import type { Environment } from '../environment/index.js';

/** filter 的 RunContext 等价最小结构。 */
export interface EnvironmentInstructionRunContext {
  deps: AgentContext;
}

/** 创建注入环境指令的 history filter。 */
export function createEnvironmentInstructionsFilter(env: Environment) {
  return async (
    ctx: EnvironmentInstructionRunContext,
    messageHistory: ModelMessage[],
  ): Promise<ModelMessage[]> => {
    const lastIndex = findLastRequestIndex(messageHistory);
    if (lastIndex === null) {
      return messageHistory;
    }

    const lastMessage = messageHistory[lastIndex];
    if (
      lastMessage === undefined ||
      (hasToolReturn(lastMessage) && !ctx.deps.forceInjectInstructions)
    ) {
      return messageHistory;
    }

    const instructions = await env.getContextInstructions();
    if (!instructions) {
      return messageHistory;
    }

    messageHistory[lastIndex] = appendUserInstructions(
      lastMessage,
      instructions,
    );
    return messageHistory;
  };
}

function findLastRequestIndex(messages: ModelMessage[]): number | null {
  for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
    const role = messages[idx]?.role;
    if (role === 'user' || role === 'tool') {
      return idx;
    }
  }
  return null;
}

function hasToolReturn(message: ModelMessage): boolean {
  return message.role === 'tool';
}

function appendUserInstructions(
  message: ModelMessage,
  instructions: string,
): ModelMessage {
  if (message.role === 'user') {
    if (typeof message.content === 'string') {
      return {
        ...message,
        content: [
          { type: 'text', text: message.content },
          { type: 'text', text: instructions },
        ],
      };
    }
    return {
      ...message,
      content: [...message.content, { type: 'text', text: instructions }],
    };
  }

  return {
    role: 'user',
    content: instructions,
  };
}
