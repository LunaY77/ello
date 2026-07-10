import { renderPromptTemplate } from '../context/prompts.js';

import type { CodingAgentDefinition } from './schema.js';

/** plan agent 的指令正文，配合 `approvalMode: 'plan'` 禁止落盘。 */
const PLAN_PROMPT = `You are in plan mode. Investigate the codebase and produce a concrete, step-by-step implementation plan. Do NOT modify files, run mutating shell commands, or make network changes. Lead with the plan; ground each step in concrete files and symbols.`;

/**
 * 内置 agent 定义。
 *
 * - build/plan 是 primary（可在 `/agent` 中选）。
 * - title/compact/summary/memory-extractor/dream 是 internal：系统专用。
 */
export function builtinAgents(): readonly CodingAgentDefinition[] {
  return [
    {
      name: 'build',
      mode: 'primary',
      role: 'primary',
      source: 'builtin',
      description: 'Default coding agent.',
    },
    {
      name: 'plan',
      mode: 'primary',
      role: 'primary',
      source: 'builtin',
      approvalMode: 'plan',
      description: 'Plan without editing.',
      prompt: PLAN_PROMPT,
    },
    {
      name: 'title',
      mode: 'internal',
      role: 'title',
      source: 'builtin',
      hidden: true,
      tools: [],
      description: 'Internal session title generator.',
      prompt: renderPromptTemplate('title'),
    },
    {
      name: 'compact',
      mode: 'internal',
      role: 'compact',
      source: 'builtin',
      hidden: true,
      tools: [],
      description: 'Internal compact checkpoint generator.',
      prompt: renderPromptTemplate('compact'),
    },
    {
      name: 'summary',
      mode: 'internal',
      role: 'compact',
      source: 'builtin',
      hidden: true,
      tools: [],
      description: 'Internal human-facing session summarizer.',
      prompt: renderPromptTemplate('summary'),
    },
    {
      name: 'memory-extractor',
      mode: 'internal',
      role: 'small',
      source: 'builtin',
      hidden: true,
      tools: [
        'memory_list',
        'memory_read',
        'memory_search',
        'memory_write',
        'memory_delete',
      ],
      maxTurns: 8,
      description: 'Internal automatic memory extractor.',
    },
    {
      name: 'dream',
      mode: 'internal',
      role: 'compact',
      source: 'builtin',
      hidden: true,
      tools: [
        'memory_list',
        'memory_read',
        'memory_search',
        'memory_write',
        'memory_delete',
        'session_list_recent',
        'session_search',
        'repo_current_read',
        'repo_current_search',
      ],
      maxTurns: 16,
      description: 'Internal cross-session memory consolidator.',
    },
  ];
}
