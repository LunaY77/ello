/**
 * 本文件负责 tool feature 的“meta-tools”模块职责。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
import { z, ZodError } from 'zod';

import { isRecord } from '../../../protocol/json-value.js';
import {
  createAgentMessage,
  defineTool,
  type AgentApprovalDecision,
  type AgentMessage,
  type AgentTool,
  type AnyAgentTool,
} from '../../agent/engine/index.js';

import type { ToolSearchIndex } from './search-index.js';
import { createToolSearchIndex } from './search-index.js';

/** tool_search/call_tool 不能再次作为 call_tool 的目标，避免递归和协议歧义。 */
const META_TOOL_NAMES = new Set(['tool_search', 'call_tool']);

export const TOOL_ROUTING_INSTRUCTIONS = `# Tool Routing Protocol

- Core tools already present in your tool list are directly callable and must keep using native tool calls.
- \`tool_search\` and \`call_tool\` are only for non-core deferred tools that are absent from your tool list.
- Use \`tool_search\` to discover unknown capabilities and obtain the exact target name and input schema.
- Omit \`tool_search.query\`, or use a query such as \`all tools\`, to list lightweight summaries of the current mode's targets. Follow \`nextOffset\` while \`truncated\` is true, then search an exact tool name to get its input schema.
- Tool availability is mode-scoped. Plan-only core tools appear directly only after the user enters Plan mode with \`/plan <task>\`.
- To execute a discovered deferred tool, call \`call_tool\` with \`{"name":"<exact target name>","arguments":{...}}\`.
- Names and schemas returned by \`tool_search\` are discovery data only; they do not become directly callable tools.
- Never invent a target tool name or target arguments. \`call_tool.arguments\` must match the schema returned by \`tool_search\`.`;

/**
 * 为当前目标工具集合创建“执行全集”和“模型可见集合”。
 *
 * Args:
 * - `targetTools`: `createMetaToolRuntime` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `directTools`: `createMetaToolRuntime` 所需的业务值；函数按声明读取，不补造缺失内容。
 * - `config`: 已解析的稳定配置；作为装配输入读取，函数不在原对象上写入状态。
 *
 * Returns:
 * - 返回谓词判断结果；`true` 与 `false` 分别对应声明中的满足与不满足状态。
 *
 * Throws:
 * - 当 工具 `meta-tools` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createMetaToolRuntime(
  targetTools: readonly AnyAgentTool[],
  directTools: readonly AnyAgentTool[],
  config: {
    readonly routing_enabled: boolean;
    readonly search: {
      readonly result_limit: number;
      readonly max_result_bytes: number;
    };
  },
): {
  readonly executionTools: readonly AnyAgentTool[];
  readonly modelTools: readonly AnyAgentTool[];
  readonly usesToolRouting: boolean;
} {
  if (!config.routing_enabled) {
    const tools =
      directTools.length === 0 ? targetTools : [...targetTools, ...directTools];
    return {
      executionTools: tools,
      modelTools: tools,
      usesToolRouting: false,
    };
  }
  const coreTools = targetTools.filter((tool) => tool.discovery.core === true);
  const deferredTools = targetTools.filter(
    (tool) => tool.discovery.core !== true,
  );
  if (deferredTools.length === 0) {
    const tools = [...targetTools, ...directTools];
    return {
      executionTools: tools,
      modelTools: tools,
      usesToolRouting: false,
    };
  }
  const toolSearch = createToolSearchTool({
    index: createToolSearchIndex(deferredTools),
    resultLimit: config.search.result_limit,
    maxResultBytes: config.search.max_result_bytes,
  });
  const callTool = createCallTool(deferredTools);
  const modelTools = [...coreTools, ...directTools, toolSearch, callTool];
  return {
    executionTools: [...targetTools, ...directTools, toolSearch, callTool],
    modelTools,
    usesToolRouting: true,
  };
}

/**
 * 构造 工具 `meta-tools` 模块 中的 `createToolSearchTool` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `options`: 仅作用于 `createToolSearchTool` 的调用选项；函数只读取该对象，不保留可变引用。
 *
 * Returns:
 * - 返回 `createToolSearchTool` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `meta-tools` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createToolSearchTool(options: {
  readonly index: ToolSearchIndex;
  readonly resultLimit: number;
  readonly maxResultBytes: number;
}): AgentTool<unknown, unknown> {
  // limit 控制单次返回数量，字节上限防止 schema 结果撑爆上下文。
  if (
    !Number.isInteger(options.resultLimit) ||
    options.resultLimit < 1 ||
    options.resultLimit > 8
  ) {
    throw new Error('tool_search resultLimit must be an integer from 1 to 8.');
  }
  if (!Number.isInteger(options.maxResultBytes) || options.maxResultBytes < 1) {
    throw new Error('tool_search maxResultBytes must be a positive integer.');
  }
  return defineTool({
    name: 'tool_search',
    description:
      'Search target tools by capability, or omit query to page through lightweight summaries of tools available in the current mode. Returned names are not directly callable; execute targets only through call_tool.',
    discovery: { aliases: ['find tool'], risk: 'readonly', core: true },
    input: z
      .object({
        query: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Search query for tool capabilities'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(options.resultLimit)
          .describe('Maximum number of results'),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Pagination offset for inventory mode'),
      })
      .strict(),
    execute: ({ query, limit, offset = 0 }) => {
      const inventory = query === undefined || isInventoryQuery(query);
      if (!inventory && offset !== 0) {
        throw new Error('tool_search offset is only valid for inventory mode.');
      }
      const results = inventory
        ? options.index.list(limit, offset)
        : options.index.search(query, limit);
      const nextOffset = offset + results.length;
      const result = {
        results,
        totalAvailableTools: options.index.size,
        inventory,
        offset,
        truncated: inventory && nextOffset < options.index.size,
        ...(inventory && nextOffset < options.index.size ? { nextOffset } : {}),
      };
      const bytes = Buffer.byteLength(JSON.stringify(result));
      if (bytes > options.maxResultBytes) {
        throw new Error(
          `tool_search result is ${bytes} bytes, exceeding ${options.maxResultBytes}.`,
        );
      }
      return result;
    },
  });
}

function isInventoryQuery(query: string): boolean {
  return /^(?:all|available|current|list|show)(?:\s+(?:all|available|current))?\s+tools?$/iu.test(
    query.trim(),
  );
}

/**
 * 构造 工具 `meta-tools` 模块 中的 `createCallTool` 结果，并在返回前建立所需的不变量。
 *
 * Args:
 * - `targetTools`: `createCallTool` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `createCallTool` 计算出的声明结果；返回值不包含未声明的兜底状态。
 *
 * Throws:
 * - 当 工具 `meta-tools` 模块 的输入、状态或外部资源不满足契约时直接抛错，并保留底层失败原因。
 */
