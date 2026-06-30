import { z } from 'zod';

import type { CodingAgentConfig } from '../config/index.js';

import {
  createCodingToolResult,
  defineCodingTool,
  type ToolMetadata,
} from './runtime/coding-tool.js';
import { truncate, type ApprovalFor } from './shared.js';

/**
 * 网络工具：web_fetch。
 *
 * 真正发 `fetch`，默认审批 `required`（网络副作用）。`web_search` 依赖外部
 * adapter，未配置时**不注册**（不再注册一个返回占位文本的假工具）
 */
export function webFetchTool(
  _config: CodingAgentConfig,
  approval: ApprovalFor,
) {
  return defineCodingTool({
    name: 'web_fetch',
    description: 'Fetch a URL. Network access requires approval by default.',
    input: z.object({ url: z.string().url() }),
    approval: async (input, ctx) =>
      withNetworkApprovalMetadata(
        await approval('web_fetch')(input as never, ctx.agent),
        networkMetadata(input.url),
      ),
    execute: async ({ url }) => {
      const response = await fetch(url);
      const text = await response.text();
      return createCodingToolResult({
        title: `Fetch ${url}`,
        output: truncate(text),
        metadata: {
          ...networkMetadata(url),
          status: response.status,
          contentType: response.headers.get('content-type') ?? undefined,
          bytes: Buffer.byteLength(text),
        },
      });
    },
  });
}

/**
 * 是否允许注册网络工具。
 *
 * v1 默认允许 `web_fetch`（运行时有全局 `fetch`）。预留 config 钩子，
 * 后续可按策略/离线模式关闭。
 */
export function canFetch(_config: CodingAgentConfig): boolean {
  return typeof fetch === 'function';
}

function networkMetadata(url: string): ToolMetadata {
  const parsed = new URL(url);
  return {
    kind: 'network',
    url,
    domain: parsed.hostname,
  };
}

function withNetworkApprovalMetadata(
  decision: Awaited<ReturnType<ReturnType<ApprovalFor>>>,
  metadata: ToolMetadata,
): typeof decision {
  if (typeof decision === 'string') {
    return { action: decision, metadata };
  }
  return {
    ...decision,
    metadata: { ...metadata, ...(decision.metadata ?? {}) },
  };
}
