import { describe, expect, it } from 'vitest';

import {
  BaseTool,
  KeywordSearchStrategy,
  ToolSearchToolset,
  Toolset,
  type ToolRunContext,
} from '../index.js';

class ReadTool extends BaseTool {
  static override toolName = 'read_file';
  static override description = 'Read a text file';

  async call(): Promise<string> {
    return 'read';
  }
}

class ShellTool extends BaseTool {
  static override toolName = 'shell_exec';
  static override description = 'Execute shell commands';

  async call(): Promise<string> {
    return 'shell';
  }
}

const ctx = { deps: {} } as ToolRunContext;

describe('KeywordSearchStrategy', () => {
  it('matches exact and partial terms', async () => {
    const strategy = new KeywordSearchStrategy();

    const exact = await strategy.search('shell', [
      ['shell_exec', 'Execute shell commands'],
    ]);
    const partial = await strategy.search('file read', [
      ['read_file', 'Read a text file'],
    ]);

    expect(exact[0]?.[0]).toBeGreaterThan(0.5);
    expect(partial[0]?.[0]).toBeGreaterThan(0.5);
  });

  it('returns no result for empty or unmatched query', async () => {
    const strategy = new KeywordSearchStrategy();

    await expect(
      strategy.search('', [['shell_exec', 'Execute shell commands']]),
    ).resolves.toEqual([]);
    await expect(
      strategy.search('database', [['shell_exec', 'Execute shell commands']]),
    ).resolves.toEqual([]);
  });
});

describe('ToolSearchToolset', () => {
  it('exposes search_tools and loads matched tools', async () => {
    const source = new Toolset({ tools: [ReadTool, ShellTool] });
    const search = new ToolSearchToolset(source, {
      strategy: new KeywordSearchStrategy(),
      minScore: 0.1,
    });

    let tools = await search.getTools(ctx);
    expect(tools).toHaveProperty('search_tools');
    expect(tools).not.toHaveProperty('read_file');

    const result = await search.callTool(
      'search_tools',
      { query: 'read file' },
      ctx,
      tools.search_tools,
    );
    expect(String(result)).toContain('read_file');

    tools = await search.getTools(ctx);
    expect(tools).toHaveProperty('read_file');
  });
});
