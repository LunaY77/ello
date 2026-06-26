/**
 * Agent 生命周期状态枚举。
 */
export const LifecycleStatus = {
  started: 'started',
  completed: 'completed',
  error: 'error',
} as const;

/** Agent 生命周期状态字符串类型。 */
export type LifecycleStatus =
  (typeof LifecycleStatus)[keyof typeof LifecycleStatus];

/**
 * Agent 事件基类。
 *
 * Args:
 *   runId: 所属运行的唯一标识。
 *   timestamp: 事件发生的 UTC 时间戳。
 */
export interface AgentEvent {
  runId: string;
  timestamp: Date;
}

/**
 * Agent 生命周期事件, 标记运行的开始、完成或错误。
 */
export interface LifecycleEvent extends AgentEvent {
  status: LifecycleStatus;
}

/**
 * Token 使用量快照事件。
 */
export interface UsageSnapshotEvent extends AgentEvent {
  totalTokens?: number | null;
  requestTokens?: number | null;
  responseTokens?: number | null;
}

/**
 * 上下文压缩完成事件。
 */
export interface CompactEvent extends AgentEvent {
  summaryPreview: string;
  originalMessageCount: number;
  compactedMessageCount: number;
}

/**
 * Subagent 启动事件。
 */
export interface SubagentStartEvent extends AgentEvent {
  agentId: string;
  agentName: string;
  promptPreview: string;
}

/**
 * Subagent 完成事件。
 */
export interface SubagentCompleteEvent extends AgentEvent {
  agentId: string;
  agentName: string;
  success: boolean;
  resultPreview: string;
  error?: string;
}

/**
 * 流式执行开始事件。
 */
export interface StreamStartEvent extends AgentEvent {
  promptPreview: string;
}

/**
 * 流式执行完成事件。
 */
export interface StreamCompleteEvent extends AgentEvent {
  success: boolean;
  totalTokens?: number | null;
  error?: string;
}
