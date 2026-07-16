import { defineTool, type AgentToolContext } from '@ello/agent';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createPlanTools } from '../plan/tools.js';
import { projectToolEvent } from '../tools/event-projection.js';
import {
  createCallTool,
  createMetaToolRuntime,
  createToolSearchTool,
  TOOL_ROUTING_INSTRUCTIONS,
} from '../tools/meta-tools.js';
import { createToolSearchIndex } from '../tools/search-index.js';

function target(name: string, description: string, alias: string) {
  return defineTool({
    name,
    description,
    discovery: { aliases: [alias], risk: 'readonly' },
    input: z
      .object({ path: z.string().describe('Workspace file path') })
      .strict(),
    execute: ({ path }) => ({ name, path }),
  });
}

const context: AgentToolContext = {
  runId: 'run-1',
  turnIndex: 0,
  toolCallId: 'call-1',
  environment: {},
  metadata: {},
  signal: new AbortController().signal,
};

describe('meta tool activation', () => {
  const tools = [
    target('read', 'Read a file or directory.', 'cat file'),
    target('grep', 'Search file contents with a regex.', 'search text'),
    target('write', 'Write a complete file.', 'create file'),
  ];
  const searchConfig = { result_limit: 6, max_result_bytes: 24_000 };

  it('forbids direct target calls throughout routing mode', () => {
    expect(TOOL_ROUTING_INSTRUCTIONS).toContain(
      'only `tool_search` and `call_tool` are directly callable',
    );
    expect(TOOL_ROUTING_INSTRUCTIONS).toContain(
      'even when the user explicitly requests that tool',
    );
    expect(TOOL_ROUTING_INSTRUCTIONS).toContain('always call `call_tool`');
  });

  it('exposes target tools directly when routing is disabled', () => {
    const runtime = createMetaToolRuntime(tools, {
      routing_enabled: false,
      search: searchConfig,
    });

    expect(runtime.usesToolRouting).toBe(false);
    expect(runtime.executionTools).toBe(tools);
    expect(runtime.modelTools.map((tool) => tool.name)).toEqual([
      'read',
      'grep',
      'write',
    ]);
  });

  it('exposes tool_search and call_tool when routing is enabled', () => {
    const runtime = createMetaToolRuntime(tools, {
      routing_enabled: true,
      search: searchConfig,
    });

    expect(runtime.usesToolRouting).toBe(true);
    expect(runtime.executionTools.map((tool) => tool.name)).toEqual([
      'read',
      'grep',
      'write',
      'tool_search',
      'call_tool',
    ]);
    expect(runtime.modelTools.map((tool) => tool.name)).toEqual([
      'tool_search',
      'call_tool',
    ]);
    expect(runtime.modelTools[0]?.description).toContain(
      'Returned names are not directly callable',
    );
  });

  it('lists the current inventory and discovers Plan-only tools in Plan mode', async () => {
    const planTools = createPlanTools({
      write: async () => 'written',
      requestExit: async () => 'requested',
    });
    const runtime = createMetaToolRuntime([...tools, ...planTools], {
      routing_enabled: true,
      search: searchConfig,
    });
    const search = runtime.modelTools.find(
      (tool) => tool.name === 'tool_search',
    );
    if (search === undefined) throw new Error('tool_search missing');

    const inventory = await search.execute(
      { query: 'all tools', limit: 6 },
      context,
    );
    expect(inventory).toMatchObject({
      inventory: true,
      totalAvailableTools: 5,
      offset: 0,
      truncated: false,
      results: expect.arrayContaining([
        expect.objectContaining({ name: 'write_plan' }),
        expect.objectContaining({ name: 'request_plan_exit' }),
      ]),
    });
    const firstPage = await search.execute({ limit: 2 }, context);
    expect(firstPage).toMatchObject({
      inventory: true,
      offset: 0,
      truncated: true,
      nextOffset: 2,
      results: [
        expect.not.objectContaining({ inputSchema: expect.anything() }),
        expect.not.objectContaining({ inputSchema: expect.anything() }),
      ],
    });
    const planSearch = await search.execute(
      { query: 'plan', limit: 6 },
      context,
    );
    expect(planSearch).toMatchObject({
      inventory: false,
      totalAvailableTools: 5,
      offset: 0,
      results: expect.arrayContaining([
        expect.objectContaining({ name: 'write_plan' }),
        expect.objectContaining({ name: 'request_plan_exit' }),
      ]),
    });
  });
});

describe('tool search index', () => {
  const tools = [
    target('read', 'Read a file or directory.', 'cat file'),
    target('grep', 'Search file contents with a regex.', 'search text'),
    target('write', 'Write a complete file.', 'create file'),
  ];
  const index = createToolSearchIndex(tools);

  it('supports exact, prefix, fuzzy, multi-token, and stable no-result search', () => {
    expect(index.search('read', 8)[0]?.name).toBe('read');
    expect(index.search('rea', 8)[0]?.name).toBe('read');
    expect(index.search('reed', 8)[0]?.name).toBe('read');
    expect(index.search('search regex', 8)[0]?.name).toBe('grep');
    expect(index.search('unrelated-capability', 8)).toEqual([]);
    expect(index.search('file', 8)).toEqual(index.search('file', 8));
  });

  it('rejects invalid search input and oversized tool_search results', async () => {
    expect(() => index.search(' ', 2)).toThrow('searchable text');
    expect(() => index.search('read', 9)).toThrow('1 to 8');
    const search = createToolSearchTool({
      index,
      resultLimit: 6,
      maxResultBytes: 10,
    });
    expect(() => search.execute({ query: 'read', limit: 1 }, context)).toThrow(
      'exceeding',
    );
  });
});

describe('call_tool proxy', () => {
  it('parses once for approval and execution while preserving output', async () => {
    const output = { value: 42 };
    const execute = vi.fn(() => output);
    const approval = vi.fn(() => ({
      action: 'required' as const,
      metadata: {
        permission: 'edit',
        patterns: ['a.txt'],
        always: ['a.txt'],
      },
    }));
    const write = defineTool({
      name: 'write',
      description: 'Write a file.',
      discovery: { aliases: ['save file'], risk: 'workspace-write' },
      input: z.object({ path: z.string() }).strict(),
      approval,
      execute,
    });
    const proxy = createCallTool([write]);
    const input = { name: 'write', arguments: { path: 'a.txt' } };

    await expect(proxy.approval?.(input, context)).resolves.toMatchObject({
      action: 'required',
      metadata: { proxiedTool: 'write' },
    });
    await expect(proxy.execute(input, context)).resolves.toBe(output);
    expect(approval).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects unknown, recursive, and schema-invalid targets', async () => {
    const proxy = createCallTool([target('read', 'Read a file.', 'cat file')]);
    await expect(
      proxy.execute({ name: 'missing', arguments: {} }, context),
    ).rejects.toThrow('Unknown or disabled');
    await expect(
      proxy.execute({ name: 'call_tool', arguments: {} }, context),
    ).rejects.toThrow('recursively');
    await expect(
      proxy.execute({ name: 'read', arguments: {} }, context),
    ).rejects.toThrow("Invalid arguments for tool 'read': path");
  });

  it('projects wrapper events to the logical target', () => {
    expect(
      projectToolEvent({
        type: 'tool.started',
        runId: 'run-1',
        occurredAt: new Date().toISOString(),
        turnIndex: 0,
        toolCallId: 'call-1',
        name: 'call_tool',
        input: { name: 'read', arguments: { path: 'a.txt' } },
      }),
    ).toMatchObject({ name: 'read', input: { path: 'a.txt' } });
  });
});
