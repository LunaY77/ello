/**
 * 本文件把内部任务快照收窄为公开协议投影。
 *
 * summary 不包含 prompt、permission rules、sidechain 或内部 run 句柄，避免 TUI 意外依赖运行细节。
 */
import {
  JsonValueSchema,
  type AgentTaskDetail,
  type AgentTaskEvent as ProtocolAgentTaskEvent,
  type AgentTaskSummary,
  type AgentTaskTreeSnapshot,
} from '../../../protocol/v1/index.js';

import type {
  AgentTask,
  AgentTaskEvent,
  AgentTaskSnapshot,
} from './task-types.js';

/** 把持久 task 转为列表与通知共享的公开摘要。 */
export function agentTaskSummary(task: AgentTask): AgentTaskSummary {
  return {
    taskId: task.id,
    agentId: task.agentId,
    rootThreadId: task.rootThreadId,
    ...(task.parentTaskId === undefined
      ? {}
      : { parentTaskId: task.parentTaskId }),
    ...(task.resumeFromTaskId === undefined
      ? {}
      : { resumeFromTaskId: task.resumeFromTaskId }),
    ...(task.name === undefined ? {} : { name: task.name }),
    definitionName: task.definitionName,
    description: task.description,
    contextMode: task.contextMode,
    executionMode: task.executionMode,
    status: task.status,
    cwd: task.cwd,
    isolation: task.isolation,
    revision: task.revision,
    eventSequence: task.eventSequence,
    ...(task.usage === undefined ? {} : { usage: task.usage }),
    ...(task.currentTool === undefined
      ? {}
      : { currentTool: task.currentTool }),
    toolCount: task.toolCount,
    recentTools: task.recentTools,
    ...(task.resultPreview === undefined
      ? {}
      : { resultPreview: task.resultPreview }),
    ...(task.errorPreview === undefined
      ? {}
      : { errorPreview: task.errorPreview }),
    createdAt: task.createdAt,
    ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
    ...(task.completedAt === undefined
      ? {}
      : { completedAt: task.completedAt }),
    updatedAt: task.updatedAt,
  };
}

/** 把内部 append-only event 转为严格 JSON 协议事件。 */
export function agentTaskEvent(event: AgentTaskEvent): ProtocolAgentTaskEvent {
  return {
    rootThreadId: event.rootThreadId,
    taskId: event.taskId,
    sequence: event.sequence,
    rootSequence: event.rootSequence,
    eventType: event.eventType,
    payload: JsonValueSchema.parse(event.payload),
    createdAt: event.createdAt,
  };
}

/** 把带 root sequence 的 Store 快照转为 subscribe/list 响应。 */
export function agentTaskTreeSnapshot(
  snapshot: AgentTaskSnapshot,
): AgentTaskTreeSnapshot {
  return {
    rootThreadId: snapshot.rootThreadId,
    seq: snapshot.rootSequence,
    tasks: snapshot.tasks.map(agentTaskSummary),
  };
}

/** 组装 task header、结果与完整 transcript。 */
export function agentTaskDetail(
  task: AgentTask,
  events: readonly AgentTaskEvent[],
): AgentTaskDetail {
  return {
    task: agentTaskSummary(task),
    prompt: task.prompt,
    ...(task.output === undefined ? {} : { output: task.output }),
    ...(task.errorMessage === undefined ? {} : { error: task.errorMessage }),
    events: events.map(agentTaskEvent),
  };
}
