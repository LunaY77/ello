/**
 * Memory feature 的原生 Command 定义。
 *
 * 固定标量输入通过 CLI invocation 暴露，topic 正文使用 Frame body。
 */
import { z } from 'zod';

import {
  cliInput,
  commandInput,
  defineCommand,
  type CommandDefinition,
} from '../../command/index.js';
import type { ApprovalFor } from '../../tool/index.js';

import type { MemoryMutation, MemoryStore } from './store.js';

const ScopeSchema = z.enum(['private', 'team']);

export interface MemoryCommandPort {
  readonly repository: MemoryStore;
  /** 在 Memory 串行 mutation 边界中执行操作。 */
  mutate<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * 创建绑定 Memory repository 的 Command 集合。
 *
 * Args:
 * - `options`: repository、mutation 串行边界与可选审批工厂。
 *
 * Returns:
 * - 返回可直接注册到当前 Agent Registry 的定义集合。
 */
export function createMemoryCommands(options: {
  readonly port: MemoryCommandPort;
  readonly onMutation?: (mutation: MemoryMutation) => void;
  readonly approval?: ApprovalFor;
}): CommandDefinition[] {
  const mutate = async (
    operation: () => Promise<MemoryMutation>,
  ): Promise<MemoryMutation> => {
    const result = await options.port.mutate(operation);
    options.onMutation?.(result);
    return result;
  };
  const listInput = z
    .object({ scope: ScopeSchema.describe('Memory scope to list') })
    .strict();
  const readInput = z
    .object({
      scope: ScopeSchema.describe('Memory scope'),
      file: z.string().min(1).describe('Topic file name'),
    })
    .strict();
  const writeInput = z
    .object({
      scope: ScopeSchema.describe('Memory scope'),
      file: z.string().min(1).describe('Topic file name'),
      expectedRevision: z
        .string()
        .min(1)
        .optional()
        .describe('Expected revision; omit when creating a new topic'),
      content: z.string().min(1).describe('Markdown content for the topic'),
    })
    .strict();
  const deleteInput = z
    .object({
      scope: ScopeSchema.describe('Memory scope'),
      file: z.string().min(1).describe('Topic file name'),
      expectedRevision: z
        .string()
        .min(1)
        .describe('Current revision for conflict detection'),
    })
    .strict();
  const searchInput = z
    .object({
      query: z.string().trim().min(1).describe('Search query'),
      scope: ScopeSchema.optional().describe('Optional scope filter'),
    })
    .strict();
  return [
    defineCommand({
      name: 'memory_list',
      summary: 'List memory topics in one scope with their revisions.',
      aliases: ['memories'],
      risk: 'readonly',
      invocation: cliInput(commandInput(listInput), {
        positionals: [{ field: 'scope' }],
      }),
      effects: readonlyMemoryEffects('memory.list'),
      execution: {
        kind: 'immediate',
        run: async ({ scope }) =>
          (await options.port.repository.list(scope)).map((topic) => ({
            scope: topic.scope,
            file: topic.file,
            revision: topic.revision,
            ...topic.document.frontmatter,
          })),
      },
    }),
    defineCommand({
      name: 'memory_read',
      summary: 'Read MEMORY.md or one top-level topic with its revision.',
      aliases: ['recall memory'],
      risk: 'readonly',
      invocation: cliInput(commandInput(readInput), {
        positionals: [{ field: 'scope' }, { field: 'file' }],
      }),
      effects: readonlyMemoryEffects('memory.read'),
      execution: {
        kind: 'immediate',
        run: ({ scope, file }) => options.port.repository.read(scope, file),
      },
    }),
    defineCommand({
      name: 'memory_write',
      summary: 'Create or update one memory topic atomically.',
      details:
        'Pass the revision returned by memory_read when updating; omit it only for a new file.',
      aliases: ['save memory'],
      risk: 'workspace-write',
      invocation: cliInput(commandInput(writeInput), {
        positionals: [{ field: 'scope' }, { field: 'file' }],
        options: ['expectedRevision'],
        body: 'content',
      }),
      approval: (input, context) =>
        options.approval?.('memory_write')(input, context) ?? 'auto',
      execution: {
        kind: 'immediate',
        run: ({ scope, file, expectedRevision, content }) =>
          mutate(() =>
            options.port.repository.write(
              scope,
              file,
              expectedRevision ?? null,
              content,
            ),
          ),
      },
    }),
    defineCommand({
      name: 'memory_delete',
      summary: 'Delete one memory topic using its current revision.',
      aliases: ['remove memory'],
      risk: 'workspace-write',
      invocation: cliInput(commandInput(deleteInput), {
        positionals: [{ field: 'scope' }, { field: 'file' }],
        options: ['expectedRevision'],
      }),
      approval: (input, context) =>
        options.approval?.('memory_delete')(input, context) ?? 'auto',
      execution: {
        kind: 'immediate',
        run: ({ scope, file, expectedRevision }) =>
          mutate(() =>
            options.port.repository.delete(scope, file, expectedRevision),
          ),
      },
    }),
    defineCommand({
      name: 'memory_search',
      summary: 'Search memory topic names, descriptions and bodies.',
      aliases: ['find memory'],
      risk: 'readonly',
      invocation: cliInput(commandInput(searchInput), {
        positionals: [{ field: 'query' }],
        options: ['scope'],
      }),
      effects: readonlyMemoryEffects('memory.search'),
      execution: {
        kind: 'immediate',
        run: ({ query, scope }) => options.port.repository.search(query, scope),
      },
    }),
  ];
}

function readonlyMemoryEffects(telemetryTag: string) {
  return {
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    interruptible: true,
    telemetryTag,
  } as const;
}
