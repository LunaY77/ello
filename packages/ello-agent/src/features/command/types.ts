/**
 * Command Run 深模块的公开契约。
 *
 * 模型只接触一个 `command_run` Tool；内部 Command 的编译、调度、审批、暂停和
 * 结果归一化全部隐藏在 {@link CommandRunRuntime} 后面。
 */
import type { z } from 'zod';

import type { EnvironmentHandle } from '../environment/index.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface CommandFrame {
  readonly step: number;
  readonly command: string;
  readonly args?: readonly string[];
  readonly body?: string;
  readonly input?: Readonly<Record<string, JsonValue>>;
  readonly onFailure?: 'stop' | 'diagnose' | 'continue';
}

export interface CommandRunInput {
  readonly commands: readonly CommandFrame[];
}

export interface CommandCapabilities {
  readonly logicalName: string;
  /**
   * Command 是否需要 Environment 执行 gate。
   *
   * 只读写 Ello 自身持久状态、不触碰 Environment 文件系统或进程的协调类 Command 声明
   * `false`，其执行不占用 gate，因此不会与同一 Environment 内其他 Agent 的工作互相阻塞。
   * 可能长时间阻塞的屏障类 Command 必须声明 `false`，否则会饿死并行 Subagent。
   */
  readonly usesEnvironment: boolean;
  readonly concurrencySafe: boolean;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly interruptible: boolean;
  readonly enabled: boolean;
  readonly telemetryTag: string;
}

export type CommandApprovalDecision =
  | 'auto'
  | 'required'
  | 'denied'
  | {
      readonly action: 'auto' | 'required' | 'denied';
      readonly reason?: string;
      readonly metadata?: Record<string, unknown>;
    };

export interface CommandContext {
  readonly runId: string;
  readonly turnIndex: number;
  readonly commandId: string;
  readonly environment: EnvironmentHandle;
  readonly metadata: Record<string, unknown>;
  readonly signal: AbortSignal;
  readonly invocation?: CommandCapabilities & { readonly physicalName: string };
}

export interface CommandRunContext {
  readonly runId: string;
  readonly turnIndex: number;
  readonly environment: EnvironmentHandle;
  readonly metadata: Record<string, unknown>;
  readonly signal: AbortSignal;
}

export type CommandStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'denied'
  | 'blocked'
  | 'deferred'
  | 'interrupted';

export interface CommandRecord {
  readonly commandRunId: string;
  readonly commandId: string;
  readonly index: number;
  readonly step: number;
  readonly name: string;
  readonly input: unknown;
  readonly inputDigest: string;
  readonly status: CommandStatus;
  readonly output?: unknown;
  readonly error?: string;
  readonly blockedBy?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly metadata?: Record<string, unknown>;
  readonly approval?: {
    readonly status: 'approved' | 'denied';
    readonly reason?: string;
  };
}

export interface CompiledCommandFrame {
  readonly index: number;
  readonly step: number;
  readonly command: string;
  readonly input: unknown;
  readonly inputDigest: string;
  readonly commandId: string;
  readonly onFailure: 'stop' | 'diagnose' | 'continue';
}

export interface CommandApprovalRecord {
  readonly commandId: string;
  readonly command: string;
  readonly inputDigest: string;
  readonly catalogRevision: string;
  readonly decision: 'approved' | 'denied';
  readonly reason?: string;
}

export interface CommandRunBarrier {
  readonly step: number;
  readonly commandId: string;
  readonly commandName: string;
  readonly status: 'failed' | 'denied';
}

export interface CommandRunCheckpoint {
  readonly schema: 1;
  readonly commandRunId: string;
  readonly providerToolCallId: string;
  readonly inputDigest: string;
  readonly catalogRevision: string;
  readonly compiledFrames: readonly CompiledCommandFrame[];
  readonly results: readonly CommandRecord[];
  readonly phaseCursor: number;
  readonly barrier?: CommandRunBarrier;
  readonly approvals: readonly CommandApprovalRecord[];
  readonly pendingCommandIds: readonly string[];
  readonly pendingKind: 'approval' | 'deferred';
}

