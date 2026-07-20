import { z } from 'zod';

import { defineTool, type AnyAgentTool } from '../engine/index.js';
import type { ApprovalFor } from '../tools/shared.js';

import type { MemoryScope } from './paths.js';
import type { MemoryMutation, MemoryRepository } from './repository.js';

const ScopeSchema = z.enum(['private', 'team']);

export interface MemoryToolPort {
  readonly repository: MemoryRepository;
  mutate<T>(operation: () => Promise<T>): Promise<T>;
}

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
        options.port.repository.search(query, scope as MemoryScope | undefined),
    }),
  ];
}
