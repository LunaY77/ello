import type { ModelMessage } from 'ai';

import type { AgentContext } from '../context.js';

import { trimHistory } from './trim.js';

/** 摘要 agent 需要提供的最小接口。 */
export interface SummaryAgent {
  run(input: {
    prompt: string;
    messages: ModelMessage[];
    ctx: AgentContext;
  }): Promise<string> | string;
}

/** 增量摘要更新提示词。 */
export const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use the same structured format as the original summary (Goal / Constraints / Progress / Key Decisions / Past Interactions / Next Steps / Critical Context).`;

/** 默认摘要提示词。 */
export const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Past Interactions
- [Key interactions that already occurred: questions asked and answers given, approaches tried and outcomes]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]`;

/** 从工具返回中提取文件操作记录。 */
export function extractFileOperations(messages: ModelMessage[]): {
  readFiles: string[];
  modifiedFiles: string[];
} {
  const readFiles: string[] = [];
  const modifiedFiles: string[] = [];

  for (const message of messages) {
    if (message.role !== 'tool') {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== 'tool-result') {
        continue;
      }
      const name = part.toolName;
      const content = toolResultOutputToString(part.output).slice(0, 200);
      if (['read_file', 'read', 'cat'].includes(name)) {
        if (content) {
          readFiles.push(`${name}: ${content.slice(0, 60)}`);
        }
      } else if (
        [
          'write_file',
          'write',
          'edit',
          'patch',
          'create_file',
          'mkdir',
        ].includes(name)
      ) {
        modifiedFiles.push(`${name}: ${content.slice(0, 60)}`);
      }
    }
  }

  return { readFiles, modifiedFiles };
}

/** 使用传入的摘要 agent 生成消息摘要。 */
export async function generateSummary(
  messages: ModelMessage[],
  agent: SummaryAgent,
  ctx: AgentContext,
  options: {
    previousSummary?: string | null;
    customInstructions?: string | null;
  } = {},
): Promise<string> {
  const trimResult = trimHistory(messages, {
    injectedContextTags: ctx.injectedContextTags,
  });
  const promptParts: string[] = [];

  if (options.previousSummary) {
    promptParts.push(
      `<previous-summary>\n${options.previousSummary}\n</previous-summary>\n\n`,
    );
    promptParts.push(UPDATE_SUMMARIZATION_PROMPT);
  } else {
    promptParts.push(SUMMARIZATION_PROMPT);
  }

  const fileOps = extractFileOperations(messages);
  if (fileOps.readFiles.length > 0 || fileOps.modifiedFiles.length > 0) {
    const opsSection = [
      '\n\n## File Operations',
      fileOps.readFiles.length > 0
        ? `Read: ${fileOps.readFiles.slice(0, 10).join(', ')}`
        : null,
      fileOps.modifiedFiles.length > 0
        ? `Modified: ${fileOps.modifiedFiles.slice(0, 10).join(', ')}`
        : null,
    ].filter((line): line is string => line !== null);
    promptParts.push(opsSection.join('\n'));
  }

  if (options.customInstructions) {
    promptParts.push(`\n\n${options.customInstructions}`);
  }

  if (ctx.steeringMessages.length > 0) {
    promptParts.push(
      [
        '\n\n## Steering Context',
        ...ctx.steeringMessages.slice(-5).map((m) => `- ${m}`),
      ].join('\n'),
    );
  }

  const result = await agent.run({
    prompt: promptParts.join('\n'),
    messages: trimResult.messages,
    ctx,
  });
  return String(result);
}

function toolResultOutputToString(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (typeof output !== 'object' || output === null) {
    return String(output ?? '');
  }
  const typed = output as { value?: unknown; reason?: unknown };
  if (typeof typed.value === 'string') {
    return typed.value;
  }
  if (typed.value !== undefined) {
    return JSON.stringify(typed.value);
  }
  if (typeof typed.reason === 'string') {
    return typed.reason;
  }
  return JSON.stringify(output);
}
