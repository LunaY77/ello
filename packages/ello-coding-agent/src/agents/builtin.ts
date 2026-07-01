import { renderPromptTemplate } from '../context/prompts.js';

import type { CodingAgentDefinition } from './schema.js';

/** plan agent 的指令正文，配合 `approvalMode: 'plan'` 禁止落盘。 */
const PLAN_PROMPT = `You are in plan mode. Investigate the codebase and produce a concrete, step-by-step implementation plan. Do NOT modify files, run mutating shell commands, or make network changes. Lead with the plan; ground each step in concrete files and symbols.`;

/**
 * 内置 agent 定义。
 *
 * - build/plan 是 primary（可在 `/agent` 中选）。
 * - title/compact/summary 是 internal：系统专用，不进入用户可选列表。
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
  ];
}
