/**
 * 本文件管理 MCP 客户端连接，并将远端工具和资源转换成 Ello 工具。
 *
 * 同一个配置文件只建立一组连接。所有远端能力继续经过 Ello 的参数校验、权限审批、
 * 工具调度和结果持久化；App Server 关闭时统一断开连接并结束 stdio 子进程。
 */
import { createHash } from 'node:crypto';

import { Client } from '@modelcontextprotocol/sdk/client';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { z } from 'zod';

import type {
  AgentToolCapabilities,
  AgentToolInputJsonSchema,
} from '../agent/engine/index.js';
import type { CodingAgentConfig } from '../config/index.js';
import {
  createCodingToolResult,
  defineCodingTool,
  type AnyCodingTool,
  type CodingToolContext,
  type ToolAttachment,
} from '../tool/index.js';

import {
  loadMcpConfig,
  resolveMcpConfigPath,
  resolveMcpServerCwd,
  type LoadedMcpConfig,
  type McpServerConfig,
} from './config.js';

type ListedMcpTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];
type McpCallResult = Awaited<ReturnType<Client['callTool']>>;
type McpResourceResult = Awaited<ReturnType<Client['readResource']>>;

interface McpConnection {
  readonly serverName: string;
  readonly client: Client;
  readonly config: McpServerConfig;
  readonly origin: string;
  readonly tools: readonly ListedMcpTool[];
  active: boolean;
}

interface McpRuntime {
  readonly configPath: string;
  readonly connections: readonly McpConnection[];
}

interface RenderedMcpContent {
  readonly output: string;
  readonly attachments: readonly ToolAttachment[];
  readonly contentTypes: readonly string[];
}

/** 在 App Server 生命周期内复用并关闭 MCP 客户端连接。 */
export class McpManager {
  private readonly runtimes = new Map<string, Promise<McpRuntime>>();
  private readonly schemaValidator = new AjvJsonSchemaValidator();
  private closed = false;

  /** 加载配置中的 MCP 工具和资源工具。 */
  async toolsForConfig(
    config: Pick<CodingAgentConfig, 'cwd' | 'mcp_config_path'>,
  ): Promise<readonly AnyCodingTool[]> {
    if (this.closed) {
      throw new Error('MCP manager is closed.');
    }
    const configPath = resolveMcpConfigPath(config);
    let loading = this.runtimes.get(configPath);
    if (loading === undefined) {
      loading = this.loadRuntime(config);
      this.runtimes.set(configPath, loading);
    }
    let runtime: McpRuntime;
    try {
      runtime = await loading;
    } catch (error) {
      if (this.runtimes.get(configPath) === loading) {
        this.runtimes.delete(configPath);
      }
      throw error;
    }
    return this.createTools(runtime);
  }

