import type { AgentStreamEvent, AgentUsage } from '@ello/agent';

/**
 * 用户输入的产品层表示。
 *
 * prompt 是进入模型的文本；source 用于区分普通提交、运行中 steering 和
 * 完成后的 follow-up，方便 TUI 和 RPC 明确展示队列状态。
 */
export interface UserSubmission {
  readonly prompt: string;
  readonly source?: 'submit' | 'steer' | 'follow-up' | 'command';
  readonly metadata?: Record<string, unknown>;
}

/** 会话在产品层和 JSONL 文件中的稳定摘要。 */
export interface SessionInfo {
  readonly sessionId: string;
  readonly cwd: string;
  readonly path: string;
  readonly createdAt: string;
  readonly activeEntryId?: string;
}

/** 工具调用渲染模型，供 CLI/TUI/RPC 共享。 */
export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly status: 'pending' | 'running' | 'success' | 'error' | 'denied';
  readonly input?: unknown;
  readonly output?: unknown;
  readonly error?: string;
  readonly summary: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly argsPreview?: string;
  readonly outputPreview?: string;
  readonly preview?: string;
  readonly render?: ToolRenderMetadata;
}

/** 工具卡片渲染元数据，不绑定 React 组件。 */
export interface ToolRenderMetadata {
  readonly kind: 'file' | 'diff' | 'bash' | 'search' | 'todo' | 'network' | 'generic';
  readonly target?: string;
  readonly diff?: string;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
  readonly truncated?: boolean;
}

/** 权限审批请求的稳定视图。 */
export interface ApprovalRequestView {
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input?: unknown;
  readonly reason: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly createdAt: string;
}

/** 产品层审批决策。 */
export type ApprovalDecision =
  | { readonly action: 'approve_once'; readonly reason?: string }
  | { readonly action: 'always_allow'; readonly scope?: 'session' | 'project' | 'user'; readonly reason?: string }
  | { readonly action: 'deny'; readonly reason?: string };

/** 队列中的用户输入摘要。 */
export interface QueuedInput {
  readonly id: string;
  readonly prompt: string;
  readonly createdAt: string;
}

/** compact 的触发原因。 */
export type CompactReason = 'manual' | 'context-overflow' | 'session-branch';

/** compact 结果摘要。 */
export interface CompactSummary {
  readonly id: string;
  readonly boundaryEntryId?: string;
  readonly summary: string;
}

/** usage 的 UI 友好表示。 */
export interface UsageView extends AgentUsage {
  readonly contextPressure?: number;
  readonly costUsd?: number;
}

/** run 完成结果。 */
export interface RunResultView {
  readonly runId: string;
  readonly success: boolean;
  readonly output: string;
  readonly finishReason: string;
  readonly usage: UsageView;
}

/** 错误的可序列化表示。 */
export interface ErrorView {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
}

/** coding-agent 对 CLI、TUI、RPC 和 session repository 暴露的稳定事件。 */
export type CodingAgentEvent =
  | { type: 'session.started'; sessionId: string; session: SessionInfo; createdAt: string }
  | { type: 'run.started'; sessionId: string; runId: string; input: { prompt: string; source: string }; createdAt: string }
  | { type: 'turn.started'; sessionId: string; runId: string; turnIndex: number; createdAt: string }
  | { type: 'message.delta'; sessionId: string; runId: string; messageId: string; text: string; createdAt: string }
  | { type: 'tool.started'; sessionId: string; runId: string; call: ToolCallView; createdAt: string }
  | { type: 'tool.updated'; sessionId: string; runId: string; call: ToolCallView; createdAt: string }
  | { type: 'tool.completed'; sessionId: string; runId: string; call: ToolCallView; createdAt: string }
  | { type: 'approval.requested'; sessionId: string; runId: string; request: ApprovalRequestView; createdAt: string }
  | { type: 'approval.resolved'; sessionId: string; runId: string; requestId: string; decision: ApprovalDecision; createdAt: string }
  | { type: 'queue.updated'; sessionId: string; steering: QueuedInput[]; followUp: QueuedInput[]; createdAt: string }
  | { type: 'compaction.started'; sessionId: string; reason: CompactReason; createdAt: string }
  | { type: 'compaction.completed'; sessionId: string; summary: CompactSummary; createdAt: string }
  | { type: 'usage.updated'; sessionId: string; usage: UsageView; createdAt: string }
  | { type: 'run.completed'; sessionId: string; result: RunResultView; createdAt: string }
  | { type: 'run.failed'; sessionId: string; runId?: string; error: ErrorView; createdAt: string }
  | { type: 'runtime.diagnostic'; sessionId: string; level: 'info' | 'warn' | 'error'; message: string; createdAt: string };

