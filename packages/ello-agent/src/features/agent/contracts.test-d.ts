/**
 * 产品 Agent 类型契约测试锁定 Thread 请求、产品运行结果与 engine 运行结果之间的边界。
 *
 * 本文件只参与 TypeScript 编译，不拥有运行时状态；任何一层新增字段或误用另一层 DTO 都应使
 * typecheck 失败，避免产品状态渗入通用 engine。
 */
import type { ThreadSnapshot } from '../../protocol/v1/index.js';

import type {
  AgentRunEvent,
  AgentRunRequest,
  AgentRunResult,
} from './contracts.js';
import type {
  AgentEnvironment,
  AgentRunResult as EngineAgentRunResult,
  AgentUsage,
  CreateAgentOptions,
} from './engine/index.js';

type EnvironmentIsRequired = CreateAgentOptions extends {
  readonly environment: AgentEnvironment;
}
  ? true
  : false;

const environmentIsRequired: EnvironmentIsRequired = true;
environmentIsRequired satisfies true;

const usage: AgentUsage = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  toolCalls: 0,
};

const request = {
  threadId: 'thread_type_contract',
  turnId: 'turn_type_contract',
  cwd: '/workspace',
  selection: {
    mode: 'ask-before-changes',
    profile: 'main',
    model: 'provider/model',
    agent: 'build',
  },
  history: [{ role: 'user', content: '已有消息' }],
  input: '继续执行',
  goal: null,
  permission: {
    rules: () => [],
    externalPaths: () => [],
  },
} satisfies AgentRunRequest;

request satisfies AgentRunRequest;

const productResult = {
  status: 'completed',
  usage,
} satisfies AgentRunResult;

declare const engineResult: EngineAgentRunResult;
declare const snapshot: ThreadSnapshot;

engineResult satisfies EngineAgentRunResult;

// @ts-expect-error 产品 Agent 结果不包含 engine 的消息、诊断和 finish reason。
productResult satisfies EngineAgentRunResult;

// @ts-expect-error Thread snapshot 不能替代稳定的 AgentRunRequest。
snapshot satisfies AgentRunRequest;

/**
 * 穷举产品 Agent 事件的判别字段，新增事件时要求调用边界同步更新。
 *
 * Args:
 * - `event`: 产品 Agent 对 Thread 发布的单个执行事实，保持完整对象直到判别完成。
 *
 * Returns:
 * - 返回事件类型本身，仅用于证明联合分支已被完整覆盖。
 */
function eventType(event: AgentRunEvent): AgentRunEvent['type'] {
  switch (event.type) {
    case 'messageStarted':
    case 'messageDelta':
    case 'messageCompleted':
    case 'toolStarted':
    case 'toolCompleted':
    case 'toolFailed':
    case 'interactionRequired':
    case 'messagesAppended':
    case 'contextCompacted':
    case 'runFailed':
      return event.type;
    default:
      event satisfies never;
      throw new Error('Unhandled product Agent event.');
  }
}

eventType satisfies (event: AgentRunEvent) => AgentRunEvent['type'];
