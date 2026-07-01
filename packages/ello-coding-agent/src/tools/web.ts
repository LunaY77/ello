import { z } from 'zod';

import type { CodingAgentConfig } from '../config/index.js';
import type { DecideApproval } from '../permission/policy.js';
import type { PermissionMetadata } from '../permission/types.js';

import {
  createCodingToolResult,
  defineCodingTool,
} from './runtime/coding-tool.js';
import { truncate } from './shared.js';

/**
 * 网络工具：web_fetch。
 *
 * 真正发 `fetch`，默认审批 `required`（网络副作用）。`web_search` 依赖外部
 * adapter，未配置时**不注册**（不再注册一个返回占位文本的假工具）
 */
export function webFetchTool(
  _config: CodingAgentConfig,
  decide: DecideApproval,
) {
  return defineCodingTool({
    name: 'web_fetch',
    description: 'Fetch a URL. Network access requires approval by default.',
    input: z.object({ url: z.string().url() }),
    approval: async (input, ctx) =>
      decide(
        {
          permission: 'web_fetch',
          patterns: [new URL(input.url).hostname],
          always: [new URL(input.url).hostname],
          metadata: networkMetadata(input.url),
        },
        ctx.agent,
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
 * `web_fetch` 依赖运行时全局 `fetch`；缺少该能力时不注册工具。
 */
export function canFetch(_config: CodingAgentConfig): boolean {
  return typeof fetch === 'function';
}

function networkMetadata(
  url: string,
): Extract<PermissionMetadata, { kind: 'network' }> {
  const parsed = new URL(url);
  return {
    kind: 'network',
    url,
    domain: parsed.hostname,
  };
}
