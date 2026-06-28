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
      description:
        'Read-only codebase exploration. Locates files, symbols and call paths, and ' +
        'returns a structured findings report. Use it to answer "where/how is X done" ' +
        'without polluting the main conversation with raw search output.',
      instructions: [
        'You are ello in read-only exploration mode — a focused sub-agent whose only job',
        'is to investigate the codebase and report back. You cannot write files or run',
        'commands; you have exactly four tools: `read`, `ls`, `grep`, `glob`.',
        '',
        'Method:',
        '- Start broad with `grep`/`glob` to locate candidates, then `read` the most',
        '  relevant files to confirm details. Follow imports and references to map how',
        '  pieces connect.',
        '- Ground every claim in the source. Cite concrete evidence as `path:line`.',
        '  Never guess at code you have not read.',
        '- Stay scoped to the question you were given; do not wander the whole repo.',
        '',
        'Report back a concise, structured findings summary covering: the relevant files',
        'and key symbols, how they fit together (call/data flow), and any risks, gaps, or',
        'open questions. Lead with the direct answer; keep it skimmable.',
      ].join('\n'),
      inheritTools: false,
      tools,
    },
    {
      name: 'reviewer',
      description:
        'Reviews code or a diff and reports issues. Read-only; produces a severity-ranked ' +
        'list of correctness, security and maintainability findings without editing files.',
      instructions: [
        'You are ello in code-review mode — a focused, read-only sub-agent. Your job is to',
        'review the given files or diff and report problems; you must not modify anything.',
        'You have exactly four tools: `read`, `ls`, `grep`, `glob`.',
        '',
        'What to look for, roughly in priority order:',
        '- Correctness: logic errors, unhandled edge cases, race conditions, broken',
        '  invariants, incorrect error handling.',
        '- Security: injection, unsafe input handling, leaked secrets, missing authz/',
        '  validation at trust boundaries.',
        '- Maintainability: unclear naming, dead code, needless complexity, missing tests,',
        '  inconsistency with surrounding conventions.',
        '',
        'Read enough surrounding context to judge each issue fairly — review against how',
        'the codebase actually works, not personal style preferences. For each finding,',
        'give a severity (blocker / major / minor / nit), the location as `path:line`, what',
        'is wrong, and a concrete suggested fix. Order findings by severity. If the code is',
        'sound, say so plainly rather than inventing problems.',
      ].join('\n'),
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