export interface PendingCommandInteraction {
  readonly kind: 'approval' | 'deferred';
  readonly commandId: string;
  readonly commandName: string;
  readonly input: unknown;
  readonly reason?: string;
  readonly metadata?: Record<string, unknown>;
}

export type CommandRunEvent =
  | {
      readonly type: 'command_run.started';
      readonly commandRunId: string;
      readonly providerToolCallId: string;
      readonly commands: readonly CompiledCommandFrame[];
      readonly occurredAt: string;
    }
  | {
      readonly type: 'command_run.failed';
      readonly commandRunId: string;
      readonly providerToolCallId: string;
      readonly error: CommandRunResult['error'];
      readonly occurredAt: string;
    }
  | {
      readonly type: 'command.started';
      readonly record: CommandRecord;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'command.completed';
      readonly record: CommandRecord;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'command.failed';
      readonly record: CommandRecord;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'command.denied';
      readonly record: CommandRecord;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'command.blocked';
      readonly record: CommandRecord;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'command.approval_required';
      readonly interaction: PendingCommandInteraction;
      readonly checkpoint: CommandRunCheckpoint;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'command.deferred';
      readonly interaction: PendingCommandInteraction;
      readonly checkpoint: CommandRunCheckpoint;
      readonly occurredAt: string;
    }
  | {
      readonly type: 'command_run.completed' | 'command_run.suspended';
      readonly commandRunId: string;
      readonly occurredAt: string;
    };

export interface ModelCommandRunResult {
  readonly commandRunId: string;
  readonly status: 'completed' | 'failed' | 'denied' | 'interrupted';
  /** Provider-visible projection; durable CommandRecord fields never cross this seam. */
  readonly commands: readonly ModelCommandRecord[];
  readonly error?: {
    readonly frameIndex?: number;
    readonly command?: string;
    readonly message: string;
    readonly usage?: string;
  };
}

/** Runtime-owned rich result; project this before sending it to the provider. */
export interface CommandRunResult {
  readonly commandRunId: string;
  readonly status: 'completed' | 'failed' | 'denied' | 'interrupted';
  readonly commands: readonly CommandRecord[];
  readonly error?: {
    readonly frameIndex?: number;
    readonly command?: string;
    readonly message: string;
    readonly usage?: string;
  };
}

export interface ModelCommandRecord {
  readonly commandId: string;
  readonly index: number;
  readonly step: number;
  readonly name: string;
  readonly status: CommandStatus;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly blockedBy?: string;
  readonly approval?: CommandRecord['approval'];
}

export type CommandRunTransition =
  | {
      readonly type: 'completed';
      /** Rich runtime result for adapters, Thread and diagnostics. */
      readonly result: CommandRunResult;
      /** Bounded provider observation derived inside the Command Module. */
      readonly observation: ModelCommandRunResult;
    }
  | {
      readonly type: 'suspended';
      readonly checkpoint: CommandRunCheckpoint;
      readonly interactions: readonly PendingCommandInteraction[];
    };

export interface CommandRunExecution extends AsyncIterable<CommandRunEvent> {
  readonly result: Promise<CommandRunTransition>;
}

export interface StartCommandRun {
  readonly providerToolCallId: string;
  readonly input: unknown;
  readonly context: CommandRunContext;
}

export interface ResumeCommandRun {
  readonly checkpoint: CommandRunCheckpoint;
  readonly approvals?: Readonly<
    Record<
      string,
      boolean | { readonly approved: boolean; readonly reason?: string }
    >
  >;
  readonly toolResults?: Readonly<Record<string, unknown>>;
  readonly context: CommandRunContext;
}

export interface CommandRunModelTool {
  readonly name: 'command_run';
  readonly description: string;
  readonly input: z.ZodType<CommandRunInput>;
}

/** Agent engine 使用的唯一执行 seam。 */
export interface CommandRunRuntime {
  readonly modelTool: CommandRunModelTool;
  readonly catalogRevision: string;
  /** 编译并启动一个新的 outer Command Run。 */
  start(request: StartCommandRun): CommandRunExecution;
  /** 从持久 checkpoint 恢复尚未完成的 Command Run。 */
  resume(request: ResumeCommandRun): CommandRunExecution;
}
