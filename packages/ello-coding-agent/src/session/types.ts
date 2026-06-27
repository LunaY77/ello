import type { AgentStreamEvent, AgentUsage } from '@ello/agent';

import type { CodingAgentConfig } from '../config.js';
import type { JsonlSessionSummary } from '../jsonl-session-storage.js';
import type { TaskRecord } from '../task-manager.js';

/**
 * CodingAgentSession 发出的产品侧事件流。
 *
 * 会话层刻意保持这个接口小而面向 UI，让 CLI/TUI 无需导入核心
 * Agent 稳定接口即可渲染。
 */
export type CodingAgentEvent =
  | { type: 'session_started'; sessionId: string; config: CodingAgentConfig }
  | { type: 'core_event'; event: AgentStreamEvent }
  | {
      type: 'usage_snapshot';
      runId: string;
      totalUsage: AgentUsage;
      modelUsage: Record<string, AgentUsage>;
      agentUsage: Record<string, { agentName: string; modelId: string; usage: AgentUsage; source: string }>;
    }
  | { type: 'run_started'; runId: string; input: string }
  | { type: 'run_finished'; runId: string; success: boolean; error?: string }
  | { type: 'task_snapshot'; tasks: TaskRecord[] }
  | { type: 'memory_loaded'; files: Array<{ scope: string; path: string }> }
  | {
      type: 'permission_decision';
      toolCallId: string;
      toolName: string;
      action: string;
      reason: string;
    }
  | {
      type: 'tool_display';
      status: 'started' | 'finished';
      toolCallId: string;
      toolName: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
      startedAt?: string;
      finishedAt?: string;
      durationMs?: number;
    }
  | {
      type: 'approval_request';
      toolCallId: string;
      toolName: string;
      input: unknown;
      risk: string;
    }
  | { type: 'sessions_listed'; sessions: JsonlSessionSummary[] }
  | { type: 'model_switched'; model: string }
  | { type: 'compacted'; message: string }
  | { type: 'diagnostic'; level: 'info' | 'warn' | 'error'; message: string };
