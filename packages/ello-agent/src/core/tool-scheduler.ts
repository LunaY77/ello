import { normalizeAgentError } from '../public/errors.js';
import type {
  AgentEnvironment,
  AgentMessage,
  AgentToolCall,
  AgentToolContext,
  AnyAgentTool,
} from '../public/types.js';

export interface ToolSchedulerOptions {
  readonly runId: string;
  readonly tools: readonly AnyAgentTool[];
  readonly environment: AgentEnvironment;
  readonly metadata: Record<string, unknown>;
}

export interface ToolSchedulerEventSink {
  onToolStarted(toolCallId: string, name: string, input: unknown): Promise<void>;
  onApprovalRequired(item: {
    readonly kind: 'approval';
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input?: unknown;
    readonly reason?: string;
  }): Promise<void>;
  onToolCompleted(toolCallId: string, output: unknown): Promise<void>;
  onToolFailed(toolCallId: string, error: Error): Promise<void>;
}

export interface ToolScheduleResult {
  readonly messages: AgentMessage[];
  readonly toolCalls: AgentToolCall[];
  readonly pending: Array<{
    readonly kind: 'approval';
    readonly toolCallId: string;
    readonly toolName: string;
    readonly input?: unknown;
    readonly reason?: string;
  }>;
}

/**
 * core 工具调度器。
 *
 * 模型 adapter 只负责返回标准 toolCalls；scheduler 负责审批、执行、结果
 * 归一化和 tool-result message 构造。
 */
export class ToolScheduler {
  private readonly byName: Map<string, AnyAgentTool>;

  constructor(private readonly options: ToolSchedulerOptions) {
    this.byName = new Map(options.tools.map((tool) => [tool.name, tool]));
  }

  /** 执行一批模型返回的 tool call。 */
  async schedule(
    calls: readonly AgentToolCall[],
    sink: ToolSchedulerEventSink,
  ): Promise<ToolScheduleResult> {
    const messages: AgentMessage[] = [];
    const toolCalls: AgentToolCall[] = [];
    const pending: ToolScheduleResult['pending'] = [];
    for (const call of calls) {
      const tool = this.byName.get(call.name);
      if (tool === undefined) {
        const error = new Error(`Unknown tool: ${call.name}`);
        await sink.onToolStarted(call.id, call.name, call.input);
        await sink.onToolFailed(call.id, error);
        toolCalls.push({ ...call, error: normalizeAgentError(error) });
        messages.push(createToolResultMessage(call, { error: error.message }, 'error'));
        continue;
      }
      const ctx = this.createContext();
      const decision = await tool.approval?.(call.input, ctx);
      if (decision === 'denied') {
        const error = new Error(`Tool '${call.name}' was denied by approval policy.`);
        await sink.onToolStarted(call.id, call.name, call.input);
        await sink.onToolFailed(call.id, error);
        toolCalls.push({ ...call, error: normalizeAgentError(error) });
        messages.push(createToolResultMessage(call, { denied: true, reason: error.message }, 'denied'));
        continue;
      }
      if (decision === 'required') {
        const item = {
          kind: 'approval' as const,
          toolCallId: call.id,
          toolName: call.name,
          input: call.input,
          reason: `Tool '${call.name}' requires approval.`,
        };
        pending.push(item);
        await sink.onApprovalRequired(item);
        continue;
      }
      await sink.onToolStarted(call.id, call.name, call.input);
      try {
        const output = await tool.execute(call.input, ctx);
        await sink.onToolCompleted(call.id, output);
        toolCalls.push({ ...call, output });
        messages.push(createToolResultMessage(call, output));
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        await sink.onToolFailed(call.id, normalized);
        toolCalls.push({ ...call, error: normalizeAgentError(normalized) });
        messages.push(createToolResultMessage(call, { error: normalized.message }, 'error'));
      }
    }
    return { messages, toolCalls, pending };
  }

  /**
   * 执行已经被产品层批准的 deferred tool call。
   *
   * approval resume 走这里会跳过 approval preflight，但仍保留 started /
   * completed / failed 事件，保证批准后的工具执行仍归属 core scheduler。
   */
  async executeApproved(
    call: AgentToolCall,
    sink: ToolSchedulerEventSink,
  ): Promise<AgentToolCall> {
    const tool = this.byName.get(call.name);
    if (tool === undefined) {
      const error = new Error(`Unknown tool: ${call.name}`);
      await sink.onToolFailed(call.id, error);
      return { ...call, error: normalizeAgentError(error) };
    }
    await sink.onToolStarted(call.id, call.name, call.input);
    try {
      const output = await tool.execute(call.input, this.createContext());
      await sink.onToolCompleted(call.id, output);
      return { ...call, output };
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      await sink.onToolFailed(call.id, normalized);
      return { ...call, error: normalizeAgentError(normalized) };
    }
  }

  /** 构造工具执行上下文。 */
  private createContext(): AgentToolContext {
    return {
      runId: this.options.runId,
      environment: this.options.environment,
      metadata: this.options.metadata,
    };
  }
}

function createToolResultMessage(
  call: AgentToolCall,
  output: unknown,
  status: 'success' | 'error' | 'denied' = 'success',
): AgentMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: call.id,
        toolName: call.name,
        output: createAiSdkToolOutput(output, status),
      },
    ],
  } as unknown as AgentMessage;
}

function createAiSdkToolOutput(
  output: unknown,
  status: 'success' | 'error' | 'denied',
): unknown {
  if (status === 'denied') {
    return {
      type: 'execution-denied',
      reason: readReason(output) ?? 'Tool execution denied.',
    };
  }
  if (status === 'error') {
    return {
      type: 'error-text',
      value: readReason(output) ?? String(output),
    };
  }
  if (typeof output === 'string') {
    return { type: 'text', value: output };
  }
  return { type: 'json', value: toJsonValue(output) };
}

function readReason(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null) {
    const reason = (value as Record<string, unknown>).reason ?? (value as Record<string, unknown>).error;
    return typeof reason === 'string' ? reason : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as unknown;
}