export function createCallTool(
  targetTools: readonly AnyAgentTool[],
): AgentTool<unknown, unknown> {
  // 目标表只在 runtime 构建时生成，调用期间不再按名称猜测或补全工具。
  const targets = new Map<string, AgentTool<unknown, unknown>>();
  for (const tool of targetTools) {
    if (tool.execution !== 'immediate') {
      throw new Error(`call_tool target cannot be deferred: ${tool.name}`);
    }
    if (META_TOOL_NAMES.has(tool.name)) {
      throw new Error(`call_tool target cannot be a meta tool: ${tool.name}`);
    }
    if (targets.has(tool.name)) {
      throw new Error(`Duplicate call_tool target: ${tool.name}`);
    }
    targets.set(tool.name, tool);
  }
  if (targets.size === 0) {
    throw new Error('call_tool requires at least one target tool.');
  }
  const inputSchema = z
    .object({
      name: z
        .string()
        .min(1)
        .describe('Exact target tool name returned by tool_search'),
      arguments: z
        .record(z.string(), z.unknown())
        .describe('Arguments matching the target tool schema'),
    })
    .strict();
  type CallToolInput = z.infer<typeof inputSchema>;

  /** 审批和执行共用同一解析函数，确保两阶段使用完全相同的类型化参数。 */
  const resolveTargetCall = (input: CallToolInput) => {
    if (META_TOOL_NAMES.has(input.name)) {
      throw new Error(`call_tool cannot recursively call '${input.name}'.`);
    }
    const target = targets.get(input.name);
    if (target === undefined) {
      throw new Error(
        `Unknown or disabled target tool: ${input.name}. Available targets: ${[
          ...targets.keys(),
        ].join(', ')}`,
      );
    }
    try {
      return { target, input: target.input.parse(input.arguments) };
    } catch (error) {
      if (error instanceof ZodError) {
        const issues = error.issues
          .map(
            (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
          )
          .join('; ');
        throw new Error(
          `Invalid arguments for tool '${input.name}': ${issues}`,
          { cause: error },
        );
      }
      throw error;
    }
  };

  return defineTool({
    name: 'call_tool',
    description:
      'Call one available tool by its exact name using arguments that match the schema returned by tool_search.',
    discovery: { aliases: ['invoke tool'], risk: 'external', core: true },
    input: inputSchema,
    approval: async (input, context) => {
      const resolved = resolveTargetCall(input);
      const decision = await resolved.target.approval?.(
        resolved.input,
        context,
      );
      return proxyApprovalDecision(input.name, decision);
    },
    execute: async (input, context) => {
      const resolved = resolveTargetCall(input);
      return resolved.target.execute(resolved.input, context);
    },
  });
}

function proxyApprovalDecision(
  targetName: string,
  decision: AgentApprovalDecision | undefined,
): AgentApprovalDecision {
  // 审批 metadata 必须带上原始工具名，供恢复、规则持久化和 UI 解包使用。
  if (decision === undefined || decision === 'auto') {
    return 'auto';
  }
  if (typeof decision === 'string') {
    if (decision === 'required') {
      throw new Error(
        `Tool '${targetName}' requires approval but provided no policy metadata.`,
      );
    }
    return decision;
  }
  if (decision.action === 'required') {
    assertPolicyMetadata(targetName, decision.metadata);
  }
  return {
    ...decision,
    metadata: { ...(decision.metadata ?? {}), proxiedTool: targetName },
  };
}

function assertPolicyMetadata(
  targetName: string,
  metadata: Record<string, unknown> | undefined,
): void {
  if (metadata === undefined) {
    throw new Error(`Tool '${targetName}' approval metadata is missing.`);
  }
  if (typeof metadata.permission !== 'string') {
    throw new Error(`Tool '${targetName}' approval metadata lacks permission.`);
  }
  for (const key of ['patterns', 'always'] as const) {
    if (
      !Array.isArray(metadata[key]) ||
      !metadata[key].every((value) => typeof value === 'string')
    ) {
      throw new Error(`Tool '${targetName}' approval metadata lacks ${key}.`);
    }
  }
}

export interface LogicalToolCall {
  readonly name: string;
  readonly input: unknown;
}

/**
 * 执行 工具 `meta-tools` 模块 定义的 `logicalToolCall` 领域操作，输入和副作用均受该边界约束。
 *
 * Args:
 * - `call`: `logicalToolCall` 所需的业务值；函数按声明读取，不补造缺失内容。
 *
 * Returns:
 * - 返回 `logicalToolCall` 计算出的声明结果；返回值不包含未声明的兜底状态。
 */
export function logicalToolCall(call: LogicalToolCall): LogicalToolCall {
  if (call.name !== 'call_tool') {
    return call;
  }
  const parsed = z
    .object({
      name: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()),
    })
    .strict()
    .parse(call.input);
  return { name: parsed.name, input: parsed.arguments };
}

