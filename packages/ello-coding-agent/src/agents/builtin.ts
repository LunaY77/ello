import { renderPromptTemplate } from '../context/prompts.js';

import type { CodingAgentDefinition } from './schema.js';

/**
 * 内置 agent 定义。
 *
 * - build 是 primary。
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