/**
 * 将 core 事件转换成产品事件。
 *
 * 这里是唯一允许理解 AgentStreamEvent 细节的位置，TUI 和 JSONL 输出不直接
 * 依赖 core event，从而避免 UI 跟 framework 内部生命周期再次耦合。
 */
export function mapCoreEvent(input: {
  readonly event: AgentStreamEvent;
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCalls: Map<string, ToolCallView>;
}): CodingAgentEvent[] {
  const createdAt = new Date().toISOString();
  const { event, sessionId, runId, toolCalls } = input;
  if (event.type === 'turn.started') {
    return [{ type: 'turn.started', sessionId, runId, turnIndex: event.turnIndex, createdAt }];
  }
  if (event.type === 'message.delta') {
    return [{ type: 'message.delta', sessionId, runId, messageId: event.messageId, text: event.text, createdAt }];
  }
  if (event.type === 'tool.started') {
    const call = upsertTool(toolCalls, event.toolCallId, {
      name: event.name,
      status: 'running',
      input: event.input,
      summary: summarizeTool(event.name, event.input),
      startedAt: createdAt,
      argsPreview: previewValue(event.input, 400),
      render: renderStarted(event.name, event.input),
    });
    return [{ type: 'tool.started', sessionId, runId, call, createdAt }];
  }
  if (event.type === 'tool.completed') {
    const previous = toolCalls.get(event.toolCallId);
    const durationMs = previous?.startedAt === undefined ? undefined : Date.now() - Date.parse(previous.startedAt);
    const call = upsertTool(toolCalls, event.toolCallId, {
      name: previous?.name ?? event.toolCallId,
      status: 'success',
      output: event.output,
      summary: previous?.summary ?? summarizeTool(event.toolCallId, undefined),
      completedAt: createdAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
      preview: previewValue(event.output, 800),
      outputPreview: previewValue(event.output, 800),
      render: renderCompleted(previous?.name ?? event.toolCallId, previous?.input, event.output),
    });
    return [{ type: 'tool.completed', sessionId, runId, call, createdAt }];
  }
  if (event.type === 'tool.failed') {
    const previous = toolCalls.get(event.toolCallId);
    const durationMs = previous?.startedAt === undefined ? undefined : Date.now() - Date.parse(previous.startedAt);
    const call = upsertTool(toolCalls, event.toolCallId, {
      name: previous?.name ?? event.toolCallId,
      status: 'error',
      error: event.error.message,
      summary: previous?.summary ?? summarizeTool(event.toolCallId, undefined),
      completedAt: createdAt,
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
    return [{ type: 'tool.completed', sessionId, runId, call, createdAt }];
  }
  if (event.type === 'approval.required') {
    const request: ApprovalRequestView = {
      id: event.item.toolCallId,
      toolCallId: event.item.toolCallId,
      toolName: event.item.toolName,
      input: event.item.input,
      reason: event.item.reason ?? `Tool ${event.item.toolName} requires approval.`,
      risk: inferRisk(event.item.toolName, event.item.input),
      createdAt,
    };
    return [{ type: 'approval.requested', sessionId, runId, request, createdAt }];
  }
  if (event.type === 'run.completed') {
    return [
      {
        type: 'usage.updated',
        sessionId,
        usage: event.result.usage,
        createdAt,
      },
      {
        type: 'run.completed',
        sessionId,
        result: {
          runId: event.result.id,
          success: event.result.finishReason !== 'error',
          output: event.result.output,
          finishReason: event.result.finishReason,
          usage: event.result.usage,
        },
        createdAt,
      },
    ];
  }
  if (event.type === 'run.failed') {
    return [{ type: 'run.failed', sessionId, runId, error: event.error, createdAt }];
  }
  return [];
}

function upsertTool(
  toolCalls: Map<string, ToolCallView>,
  id: string,
  patch: Omit<Partial<ToolCallView>, 'id'> & Pick<ToolCallView, 'name' | 'status' | 'summary'>,
): ToolCallView {
  const next: ToolCallView = { id, ...toolCalls.get(id), ...patch };
  toolCalls.set(id, next);
  return next;
}

function summarizeTool(name: string, input: unknown): string {
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    const target = record.path ?? record.pattern ?? record.command ?? record.query;
    return target === undefined ? name : `${name} ${String(target)}`;
  }
  return name;
}

function previewValue(value: unknown, max = 800): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return text.length > max ? `${text.slice(0, max)}\n... truncated ...` : text;
}

