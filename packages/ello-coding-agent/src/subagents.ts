import type { AnyAgentTool, SubagentDefinition } from '@ello/agent';

import type { CodingAgentConfig } from './config.js';
import { createFsTools } from './tools/fs.js';
import { createSearchTools } from './tools/search.js';
import type { ApprovalFor } from './tools/shared.js';

/**
 * coding-agent 内置子代理定义。
 *
 * 子代理与主代理共享同一套工具实现，但只挑只读子集（read/ls/grep/glob），
 * 天然保证「探索/审查代理不会误写文件」。`inheritTools: false` 表示不继承父工具，
 * 完全使用这里给定的受限工具集。运行机制走内核的 `createDelegateTool`。
 */
export function codingSubagents(config: CodingAgentConfig): SubagentDefinition[] {
  const tools = readOnlyTools(config);
  return [
    {
      name: 'explore',
      description: 'Read-only codebase exploration; returns a findings report.',
      instructions:
        '你是只读探索代理：用 read/grep/glob/ls 定位相关代码，产出结构化结论（文件、' +
        '关键符号、调用关系、风险点），不要写文件、不要执行命令。',
      inheritTools: false,
      tools,
    },
    {
      name: 'reviewer',
      description: 'Reviews code or a diff and reports issues.',
      instructions:
        '你是代码审查代理：阅读给定改动或文件，列出正确性、安全性、可维护性方面的' +
        '问题与改进建议，按严重程度排序，不要修改任何文件。',
      inheritTools: false,
      tools,
    },
  ];
}

/** 构造只读工具子集（read/ls/grep/glob，审批恒为 auto）。 */
function readOnlyTools(config: CodingAgentConfig): AnyAgentTool[] {
  const autoApproval: ApprovalFor = () => () => 'auto';
  const readOnlyNames = new Set(['read', 'ls', 'grep', 'glob']);
  return [...createFsTools(config, autoApproval), ...createSearchTools(config, autoApproval)].filter(
    (tool) => readOnlyNames.has(tool.name),
  );
}
