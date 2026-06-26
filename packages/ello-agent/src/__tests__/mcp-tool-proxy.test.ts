import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AgentContext,
  BaseTool,
  LocalEnvironment,
  MCPTransport,
  MCPToolset,
  ToolProxyToolset,
  Toolset,
  buildMcpServer,
  buildMcpServers,
  createAgent,
  loadMcpConfigFile,
  type ToolArgs,
  type ToolRunContext,
} from '../index.js';

class EchoTool extends BaseTool {
  static override toolName = 'echo';
  static override description = 'Echo a provided value.';
  static override inputSchema = z.object({ value: z.string() });

  async call(_ctx: ToolRunContext, args: ToolArgs): Promise<string> {
    return `echo:${String(args.value)}`;
  }
}

class HiddenTool extends BaseTool {
  static override toolName = 'hidden';
  static override description = 'Hidden tool.';

  override isAvailable(): boolean {
    return false;
  }

  async call(): Promise<string> {
    return 'hidden';
  }
}

function ctx(): { deps: AgentContext } {
  return {
    deps: new AgentContext({ env: new LocalEnvironment() }),
  };
}

describe('MCP config', () => {
  it('builds stdio MCP toolset when command is present', () => {
    const toolset = buildMcpServer('fs', {
      transport: MCPTransport.stdio,
      command: 'node',
      args: ['server.js'],
      env: { DEBUG: '1' },
      url: null,
      headers: {},
      description: 'Filesystem server',
      required: true,
    });

    expect(toolset).toBeInstanceOf(MCPToolset);
    expect(toolset?.toolPrefix).toBe('fs');
    expect(toolset?.config.command).toBe('node');
  });

  it('returns null for incomplete MCP server config', () => {
    expect(
      buildMcpServer('missing', {
        transport: MCPTransport.stdio,
        command: null,
        args: [],
        env: {},
        url: null,
        headers: {},
        description: '',
        required: true,
      }),
    ).toBeNull();
  });

  it('builds streamable http MCP toolsets', () => {
    const servers = buildMcpServers({
      servers: {
        web: {
          transport: MCPTransport.streamableHttp,
          command: null,
          args: [],
          env: {},
          url: 'https://mcp.example.com',
          headers: { Authorization: 'Bearer token' },
          description: 'Web MCP',
          required: false,
        },
      },
    });

    expect(servers).toHaveLength(1);
    expect(servers[0]!.toolPrefix).toBe('web');
  });

  it('loads MCP config from JSON file', async ({ task }) => {
    const dir = join('/tmp', `ello-ts-mcp-${task.id}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, 'mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        servers: {
          fs: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
          },
        },
      }),
      'utf8',
    );

    const config = await loadMcpConfigFile(file);

    expect(config.servers.fs?.command).toBe('node');
    expect(config.servers.fs?.headers).toEqual({});
  });

  it('createAgent appends MCP toolsets', () => {
    const runtime = createAgent({
      mcpConfig: {
        servers: {
          fs: {
            transport: MCPTransport.stdio,
            command: 'node',
            args: [],
            env: {},
            url: null,
            headers: {},
            description: '',
            required: true,
          },
        },
      },
    });

    expect(
      runtime.toolsets.some((toolset) => toolset instanceof MCPToolset),
    ).toBe(true);
  });
});

describe('ToolProxyToolset', () => {
  it('always exposes search_tools and call_tool', async () => {
    const proxy = new ToolProxyToolset(new Toolset({ tools: [EchoTool] }));
    const tools = await proxy.getTools(ctx());

    expect(Object.keys(tools).sort()).toEqual(['call_tool', 'search_tools']);
  });

  it('searches source tools without loading schemas dynamically', async () => {
    const proxy = new ToolProxyToolset(new Toolset({ tools: [EchoTool] }), {
      minScore: 0.1,
    });

    const result = await proxy.callTool(
      'search_tools',
      { query: 'echo value' },
      ctx(),
    );

    expect(result).toContain('Available tools:');
    expect(result).toContain('- echo: Echo a provided value.');
  });

  it('calls source tool by JSON arguments', async () => {
    const proxy = new ToolProxyToolset(new Toolset({ tools: [EchoTool] }));

    const result = await proxy.callTool(
      'call_tool',
      { toolName: 'echo', arguments: JSON.stringify({ value: 'hello' }) },
      ctx(),
    );

    expect(result).toBe('echo:hello');
  });

  it('reports invalid JSON arguments', async () => {
    const proxy = new ToolProxyToolset(new Toolset({ tools: [EchoTool] }));

    const result = await proxy.callTool(
      'call_tool',
      { toolName: 'echo', arguments: '{bad' },
      ctx(),
    );

    expect(result).toContain('Invalid JSON arguments');
  });

  it('reports unavailable source tools', async () => {
    const proxy = new ToolProxyToolset(
      new Toolset({ tools: [HiddenTool], skipUnavailable: true }),
    );

    const result = await proxy.callTool(
      'call_tool',
      { toolName: 'hidden', arguments: '{}' },
      ctx(),
    );

    expect(result).toBe(
      "Error: Tool 'hidden' not available in current context.",
    );
  });
});
