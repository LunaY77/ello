import { appendFile } from 'node:fs/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'ello-test-mcp', version: '1.0.0' });

if (process.env.ELLO_MCP_START_FILE !== undefined) {
  await appendFile(process.env.ELLO_MCP_START_FILE, 'started\n', 'utf8');
}

server.registerTool(
  'echo',
  {
    description: 'Echo one message.',
    inputSchema: { message: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: `echo:${message}:${process.cwd()}` }],
  }),
);

server.registerTool(
  'mutate',
  {
    description: 'Represent a remote mutation.',
    inputSchema: { value: z.string() },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ value }) => ({
    content: [{ type: 'text', text: `mutated:${value}` }],
  }),
);

server.registerResource(
  'guide',
  'memo://guide',
  { title: 'Guide', mimeType: 'text/plain' },
  async (uri) => ({
    contents: [{ uri: uri.href, text: 'MCP integration guide.' }],
  }),
);

await server.connect(new StdioServerTransport());
