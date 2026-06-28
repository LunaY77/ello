import type { CodingAgentConfig } from './config.js';
import { loadProjectInstructions } from './context/sources.js';

/**
 * 构造 coding-agent system prompt。
 *
 * prompt 保持产品层语义：@ello/agent 不内置 Codex/Claude 类产品规则；
 * 它只接收最终 instructions 和 context bundles。
 */
export function buildCodingSystemPrompt(config: CodingAgentConfig): string {
  return [
    'You are ello coding-agent, a pragmatic software engineering agent.',
    'Follow repository instructions and keep changes scoped to the user request.',
    'Use tools for source-grounded work. Explain important assumptions before risky edits.',
    `Permission mode: ${config.approvalMode}.`,
    'Comments and docstrings in generated project code should follow the user language when requested.',
  ].join('\n');
}

export { loadProjectInstructions };
