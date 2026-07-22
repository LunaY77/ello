/**
 * 本文件负责 agent feature 的公开入口与 factory。
 *
 * 状态由本模块声明的对象、闭包或 store 显式持有；跨 feature 依赖只能进入对方公开入口。
 * 外部输入在边界完成校验，非法状态和资源失败直接抛出，调用顺序由公开契约约束。
 */
export { createAgent } from './agent.js';
export { createAgentMessage } from './messages.js';
export {
  AgentStreamBackpressureError,
  ModelAdapterProtocolError,
} from './errors.js';
export { defineAnyTool, defineDeferredTool, defineTool } from './tools.js';
export {
  compactMessages,
  dynamicSystemSection,
  joinSystemCacheSegments,
  preserveToolCallPairs,
  skillIndexContext,
  splitSystemCacheSegments,
  trimMessages,
  wrapDynamicSystemContent,
} from './model-input.js';
export { createEmptyUsage, mapAiSdkUsage } from './result.js';
export { createToolCallMessage } from './tools.js';
export { z } from 'zod';
export type * from './contracts.js';
export type * from './model.js';
export type * from './events.js';
export type * from './tools.js';
