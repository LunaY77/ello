import type { ModelMessage } from 'ai';

import type { RuntimeToolset } from '../agents.js';
import type { AgentContext } from '../context.js';
import type {
  DeferredToolApprovalRequest,
  DeferredToolApprovalResult,
} from '../state.js';
import type { ToolArgs } from '../toolsets/index.js';

export function buildApprovalToolCallMessage(
  request: DeferredToolApprovalRequest,
): ModelMessage {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool-call',
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        input: request.input ?? {},
      },
    ],
  };
}

export function buildApprovalToolResultMessage(options: {
  request: DeferredToolApprovalRequest;
  result: unknown;
}): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: options.request.toolCallId,
        toolName: options.request.toolName,
        output: { type: 'text', value: stringifyToolResult(options.result) },
      },
    ],
  };
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function resolveApprovalResult(options: {
  request: DeferredToolApprovalRequest;
  decision: DeferredToolApprovalResult;
  ctx: AgentContext;
  toolsets: RuntimeToolset[];
  inputOverride?: unknown;
}): Promise<unknown> {
  const normalized = normalizeApprovalDecision(options.decision);
  if (!normalized.approved) {
    return `denied: ${normalized.reason ?? 'not approved'}`;
  }

  const tool = await findTool(options.request, options.ctx, options.toolsets);
  if (tool === null) {
    return `Error: approved tool '${options.request.toolName}' not found`;
  }
  const input = options.inputOverride ?? options.request.input ?? {};
  return tool.toolset.callTool(
    options.request.toolName,
    input as ToolArgs,
    { deps: options.ctx },
    tool.toolDef,
  );
}

export function normalizeApprovalDecision(
  decision: DeferredToolApprovalResult,
): {
  approved: boolean;
  reason?: string;
} {
  if (typeof decision === 'boolean') {
    return { approved: decision };
  }
  return {
    approved: decision.approved,
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
  };
}

async function findTool(
  request: DeferredToolApprovalRequest,
  ctx: AgentContext,
  toolsets: RuntimeToolset[],
): Promise<{
  toolset: RuntimeToolset;
  toolDef: Awaited<ReturnType<RuntimeToolset['getTools']>>[string];
} | null> {
  for (const toolset of toolsets) {
    const tools = await toolset.getTools({ deps: ctx });
    const toolDef = tools[request.toolName];
    if (toolDef !== undefined) {
      return { toolset, toolDef };
    }
  }
  return null;
}