function inferRisk(toolName: string, input: unknown): ApprovalRequestView['risk'] {
  if (toolName === 'bash') {
    const command = typeof input === 'object' && input !== null ? String((input as { command?: unknown }).command ?? '') : '';
    return /\brm\b|\bsudo\b|\bchmod\b|\bchown\b|>|curl|wget/.test(command) ? 'high' : 'medium';
  }
  if (toolName === 'write' || toolName === 'edit' || toolName === 'web_fetch' || toolName === 'web_search') {
    return 'medium';
  }
  return 'low';
}

function renderStarted(toolName: string, input: unknown): ToolRenderMetadata {
  const record = asRecord(input);
  if (toolName === 'bash') {
    return withTarget({ kind: 'bash' }, stringField(record, 'command'));
  }
  if (toolName === 'edit' || toolName === 'write') {
    return withTarget({ kind: 'diff' }, stringField(record, 'path'));
  }
  if (toolName === 'read' || toolName === 'ls' || toolName === 'glob' || toolName === 'grep') {
    return withTarget({ kind: 'search' }, stringField(record, 'path') ?? stringField(record, 'pattern'));
  }
  if (toolName === 'todo') {
    return { kind: 'todo' };
  }
  if (toolName === 'web_fetch' || toolName === 'web_search') {
    return withTarget({ kind: 'network' }, stringField(record, 'url') ?? stringField(record, 'query'));
  }
  return { kind: 'generic' };
}

function renderCompleted(toolName: string, input: unknown, output: unknown): ToolRenderMetadata {
  const started = renderStarted(toolName, input);
  const record = asRecord(output);
  if (toolName === 'bash') {
    return {
      ...started,
      kind: 'bash',
      stdout: stringField(record, 'stdout') ?? '',
      stderr: stringField(record, 'stderr') ?? '',
      ...optionalNumber('exitCode', numberField(record, 'exitCode')),
      truncated: includesTruncation(record.stdout) || includesTruncation(record.stderr),
    };
  }
  if (toolName === 'edit' || toolName === 'write') {
    return {
      ...started,
      kind: 'diff',
      diff: stringField(record, 'diff') ?? '',
      truncated: includesTruncation(record.diff),
    };
  }
  return {
    ...started,
    truncated: includesTruncation(output),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function withTarget(base: ToolRenderMetadata, target: string | undefined): ToolRenderMetadata {
  return target === undefined ? base : { ...base, target };
}

function optionalNumber(key: 'exitCode', value: number | undefined): Partial<Pick<ToolRenderMetadata, 'exitCode'>> {
  return value === undefined ? {} : { [key]: value };
}

function includesTruncation(value: unknown): boolean {
  return typeof value === 'string' && value.includes('... truncated ...');
}
