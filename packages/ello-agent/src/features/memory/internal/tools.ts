/**
 * 本文件负责 memory feature 的工具定义与执行适配。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { z } from 'zod';

import { defineTool, type AnyAgentTool } from '../../agent/engine/index.js';
import type { ApprovalFor } from '../../tool/index.js';

import type { MemoryMutation, MemoryStore } from './store.js';

const ScopeSchema = z.enum(['private', 'team']);

export interface MemoryToolPort {
  readonly repository: MemoryStore;
  /**
   * 执行 Memory 工具执行 模块 定义的 `mutate` 领域操作，输入和副作用均受该边界约束。
   *
   * Args:
   * - `operation`: `mutate` 所需的业务值；函数按声明读取，不补造缺失内容。
   *
   * Returns:
   * - Promise 在 Memory 工具执行 模块 的异步读取或状态变更完成后兑现为声明结果。
   */
  mutate<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * 构造 Memory 工具执行 模块 中的 `createMemoryTools` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `options`: 仅作用于 `createMemoryTools` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 *
 * Throws:
 * - 当 Memory 工具执行 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createMemoryTools(options: {
  readonly port: MemoryToolPort;
  readonly onMutation?: (mutation: MemoryMutation) => void;
  readonly approval?: ApprovalFor;
}): AnyAgentTool[] {
  const mutate = async (
    operation: () => Promise<MemoryMutation>,
  ): Promise<MemoryMutation> => {
    const result = await options.port.mutate(operation);
    options.onMutation?.(result);
    return result;
  };
  return [
    defineTool({
      name: 'memory_list',
      description:
        'List memory topics in one scope with metadata and current revisions.',
      discovery: { aliases: ['memories'], risk: 'readonly' },
      input: z
        .object({ scope: ScopeSchema.describe('Memory scope to list') })
        .strict(),
      execute: async ({ scope }) =>
        (await options.port.repository.list(scope)).map((topic) => ({
          scope: topic.scope,
          file: topic.file,
          revision: topic.revision,
          ...topic.document.frontmatter,
        })),
    }),
    defineTool({
      name: 'memory_read',
      description:
        'Read MEMORY.md or one top-level topic file and return its revision.',
      discovery: { aliases: ['recall memory'], risk: 'readonly' },
      input: z
        .object({
          scope: ScopeSchema.describe('Memory scope'),
          file: z.string().min(1).describe('Topic file name'),
        })
        .strict(),
      execute: ({ scope, file }) => options.port.repository.read(scope, file),
    }),
    defineTool({
      name: 'memory_write',
      description:
        'Create or update one topic. Pass null only when the file is absent; otherwise pass the revision returned by memory_read. MEMORY.md is updated atomically by the repository.',
      discovery: { aliases: ['save memory'], risk: 'workspace-write' },
      input: z
        .object({
          scope: ScopeSchema,
          file: z.string().min(1).describe('Topic file name'),
          expectedRevision: z
            .string()
            .min(1)
            .nullable()
            .describe('Expected revision for conflict detection'),
          content: z.string().min(1).describe('Markdown content for the topic'),
        })
        .strict(),
      ...(options.approval !== undefined
        ? { approval: options.approval('memory_write') }
        : {}),
      execute: ({ scope, file, expectedRevision, content }) =>
        mutate(() =>
          options.port.repository.write(scope, file, expectedRevision, content),
        ),
    }),
    defineTool({
      name: 'memory_delete',
      description:
        'Delete one topic using the revision returned by memory_read. MEMORY.md is updated atomically by the repository.',
      discovery: { aliases: ['remove memory'], risk: 'workspace-write' },
      input: z
        .object({
          scope: ScopeSchema,
          file: z.string().min(1).describe('Topic file name'),
          expectedRevision: z
            .string()
            .min(1)
            .describe('Current revision for conflict detection'),
        })
        .strict(),
      ...(options.approval !== undefined
        ? { approval: options.approval('memory_delete') }
        : {}),
      execute: ({ scope, file, expectedRevision }) =>
        mutate(() =>
          options.port.repository.delete(scope, file, expectedRevision),
        ),
    }),
    defineTool({
      name: 'memory_search',
      description:
        'Search topic names, descriptions, and bodies. Use this before creating a topic to avoid duplicates.',
      discovery: { aliases: ['find memory'], risk: 'readonly' },
      input: z
        .object({
          query: z
            .string()
            .trim()
            .min(1)
            .describe('Search query for memory topics'),
          scope: ScopeSchema.optional().describe('Optional scope filter'),
        })
        .strict(),
      execute: ({ query, scope }) =>
        options.port.repository.search(query, scope),
    }),
  ];
}