/**
 * 将 transcript 中的 wrapper 消息投影为用户可见的逻辑工具消息。
 *
 * Args:
 * - `messages`: 按既定顺序提供的只读集合；函数不会重排或修改调用方持有的集合。
 *
 * Returns:
 * - 返回按领域顺序排列的快照集合；调用方不能借此修改内部状态。
 */
export function projectToolMessages(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  const names = new Map<string, string>();
  return messages.map((message) => {
    const content = Reflect.get(message, 'content');
    if (!Array.isArray(content)) {
      return message;
    }
    const parts: ReadonlyArray<unknown> = content;
    const projected = parts.map((part) => {
      if (!isRecord(part)) {
        return part;
      }
      const id =
        readPartString(part, 'toolCallId') ?? readPartString(part, 'id');
      if (part.type === 'tool-call') {
        const name =
          readPartString(part, 'toolName') ?? readPartString(part, 'name');
        if (id === undefined || name === undefined) {
          throw new Error('Transcript tool call lacks id or name.');
        }
        const logical = logicalToolCall({
          name,
          input: part.input ?? part.args,
        });
        names.set(id, logical.name);
        return {
          ...part,
          ...(part.toolName !== undefined
            ? { toolName: logical.name }
            : { name: logical.name }),
          ...(part.input !== undefined
            ? { input: logical.input }
            : { args: logical.input }),
        };
      }
      if (part.type === 'tool-result') {
        if (id === undefined) {
          throw new Error('Transcript tool result lacks toolCallId.');
        }
        const name = names.get(id);
        if (name === undefined) {
          throw new Error(`Transcript tool result has no matching call: ${id}`);
        }
        return {
          ...part,
          ...(part.toolName !== undefined
            ? { toolName: name }
            : part.name !== undefined
              ? { name }
              : {}),
        };
      }
      return part;
    });
    return createAgentMessage({ ...message, content: projected });
  });
}

function readPartString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
