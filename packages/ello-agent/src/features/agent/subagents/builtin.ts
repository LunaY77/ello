/**
 * 本文件负责 agent feature 的“builtin”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { renderPromptTemplate } from '../context/prompts.js';

import type { CodingAgentDefinition } from './schema.js';

/**
 * 内置 agent 定义。
 *
 * - build 是 primary。
 * - title/compact/summary/memory-extractor/dream 是 internal：系统专用。
 *
 * Args:
 * - 无：操作使用实例或闭包已经持有的稳定状态。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 */
export function builtinAgents(): readonly CodingAgentDefinition[] {
  return [
    {
      name: 'build',
      mode: 'primary',
      role: 'primary',
      source: 'builtin',
      description: 'Default coding agent.',
      maxTurns: 100,
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
      maxTurns: 4,
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
      maxTurns: 4,
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
      maxTurns: 4,
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