  /** 关闭已建立的 MCP 连接及其 stdio 子进程。 */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.runtimes.values()];
    this.runtimes.clear();
    const loaded = await Promise.allSettled(pending);
    const errors: unknown[] = [];
    for (const result of loaded.reverse()) {
      if (result.status === 'rejected') continue;
      for (const connection of [...result.value.connections].reverse()) {
        connection.active = false;
        try {
          await connection.client.close();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Failed to close MCP connections.');
    }
  }

  private async loadRuntime(
    config: Pick<CodingAgentConfig, 'cwd' | 'mcp_config_path'>,
  ): Promise<McpRuntime> {
    const loaded = await loadMcpConfig(config);
    const connections: McpConnection[] = [];
    try {
      for (const [serverName, serverConfig] of Object.entries(
        loaded.config.servers,
      ).sort(([left], [right]) => left.localeCompare(right))) {
        if (!serverConfig.enabled) continue;
        connections.push(
          await this.connectServer(serverName, serverConfig, loaded),
        );
      }
      return { configPath: loaded.path, connections };
    } catch (error) {
      await Promise.allSettled(
        connections.map(async (connection) => {
          connection.active = false;
          await connection.client.close();
        }),
      );
      throw error;
    }
  }

  private async connectServer(
    serverName: string,
    config: McpServerConfig,
    loaded: LoadedMcpConfig,
  ): Promise<McpConnection> {
    const client = new Client({ name: 'ello', version: '1.0.0' });
    const serverCwd =
      'command' in config
        ? resolveMcpServerCwd(loaded.directory, config.cwd)
        : undefined;
    const transport =
      'command' in config
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            ...(config.env === undefined
              ? {}
              : { env: { ...getDefaultEnvironment(), ...config.env } }),
            ...(serverCwd === undefined ? {} : { cwd: serverCwd }),
          })
        : new StreamableHTTPClientTransport(new URL(config.url), {
            ...(config.headers === undefined
              ? {}
              : { requestInit: { headers: config.headers } }),
          });
    try {
      await client.connect(
        transport as unknown as Parameters<Client['connect']>[0],
        { timeout: config.timeout_ms },
      );
      const tools = await listAllTools(client, config.timeout_ms);
      return {
        serverName,
        client,
        config,
        origin: 'command' in config ? `mcp+stdio://${serverName}` : config.url,
        tools,
        active: true,
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new Error(
        `Failed to initialize MCP server '${serverName}' from '${loaded.path}': ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private createTools(runtime: McpRuntime): readonly AnyCodingTool[] {
    const tools: AnyCodingTool[] = [];
    const names = new Map<string, string>();
    for (const connection of runtime.connections) {
      for (const remote of connection.tools) {
        const exposedName = exposedToolName(connection.serverName, remote.name);
        registerExposedName(
          names,
          exposedName,
          `${connection.serverName}/${remote.name}`,
        );
        tools.push(this.createRemoteTool(connection, remote, exposedName));
      }
      if (connection.client.getServerCapabilities()?.resources !== undefined) {
        const listName = exposedToolName(
          connection.serverName,
          'list_resources',
        );
        const readName = exposedToolName(
          connection.serverName,
          'read_resource',
        );
        registerExposedName(
          names,
          listName,
          `${connection.serverName}/list_resources`,
        );
        registerExposedName(
          names,
          readName,
          `${connection.serverName}/read_resource`,
        );
        tools.push(
          createResourceListTool(connection, listName),
          createResourceReadTool(connection, readName),
        );
      }
    }
    return tools;
  }

  private createRemoteTool(
    connection: McpConnection,
    remote: ListedMcpTool,
    exposedName: string,
  ): AnyCodingTool {
    const validate = this.schemaValidator.getValidator<Record<string, unknown>>(
      remote.inputSchema as unknown as JsonSchemaType,
    );
    const initialCapabilities = mcpCapabilities(connection, remote);
    return defineCodingTool({
      name: exposedName,
      description: remote.description?.trim()
        ? `[MCP ${connection.serverName}] ${remote.description.trim()}`
        : `Call MCP tool '${remote.name}' on server '${connection.serverName}'.`,
      discovery: {
        aliases: [`${connection.serverName} ${remote.name}`],
        risk: initialCapabilities.readOnly ? 'readonly' : 'external',
      },
      input: z.record(z.string(), z.unknown()),
      inputJsonSchema:
        remote.inputSchema as unknown as AgentToolInputJsonSchema,
      capabilities: () => mcpCapabilities(connection, remote),
      validateInput: (input) => {
        const result = validate(input);
        if (!result.valid) {
          throw new Error(
            `Invalid arguments for MCP tool '${remote.name}': ${result.errorMessage}`,
          );
        }
      },
      execute: async (input, ctx) => {
        assertConnectionActive(connection);
        const result = await connection.client.callTool(
          { name: remote.name, arguments: input },
          undefined,
          requestOptions(connection.config.timeout_ms, ctx),
        );
        const rendered = renderToolResult(result);
        if (rendered.isError) {
          throw new Error(
            `MCP tool '${connection.serverName}/${remote.name}' failed: ${rendered.content.output}`,
          );
        }
        return createCodingToolResult({
          title: `${connection.serverName}/${remote.name}`,
          output: rendered.content.output,
          metadata: {
            kind: 'network',
            summary: `MCP ${connection.serverName}/${remote.name}`,
            url: connection.origin,
            domain: connection.serverName,
            server: connection.serverName,
            remoteTool: remote.name,
            contentTypes: rendered.content.contentTypes,
            structured: rendered.structured,
          },
          ...(rendered.content.attachments.length === 0
            ? {}
            : { attachments: rendered.content.attachments }),
        });
      },
    });
  }
}

async function listAllTools(
  client: Client,
  timeout: number,
): Promise<readonly ListedMcpTool[]> {
  const tools: ListedMcpTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(
      cursor === undefined ? undefined : { cursor },
      { timeout },
    );
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new Error(`MCP tools pagination repeated cursor '${cursor}'.`);
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== undefined);
  return tools;
}

function createResourceListTool(
  connection: McpConnection,
  name: string,
): AnyCodingTool {
  return defineCodingTool({
    name,
    description: `List resources exposed by MCP server '${connection.serverName}'.`,
    discovery: {
      aliases: [`${connection.serverName} resources list`],
      risk: 'readonly',
    },
    input: z.object({ cursor: z.string().min(1).optional() }).strict(),
    capabilities: () => resourceCapabilities(connection, 'resources.list'),
    execute: async ({ cursor }, ctx) => {
      assertConnectionActive(connection);
      const result = await connection.client.listResources(
        cursor === undefined ? undefined : { cursor },
        requestOptions(connection.config.timeout_ms, ctx),
      );
      return createCodingToolResult({
        title: `${connection.serverName} resources`,
        output: formatJson({
          resources: result.resources,
          ...(result.nextCursor === undefined
            ? {}
            : { nextCursor: result.nextCursor }),
        }),
        metadata: {
          kind: 'network',
          summary: `MCP ${connection.serverName} resources`,
          url: connection.origin,
          domain: connection.serverName,
          server: connection.serverName,
          resourceCount: result.resources.length,
          truncated: result.nextCursor !== undefined,
        },
      });
    },
  });
}

function createResourceReadTool(
  connection: McpConnection,
  name: string,
): AnyCodingTool {
  return defineCodingTool({
    name,
    description: `Read one resource by URI from MCP server '${connection.serverName}'.`,
    discovery: {
      aliases: [`${connection.serverName} resource read`],
      risk: 'readonly',
    },
    input: z.object({ uri: z.string().min(1) }).strict(),
    capabilities: () => resourceCapabilities(connection, 'resources.read'),
    execute: async ({ uri }, ctx) => {
      assertConnectionActive(connection);
      const result = await connection.client.readResource(
        { uri },
        requestOptions(connection.config.timeout_ms, ctx),
      );
      const rendered = renderResourceResult(result);
      return createCodingToolResult({
        title: `${connection.serverName} ${uri}`,
        output: rendered.output,
        metadata: {
          kind: 'network',
          summary: `MCP ${connection.serverName} resource`,
          url: connection.origin,
          domain: connection.serverName,
          server: connection.serverName,
          resourceUri: uri,
          contentTypes: rendered.contentTypes,
        },
        ...(rendered.attachments.length === 0
          ? {}
          : { attachments: rendered.attachments }),
      });
    },
  });
}

function mcpCapabilities(
  connection: McpConnection,
  tool: ListedMcpTool,
): AgentToolCapabilities {
  const readOnly = tool.annotations?.readOnlyHint === true;
  const destructive = readOnly
    ? tool.annotations?.destructiveHint === true
    : tool.annotations?.destructiveHint !== false;
  return {
    logicalName: exposedToolName(connection.serverName, tool.name),
    concurrencySafe: readOnly && !destructive,
    readOnly,
    destructive,
    interruptible: true,
    enabled: connection.active,
    telemetryTag: `mcp.${connection.serverName}.${tool.name}`,
  };
}

function resourceCapabilities(
  connection: McpConnection,
  telemetryTag: string,
): AgentToolCapabilities {
  return {
    logicalName: exposedToolName(
      connection.serverName,
      telemetryTag === 'resources.list' ? 'list_resources' : 'read_resource',
    ),
    concurrencySafe: true,
    readOnly: true,
    destructive: false,
    interruptible: true,
    enabled: connection.active,
    telemetryTag: `mcp.${connection.serverName}.${telemetryTag}`,
  };
}

function exposedToolName(serverName: string, remoteName: string): string {
  const segment = remoteName
    .trim()
    .replace(/[^A-Za-z0-9_-]+/gu, '_')
    .replace(/^_+|_+$/gu, '');
  if (segment === '') {
    throw new Error(
      `MCP server '${serverName}' returned an unusable tool name '${remoteName}'.`,
    );
  }
  const full = `mcp__${serverName}__${segment}`;
  if (full.length <= 64) return full;
  const suffix = createHash('sha256').update(full).digest('hex').slice(0, 8);
  return `${full.slice(0, 55)}_${suffix}`;
}

function registerExposedName(
  names: Map<string, string>,
  exposedName: string,
  source: string,
): void {
  const existing = names.get(exposedName);
  if (existing !== undefined) {
    throw new Error(
      `MCP tool name collision '${exposedName}' between '${existing}' and '${source}'.`,
    );
  }
  names.set(exposedName, source);
}

function requestOptions(
  timeout: number,
  ctx: CodingToolContext,
): { readonly timeout: number; readonly signal?: AbortSignal } {
  return {
    timeout,
    ...(ctx.abortSignal === undefined ? {} : { signal: ctx.abortSignal }),
  };
}

function assertConnectionActive(connection: McpConnection): void {
  if (!connection.active) {
    throw new Error(`MCP server '${connection.serverName}' is closed.`);
  }
}

function renderToolResult(result: McpCallResult): {
  readonly content: RenderedMcpContent;
  readonly structured: unknown;
  readonly isError: boolean;
} {
  if ('toolResult' in result) {
    return {
      content: {
        output: formatJson(result.toolResult),
        attachments: [],
        contentTypes: ['legacy'],
      },
      structured: result.toolResult,
      isError: false,
    };
  }
  const content = renderContent(result.content);
  const structured = result.structuredContent;
  return {
    content:
      structured === undefined
        ? content
        : {
            ...content,
            output: [content.output, formatJson(structured)]
              .filter((part) => part !== '')
              .join('\n\n'),
          },
    structured,
    isError: result.isError === true,
  };
}

function renderResourceResult(result: McpResourceResult): RenderedMcpContent {
  return renderContent(
    result.contents.map((resource) => ({
      type: 'resource' as const,
      resource,
    })),
  );
}

function renderContent(content: readonly unknown[]): RenderedMcpContent {
  const output: string[] = [];
  const attachments: ToolAttachment[] = [];
  const contentTypes: string[] = [];
  for (const item of content) {
    const parsed = McpContentSchema.parse(item);
    contentTypes.push(parsed.type);
    switch (parsed.type) {
      case 'text':
        output.push(parsed.text);
        break;
      case 'image':
        output.push(`[Image attachment: ${parsed.mimeType}]`);
        attachments.push({
          type: 'image',
          mime: parsed.mimeType,
          content: parsed.data,
          bytes: Buffer.from(parsed.data, 'base64').byteLength,
        });
        break;
      case 'audio':
        output.push(`[Audio attachment: ${parsed.mimeType}]`);
        attachments.push({
          type: 'binary',
          mime: parsed.mimeType,
          content: parsed.data,
          bytes: Buffer.from(parsed.data, 'base64').byteLength,
        });
        break;
      case 'resource':
        output.push(`Resource ${parsed.resource.uri}`);
        if (typeof parsed.resource.text === 'string') {
          output.push(parsed.resource.text);
        } else {
          const blob = parsed.resource.blob;
          if (typeof blob !== 'string') {
            throw new Error(
              `MCP resource '${parsed.resource.uri}' has neither text nor binary content.`,
            );
          }
          output.push(
            `[Binary resource attachment: ${parsed.resource.mimeType ?? 'application/octet-stream'}]`,
          );
          attachments.push({
            type: 'binary',
            mime: parsed.resource.mimeType ?? 'application/octet-stream',
            name: parsed.resource.uri,
            content: blob,
            bytes: Buffer.from(blob, 'base64').byteLength,
          });
        }
        break;
      case 'resource_link':
        output.push(formatJson(parsed));
        break;
    }
  }
  return {
    output: output.join('\n'),
    attachments,
    contentTypes: [...new Set(contentTypes)],
  };
}

const AnnotationsSchema = z
  .object({
    audience: z.array(z.enum(['user', 'assistant'])).optional(),
    priority: z.number().optional(),
    lastModified: z.string().optional(),
  })
  .passthrough()
  .optional();

const ResourceDataSchema = z.union([
  z
    .object({
      uri: z.string(),
      text: z.string(),
      mimeType: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      uri: z.string(),
      blob: z.string(),
      mimeType: z.string().optional(),
    })
    .passthrough(),
]);

const McpContentSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('text'),
      text: z.string(),
      annotations: AnnotationsSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('image'),
      data: z.string(),
      mimeType: z.string(),
      annotations: AnnotationsSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('audio'),
      data: z.string(),
      mimeType: z.string(),
      annotations: AnnotationsSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('resource'),
      resource: ResourceDataSchema,
      annotations: AnnotationsSchema,
    })
    .passthrough(),
  z
    .object({
      type: z.literal('resource_link'),
      uri: z.string(),
      name: z.string(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
      size: z.number().optional(),
      annotations: AnnotationsSchema,
    })
    .passthrough(),
]);

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
