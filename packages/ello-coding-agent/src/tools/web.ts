import { defineTool, type AnyAgentTool } from '@ello/agent';
import { z } from 'zod';

import type { CodingAgentConfig } from '../config.js';

import { truncate, type ApprovalFor } from './shared.js';

/**
 * 网络工具：web_fetch。
 *
 * 真正发 `fetch`，默认审批 `required`（网络副作用）。`web_search` 依赖外部
 * adapter，未配置时**不注册**（不再注册一个返回占位文本的假工具）；`tool_search`
 * v1 直接砍掉。
 */
export function webFetchTool(approval: ApprovalFor): AnyAgentTool {
  return defineTool({
    name: 'web_fetch',
    description: 'Fetch a URL. Network access requires approval by default.',
    input: z.object({ url: z.string().url() }),
    approval: approval('web_fetch'),
    execute: async ({ url }) => {
      const response = await fetch(url);
      return {
        url,
        status: response.status,
        text: truncate(await response.text()),
      };
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
